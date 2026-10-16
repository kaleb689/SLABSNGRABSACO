import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  ownerVerifiedScreenshotRef,
  resolveOwnerVerifiedScreenshots,
  verifiedScreenshotMatchStatus
} from "../checkout-owner-screenshot-evidence.js";

const sha = v => createHash("sha256").update(String(v).toLowerCase()).digest("hex");
const checkoutAt = "2026-10-15T17:13:00.000Z"; // 1:13 PM Eastern
const login = "owner-001@example.test";
const profileLabel = "Example Account 4";
const snapshot = Object.freeze([{
  ref:"synthetic-admin-approved-pkc-checkout",retailer:"PKC",day:"2026-10-15",
  loginHash:sha(login),profileHash:sha(profileLabel),
  firstNameHash:sha("Sample")
}]);
const items = ["Mew","Pikachu","Espeon","Lapras"].map(name=>({
  name:"Pokemon TCG: 30th Celebration Mini Tin - "+name+" (Day)",
  price:9.99,quantity:1
}));
const order = {
  id:"discord:1532179373292257290:1580000000000000101",
  retailer:"PKC",orderNumber:"SYNTHETIC202610150011",
  status:"confirmed",checkoutAt,items
};
const identity = {email:login,profileName:profileLabel};
const accounts = [{id:"member-a",firstName:"Sample"},{id:"member-b",firstName:"Other"}];

test("a single owner-verified Discord success updates only its unique customer",()=>{
  assert.equal(ownerVerifiedScreenshotRef(order,identity,snapshot),snapshot[0].ref);
  const match = resolveOwnerVerifiedScreenshots(order,identity,accounts,[],snapshot);
  assert.equal(match?.customerAccountId,"member-a");
  assert.equal(match?.ownerBackfillApproval,snapshot[0].ref);
  assert.equal(match?.attributionSource,"admin-confirmed-2026-10-15-checkout-evidence");
  assert.ok(!JSON.stringify(match).includes(login));
  assert.ok(!JSON.stringify(match).includes(profileLabel));
});

test("a competing eligible customer or ambiguous name blocks assignment",()=>{
  const another=[...accounts,{id:"member-c",firstName:"Sample"}];
  assert.equal(resolveOwnerVerifiedScreenshots(order,identity,another,[],snapshot),null);
  const conflicting=[{retailer:"PKC",email:login,customerAccountId:"member-b"}];
  assert.equal(resolveOwnerVerifiedScreenshots(order,identity,accounts,conflicting,snapshot),null);
  const disabled=[{id:"member-a",firstName:"Sample",disabled:true}];
  assert.equal(resolveOwnerVerifiedScreenshots(order,identity,disabled,[],snapshot),null);
});

test("screenshot recovery is limited by exact retailer, login, profile, date, status, and product set",()=>{
  const invalid=[
    [{...order,retailer:"Target"},identity],
    [order,{...identity,email:"unknown@example.test"}],
    [order,{...identity,profileName:"Different profile"}],
    [{...order,checkoutAt:"2026-10-16T17:13:00Z"},identity],
    [{...order,status:"cancelled"},identity],
    [{...order,items:[items[0]]},identity],
    [{...order,items:items.map((item,i)=>i===0?{...item,name:"Different product"}:item)},identity],
    [{...order,id:"IMAP-UNTRUSTED"},identity]
  ];
  for(const [o,ident] of invalid)
    assert.equal(resolveOwnerVerifiedScreenshots(o,ident,accounts,[],snapshot),null);
});

test("an original, uniquely identified Discord success is valid even without retailer order number",()=>{
  const numberless={...order,orderNumber:""};
  assert.equal(ownerVerifiedScreenshotRef(numberless,identity,snapshot),snapshot[0].ref);
  assert.equal(resolveOwnerVerifiedScreenshots(numberless,identity,accounts,[],snapshot)?.customerAccountId,"member-a");
  assert.equal(verifiedScreenshotMatchStatus(numberless,identity,accounts,[],snapshot),"eligible");
  assert.equal(verifiedScreenshotMatchStatus(numberless,identity,[...accounts,{id:"another",firstName:"Sample"}],[],snapshot),"owner_ambiguous");
  assert.equal(verifiedScreenshotMatchStatus({...numberless,items:[]},identity,accounts,[],snapshot),"source_not_exact");
  assert.equal(verifiedScreenshotMatchStatus(numberless,identity,accounts,[{retailer:"PKC",email:login,customerAccountId:"other"}],snapshot),"conflicting_account_history");
});

test("real website signup records resolve membership holder names from adminProfile and paid profile",()=>{
  const adminRecord={id:"member-a",email:"customer@example.test",adminProfile:{firstName:"Sample"}};
  const noAdminRecord={id:"member-a",email:"customer@example.test",paidProfileFirstName:"Sample"};
  assert.equal(resolveOwnerVerifiedScreenshots(order,identity,[adminRecord],[],snapshot)?.customerAccountId,"member-a");
  assert.equal(resolveOwnerVerifiedScreenshots(order,identity,[noAdminRecord],[],snapshot)?.customerAccountId,"member-a");
  assert.equal(verifiedScreenshotMatchStatus(order,identity,[{id:"member-a",email:"customer@example.test"}],[],snapshot),"owner_missing");
  assert.equal(verifiedScreenshotMatchStatus(order,identity,[adminRecord,{id:"other",adminProfile:{firstName:"Sample"}}],[],snapshot),"owner_ambiguous");
});

test("matching a saved, uniquely assigned retailer login retains its managed profile evidence",()=>{
  const candidates=[{customerAccountId:"member-a",retailer:"PKC",email:login,
    managedAccountId:"pkc-1",managedAssignmentId:"link-1",profileSlot:4}];
  const matched=resolveOwnerVerifiedScreenshots(order,identity,accounts,candidates,snapshot);
  assert.equal(matched.managedAccountId,"pkc-1");
  assert.equal(matched.managedAssignmentId,"link-1");
  assert.equal(matched.profileSlot,4);
});

test("scan invokes the narrow recovery only after ordinary exact-link attribution",()=>{
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  assert.match(server,/regularAttribution = discordCheckoutAttribution\(order, identity, candidates, approvedAliases\)/);
  assert.match(server,/const screenshotAttribution = screenshotStatus === "eligible" \?/);
  assert.match(server,/const attribution = regularAttribution \|\| screenshotAttribution;/);
  assert.match(server,/changedCustomerIds\.add\(String\(result\.record\.customerAccountId\)\)/);
  assert.match(server,/console\.log\("Verified screenshot checkout states:"/);
  assert.match(server,/linkedToVerifiedOwner:Boolean\(owner && owner === String\(proof\.screenshotOwner/);

  assert.match(server,/for \(const accountId of changedCustomerIds\) announceSuccessCheckout\(accountId\)/);
  assert.doesNotMatch(server,/for \(const accountId of new Set\(existing\.map\(record => record\.customerAccountId\)/);
  const app=readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  assert.match(app,/document\.addEventListener\("account-session-changed", updateCustomerSuccessEvents\)/);
  assert.match(app,/customerSuccessEvents\.addEventListener\("checkout", refreshVisibleSuccess\)/);
  assert.match(app,/successState\.loaded = false/);
});
