import test from "node:test";
import assert from "node:assert/strict";
import {giftedBillingWindow} from "../membership-gift-billing.js";
test("Gifted week extends after the already-paid period, never charges early",()=>{
 const w=giftedBillingWindow({now:new Date("2026-10-10T12:00:00Z"),periodEnd:1792512000,quantity:1,unit:"weeks"});
 assert.equal(w.startsAt,"2026-10-20T16:00:00.000Z");
 assert.equal(w.expiresAt,"2026-10-27T16:00:00.000Z");
});
test("Month gifts clamp 31st to final calendar day",()=>{
 const w=giftedBillingWindow({now:new Date("2026-01-01T00:00:00Z"),periodEnd:"2026-01-31T12:00:00Z",quantity:1,unit:"months"});
 assert.equal(w.expiresAt,"2026-02-28T12:00:00.000Z");
});
test("Subsequent grants extend existing Stripe trial end rather than replacing it",()=>{
 const w=giftedBillingWindow({now:new Date("2026-01-01T00:00:00Z"),periodEnd:"2026-01-20T00:00:00Z",trialEnd:1769817600,quantity:1,unit:"weeks"});
 assert.equal(w.startsAt,"2026-01-31T00:00:00.000Z");
 assert.equal(w.expiresAt,"2026-02-07T00:00:00.000Z");
});
test("Reject invalid durations",()=>{
 assert.throws(()=>giftedBillingWindow({quantity:0,unit:"weeks"}));
 assert.throws(()=>giftedBillingWindow({quantity:15,unit:"months"}));
});
