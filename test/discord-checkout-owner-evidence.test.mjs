import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { managedAccountEmailEvidence, checkoutAssignmentContains } from "../discord-checkout-owner-evidence.js";
import { uniqueCheckoutOwner } from "../webhook-success.js";

test("exact Admin saved Account Email is eligible only for its single managed retailer", () => {
  const account = { accountEmail:" target-account@example.com ", profileName:"Customer A's managed Target" };
  const credentials = { target:{username:"different-login@example.com"},walmart:{username:""} };
  const assignment = { customerAccountId:"member-a",assignmentRetailer:"target" };
  assert.deepEqual(managedAccountEmailEvidence(account,credentials,assignment),
    {email:"target-account@example.com",retailer:"Target"});
});

test("legacy PKC account email can be matched when an historical assignment explicitly identifies PKC", () => {
  const evidence = managedAccountEmailEvidence(
    {accountEmail:"pkc-login@example.com"}, {},
    {customerAccountId:"member-a",rentalRetailer:"pokemoncenter"});
  assert.deepEqual(evidence,{email:"pkc-login@example.com",retailer:"PKC"});
});

test("a retailer-specific legacy pool can use its saved canonical email without borrowing another retailer's credentials", () => {
  const account={retailer:'pokemoncenter',displayEmail:'nicholas_dixon663@web.de'};
  const credentials={target:{username:'nicholas_dixon663@web.de'}};
  assert.deepEqual(managedAccountEmailEvidence(account,credentials,{assignmentRetailer:'pokemoncenter'}),
    {email:'nicholas_dixon663@web.de',retailer:'PKC'});
  assert.equal(managedAccountEmailEvidence(account,credentials,{assignmentRetailer:'target'}),null);
  assert.deepEqual(managedAccountEmailEvidence({...account,retailer:''},credentials,{assignmentRetailer:'pokemoncenter'}),
    {email:'nicholas_dixon663@web.de',retailer:'PKC'});
});

test("never guess the retailer, owner or credentials from unrelated account fields", () => {
  const account={accountEmail:"managed@example.com",profileName:"PKC member"};
  assert.equal(managedAccountEmailEvidence(account,{},{}),null);
  assert.equal(managedAccountEmailEvidence(
    account,{target:{username:"a@example.com"},walmart:{username:"b@example.com"}},{}),null);
  assert.equal(managedAccountEmailEvidence(
    account,{target:{username:"a@example.com"}},{assignmentRetailer:"walmart"}),null);
  assert.equal(managedAccountEmailEvidence({accountEmail:"customer:password"},{target:{username:"x"}},{}),null);
  assert.equal(managedAccountEmailEvidence({accountEmail:"not-an-email"},{target:{username:"x"}},{}),null);
  assert.equal(managedAccountEmailEvidence(
    {accountEmail:"a@example.com"},{target:{username:"a@example.com"}},{}),null);
  assert.equal(uniqueCheckoutOwner([
    {customerAccountId:"member-a",email:"shared@example.com"},
    {customerAccountId:"member-b",email:"shared@example.com"}]),null);
});

test("checkout owner candidates use saved managed account logins and respect historical assignments", () => {
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const start=server.indexOf("async function discordCheckoutOwners()");
  const end=server.indexOf("function discordCheckoutCandidateEligible",start);
  const section=server.slice(start,end);
  assert.ok(start>0&&end>start);
  assert.match(section,/managedAccountEmailEvidence\(account, credentials, assignment\)/);
  assert.match(section,/assignment.customerAccountId/);
  assert.match(section,/managedAssignmentId: assignment.id/);
  assert.doesNotMatch(section,/customer\.email/);
});


test("single-login legacy imports follow the exact historical assigned retailer and reject differing login identities",()=>{
  const credentials={target:{username:'same-retailer-login@example.com'}};
  const assignment={customerAccountId:'member-a',assignmentRetailer:'pokemoncenter'};
  assert.deepEqual(managedAccountEmailEvidence({},credentials,assignment),
    {email:'same-retailer-login@example.com',retailer:'PKC'});
  assert.equal(managedAccountEmailEvidence({accountEmail:'other@example.com'},credentials,assignment),null);
  assert.equal(managedAccountEmailEvidence({}, {...credentials,walmart:{username:'different@example.com'}},assignment),null);
  assert.equal(managedAccountEmailEvidence({retailer:'target'},credentials,assignment),null);
});

test("awaiting activation has checkout ownership from its saved link date, not its activation date",()=>{
 const checkout="2026-10-27T18:10:00.000Z";
 const pending={customerAccountId:"sami-example",managedAccountId:"pkc-example",assignmentRetailer:"pokemoncenter",
  activationStatus:"awaiting_activation",createdAt:"2026-10-27T17:00:00.000Z",startsAt:null,expiresAt:null};
 assert.equal(checkoutAssignmentContains(pending,checkout),true);
 assert.equal(checkoutAssignmentContains({...pending,startsAt:"2026-10-27T20:00:00.000Z"},checkout),true,
  "Later activation cannot take away a checkout earned while linked");
 assert.equal(checkoutAssignmentContains({...pending,createdAt:null,activationRequestedAt:"2026-10-27T17:00:00.000Z"},checkout),true,
  "Legacy pending assignment may only have a timestamp for its activation request");
 assert.equal(checkoutAssignmentContains({...pending,createdAt:"2026-10-27T19:00:00.000Z"},checkout),false,
  "Checkout before the assignment was created is not that customer's order");
 assert.equal(checkoutAssignmentContains({...pending,createdAt:null,activationRequestedAt:"2026-10-27T19:00:00.000Z"},checkout),false);
 assert.equal(checkoutAssignmentContains({...pending,endedAt:"2026-10-27T17:45:00.000Z"},checkout),false);
});
