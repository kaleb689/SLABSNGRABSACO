import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";

const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
const start=server.indexOf("async function provisionPaidMembershipPool(record) {");
const end=server.indexOf("const paidPoolProvisioningScheduler=",start);
assert.ok(start>=0&&end>start,"The real pool provisioning function must exist.");

function harness(count=2){
 const base=[
  {id:"target-matched",retailer:"target",accountEmail:"same@example.test"},
  {id:"target-unmatched",retailer:"target",accountEmail:"target-only@example.test"},
  {id:"target-third",retailer:"target",accountEmail:"other@example.test"},
  {id:"pkc-matched",retailer:"pokemoncenter",accountEmail:"same@example.test"},
  {id:"pkc-other",retailer:"pokemoncenter",accountEmail:"other@example.test"},
  {id:"pkc-third",retailer:"pokemoncenter",accountEmail:"pkc-only@example.test"},
  {id:"walmart",retailer:"walmart",accountEmail:"wm@example.test"}
 ];
 let assignments=[],alerts=0,writes=0;
 const sandbox={
  crypto,console,
  subscriptionAllowsProfiles:r=>r?.subscriptionStatus==='active',
  getCustomerAccounts:async()=>[{id:"customer-1",email:"buyer@example.test"}],
  profileAllowanceForRecord:r=>Number(r?.plan?.profiles)||count,
  getManagedAccounts:async()=>base,
  getFreeAssignments:async()=>assignments.map(x=>({...x})),
  getRentalAssignments:async()=>[],
  managedAssignmentIsLinked:a=>a.active!==false,
  normalizeManagedPoolRetailer:x=>x,
  getAvailableManagedAccountsForRetailer:async r=>base.filter(x=>x.retailer===r&&!assignments.some(a=>a.managedAccountId===x.id)),
  preferManagedAccountsMatchingAssignedPoolEmails:(items,id,r,history,managed)=>{
   const emails=new Set(history.filter(a=>a.customerAccountId===id).map(a=>base.find(x=>x.id===a.managedAccountId)?.accountEmail));
   return [...items].sort((a,b)=>Number(emails.has(b.accountEmail))-Number(emails.has(a.accountEmail)));
  },
  managedRetailerEmailExact:a=>a.accountEmail,
  normalizeEmail:x=>String(x||"").toLowerCase(),
  managedAssignmentMembershipId:a=>a.managedAccountId,
  sanitizeProfile:x=>({...x}),
  prepareNewManagedAssignment:async(a,p)=>{a.customerProfile.email=p.accountEmail;},
  saveFreeAssignments:async next=>{assignments=next.map(x=>({...x}));writes++;},
  ensureManagedProfileDiscordMessage:async()=>{alerts++;},
  broadcastLiveDataChange:()=>{}
 };
 vm.createContext(sandbox);
 vm.runInContext(server.slice(start,end)+"\nthis.runProvision=provisionPaidMembershipPool;this.runReconcile=reconcilePaidPoolAssignmentLimits;",sandbox);
 return {run:()=>sandbox.runProvision({id:"order-1",customerAccountId:"customer-1",subscriptionStatus:"active",autoPoolProvisioningRequestedAt:"2026-10-22T00:00:00Z",plan:{profiles:count}}),
  reconcile:records=>sandbox.runReconcile(records),
  addManual:row=>{assignments.push(row);},
  assignments:()=>assignments,writes:()=>writes,alerts:()=>alerts};
}
test("Paid tiers auto link eligible Target and PKC inventory, prefer shared emails, never Walmart",async()=>{
 const h=harness(2);await h.run();
 const items=h.assignments();
 assert.equal(items.length,4);
 assert.equal(items.filter(x=>x.assignmentRetailer==="target").length,2);
 assert.equal(items.filter(x=>x.assignmentRetailer==="pokemoncenter").length,2);
 assert.equal(items.filter(x=>x.assignmentRetailer==="walmart").length,0);
 assert.ok(items.find(x=>x.managedAccountId==="target-matched"));
 assert.ok(items.find(x=>x.managedAccountId==="pkc-matched"));
 assert.ok(items.every(x=>x.autoPaidPoolAssignment&&x.activationStatus==="awaiting_activation"));
 assert.equal(new Set(items.map(x=>x.managedAccountId)).size,4);
 assert.equal(h.alerts(),4);
});
test("Paid pool provisioning is idempotent across retries and does not exceed requested tier",async()=>{
 const h=harness(2);await h.run();const writes=h.writes();
 await h.run();assert.equal(h.assignments().length,4);assert.equal(h.writes(),writes);
});
test("A pool shortfall does not assign Walmart or invent missing stock",async()=>{
 const h=harness(5);await h.run();
 assert.equal(h.assignments().length,6);
 assert.ok(h.assignments().every(x=>x.assignmentRetailer!=="walmart"));
});

test("Subscription downgrade returns only excess auto-pooled accounts; gifts and history remain",async()=>{
 const h=harness(3);await h.run();
 h.addManual({id:"gift-preserved",customerAccountId:"customer-1",active:true,assignmentRetailer:"target",autoPaidPoolAssignment:false});
 const before=h.assignments();assert.equal(before.length,7);
 await h.reconcile([{customerAccountId:"customer-1",subscriptionStatus:"active",plan:{profiles:1}}]);
 const after=h.assignments();
 assert.equal(after.length,7); // no records deleted
 assert.equal(after.filter(x=>x.autoPaidPoolAssignment&&x.active).length,2);
 assert.equal(after.filter(x=>x.autoPaidPoolAssignment&&!x.active).length,4);
 assert.equal(after.find(x=>x.id==="gift-preserved").active,true);
 assert.ok(after.filter(x=>x.autoPaidPoolAssignment&&!x.active).every(x=>x.endReason==="paid_tier_downgrade"&&x.customerProfile));
});
test("Canceled membership releases pooled accounts without erasing records or manual rentals/gifts",async()=>{
 const h=harness(2);await h.run();
 h.addManual({id:"manual-preserved",customerAccountId:"customer-1",active:true,assignmentRetailer:"target"});
 await h.reconcile([{customerAccountId:"customer-1",subscriptionStatus:"canceled",plan:{profiles:2}}]);
 const records=h.assignments();assert.equal(records.length,5);
 assert.ok(records.filter(x=>x.autoPaidPoolAssignment).every(x=>x.active===false&&x.endReason==="paid_membership_inactive"));
 assert.equal(records.find(x=>x.id==="manual-preserved").active,true);
 const writes=h.writes();
 await h.reconcile([{customerAccountId:"customer-1",subscriptionStatus:"canceled",plan:{profiles:2}}]);
 assert.equal(h.writes(),writes); // idempotent cleanup
});
