import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { managedAccountEmailEvidence } from "../discord-checkout-owner-evidence.js";
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
