import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifiedSameDayCheckoutOwner } from "../checkout-owner-verified-day.js";

const email="retailer001@example.test";
const loginHash=createHash("sha256").update(email).digest("hex");
const checkout = (id,at="2026-10-16T10:00:00Z",retailer="Target")=>({
  id:"discord:1532179373292257290:"+id, retailer, checkoutAt:at, status:"confirmed"
});
const seed={
  ...checkout("1580000000000000001"),
  customerAccountId:"mike",
  attributionSource:"admin_verified_original_discord_checkout",
  attributionAudit:{
    verification:"owner_confirmed_historical_retailer_account",
    retailer:"Target", customerAccountId:"mike", retailerLoginHash:loginHash
  }
};
const identity={email};

test("one admin-verified retailer email recovers separate same-day original orders, never guesses prices",()=>{
  const owner=verifiedSameDayCheckoutOwner(checkout("1580000000000000002"),identity,[seed]);
  assert.equal(owner?.customerAccountId,"mike");
  assert.equal(owner?.attributionSource,"admin_verified_same_day_retailer_login");
});
test("different day, retailer, login, or owner never inherit a manual assignment",()=>{
  for(const order of [
    checkout("1580000000000000002","2026-10-15T10:00:00Z"),
    checkout("1580000000000000002","2026-10-16T10:00:00Z","Walmart"),
    {...checkout("1580000000000000002"),status:"cancelled"}
  ]) assert.equal(verifiedSameDayCheckoutOwner(order,identity,[seed]),null);
  assert.equal(verifiedSameDayCheckoutOwner(checkout("1580000000000000002"),{email:"other@example.test"},[seed]),null);
  assert.equal(verifiedSameDayCheckoutOwner(checkout("1580000000000000002"),identity,[seed,{...seed,customerAccountId:"other",attributionAudit:{...seed.attributionAudit,customerAccountId:"other"}}]),null);
  assert.equal(verifiedSameDayCheckoutOwner(checkout("1580000000000000002"),identity,[seed],
    [{email,retailer:"Target",customerAccountId:"other"}],()=>true),null);
});
test("only exact admin-verification evidence, not paid-member names or arbitrary order ownership, authorizes recovery",()=>{
  const order=checkout("1580000000000000002");
  for(const altered of [
    {...seed,attributionSource:"automatic"},
    {...seed,attributionAudit:{...seed.attributionAudit,retailerLoginHash:"wrong"}},
    {...seed,attributionAudit:{...seed.attributionAudit,customerAccountId:"other"}},
    {...seed,customerAccountId:null}
  ]) assert.equal(verifiedSameDayCheckoutOwner(order,identity,[altered]),null);
});
