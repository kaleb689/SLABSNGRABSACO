import test from "node:test";
import assert from "node:assert/strict";
import { checkoutAliasKey, normalizeCheckoutProfileLabel, resolveApprovedCheckoutAlias } from "../discord-checkout-profile-aliases.js";

const checkout = {retailer:"Target",sourceProfileLabel:"  Mike - Target 1 ",checkoutAt:"2026-10-09T09:00:00Z"};
const valid = candidate => candidate.active === true;

test("reviewed aliases use exact normalized full labels, not fuzzy matches", () => {
  assert.equal(normalizeCheckoutProfileLabel(" Mike - Target 1 "), "mike target 1");
  assert.equal(checkoutAliasKey("Target", "Mike Target 1"), checkoutAliasKey("target", "Mike - Target 1"));
  assert.notEqual(checkoutAliasKey("Target", "Mike Target 1"), checkoutAliasKey("Target", "Mike Target 10"));
  assert.notEqual(checkoutAliasKey("Walmart", "Mike Target 1"), checkoutAliasKey("Target", "Mike Target 1"));
});

test("no assignment is ever inferred without an approved mapping", () => {
  const candidates = [{customerAccountId:"customer-a",profileName:"Mike 1",active:true}];
  assert.equal(resolveApprovedCheckoutAlias(checkout,candidates,[],valid),null);
  assert.equal(resolveApprovedCheckoutAlias(checkout,candidates,[{retailer:"Walmart",profileLabel:checkout.sourceProfileLabel,customerAccountId:"customer-a"}],valid),null);
});

test("approved alias attaches only to the eligible customer", () => {
  const candidates = [
    {customerAccountId:"customer-a",managedAccountId:"a1",managedAssignmentId:"rent1",active:true},
    {customerAccountId:"customer-b",managedAccountId:"b1",active:true}
  ];
  const m = [{retailer:"Target",profileLabel:"Mike Target 1",customerAccountId:"customer-a"}];
  assert.deepEqual(resolveApprovedCheckoutAlias(checkout,candidates,m,valid),{
    customerAccountId:"customer-a",managedAccountId:"a1",managedAssignmentId:"rent1"
  });
});

test("does not use expired assignment or conflicting approved owners", () => {
  const candidates = [{customerAccountId:"customer-a",active:false}];
  const m = [{retailer:"Target",profileLabel:checkout.sourceProfileLabel,customerAccountId:"customer-a"}];
  assert.equal(resolveApprovedCheckoutAlias(checkout,candidates,m,valid),null);
  assert.equal(resolveApprovedCheckoutAlias(checkout,[{customerAccountId:"customer-a",active:true}],[
    ...m,{retailer:"Target",profileLabel:checkout.sourceProfileLabel,customerAccountId:"customer-b"}
  ],valid),null);
});

test("never guesses managed profile ID when one owner has several possible accounts", () => {
  const candidates = [
    {customerAccountId:"customer-a",managedAccountId:"a1",active:true},
    {customerAccountId:"customer-a",managedAccountId:"a2",active:true}
  ];
  const m=[{retailer:"Target",profileLabel:checkout.sourceProfileLabel,customerAccountId:"customer-a"}];
  assert.deepEqual(resolveApprovedCheckoutAlias(checkout,candidates,m,valid),{customerAccountId:"customer-a"});
});
