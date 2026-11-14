import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const admin=fs.readFileSync(new URL("../public/admin.html",import.meta.url),"utf8");
const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");

test("Admin activation has no active-profile count tile or customer dropdown",()=>{
 assert.ok(!admin.includes('id="activatedProfileCount"'));
 const start=admin.indexOf("adminVisibleActivationGroups = customers;");
 const end=admin.indexOf("bindProfileActivationButtons();",start);
 assert.ok(start>=0&&end>start);
 const render=admin.slice(start,end);
 assert.ok(render.includes('class="activation-group activation-customer-row"'));
 assert.ok(render.includes('data-activation-customer-action='));
 assert.ok(render.includes('data-activation-customer-index='));
 assert.ok(render.includes('data-admin-extend-membership='));
 assert.ok(render.includes('group.customerAccountId'));
 assert.ok(server.includes('customerAccountId: String(customerAccountId || "")'));
 assert.ok(render.includes('"Deactivate":"Set Active"'));
 assert.ok(!render.includes("<details"));
 assert.ok(!render.includes('group.profiles.length'));
});

test("Customer activation groups stay scoped and use the correct managed endpoints",()=>{
 const start=admin.indexOf("async function submitProfileActivation(");
 const end=admin.indexOf("refreshProfileActivationTracker",start);
 const code=admin.slice(start,end);
 assert.ok(code.includes('profile.managedActivation===true'));
 assert.ok(code.includes('["activated","awaiting_activation","deactivated","inactive"]'));
 assert.ok(code.includes('group.profiles.filter'));
 assert.ok(code.includes('await submitProfileActivation(profile,action)'));
 assert.ok(code.includes('adminLastActivationFingerprint=null'));
 const tracker=server.slice(server.indexOf('"/api/admin/profile-activation-tracker"'));
 assert.ok(tracker.includes('autoPaidPoolAssignment'));
 assert.ok(tracker.includes('managedActivation: true'));
});


test("paid managed-pool assignments retain source type so Activate uses the managed endpoint",async()=>{
 const begin=server.indexOf('"/api/admin/profile-activation-tracker"');
 const addStart=server.indexOf("const addProfile = (",begin);
 const addEnd=server.indexOf("let paidProfilesChanged",addStart);
 assert.ok(begin>=0&&addStart>begin&&addEnd>addStart);
 const groups=new Map();
 const addProfile=vm.runInNewContext(
   server.slice(addStart,addEnd)+"\naddProfile",
   {accounts:[{id:"member-1",email:"test@example.com"}],groups,
    profileActivationLabel:value=>value});
 addProfile({id:"managed-paid",customerAccountId:"member-1",
   type:"paid",managedActivation:true,managedType:"rented",
   status:"awaiting_activation",profileName:"Target Account"});
 addProfile({id:"managed-gifted",customerAccountId:"member-1",
   type:"gifted",managedActivation:true,managedType:"free",
   status:"deactivated",profileName:"Gifted Profile"});
 addProfile({id:"direct-paid",customerAccountId:"member-1",
   type:"paid",status:"activated",profileName:"Customer Profile"});
 const rows=[...groups.values()][0].profiles;
 assert.equal(rows.length,3);
 assert.equal(rows[0].managedActivation,true);
 assert.equal(rows[0].managedType,"rented");
 assert.equal(rows[0].type,"paid");
 assert.equal(rows[1].managedType,"free");
 assert.equal(rows[2].managedActivation,false);
 assert.equal(rows[2].managedType,null);

 const start=admin.indexOf("async function submitProfileActivation(");
 const end=admin.indexOf("function bindProfileActivationButtons()",start);
 assert.ok(start>0&&end>start);
 const requests=[];
 const submitProfileActivation=vm.runInNewContext(
   admin.slice(start,end)+"\nsubmitProfileActivation",
   {fetch:async(url,opts)=>{
      requests.push({url,action:JSON.parse(opts.body).action});
      return {ok:true,json:async()=>({ok:true})};
    },encodeURIComponent});
 await submitProfileActivation(rows[0],"activate");
 await submitProfileActivation(rows[1],"deactivate");
 await submitProfileActivation(rows[2],"deactivate");
 assert.deepEqual(requests,[
   {url:"/api/admin/managed-profile-activation/rented/managed-paid",action:"activate"},
   {url:"/api/admin/managed-profile-activation/free/managed-gifted",action:"deactivate"},
   {url:"/api/admin/profile-activation/direct-paid",action:"deactivate"}
 ]);
});
