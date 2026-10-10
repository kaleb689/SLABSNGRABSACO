import test from "node:test";
import assert from "node:assert/strict";
import {membershipRate} from "../membership-billing-math.js";
const base={status:"active",items:{data:[{quantity:1,current_period_end:1794240000,price:{currency:"usd",unit_amount:4500,recurring:{interval:"month",interval_count:1}}}]}};
test("Membership normal monthly amount is separate from prior upgrade invoice",()=>{
 const x=membershipRate(base,Date.parse("2026-10-10T00:00:00Z"));
 assert.equal(x.regularMonthlyCents,4500);
 assert.equal(x.currentMonthlyCents,4500);
 assert.equal(x.nextChargeCents,4500);
});
test("Gifted paid membership is $0 while next renewal retains tier rate",()=>{
 const x=membershipRate({...base,status:"trialing",trial_end:1794816000},Date.parse("2026-10-10T00:00:00Z"));
 assert.equal(x.currentMonthlyCents,0);
 assert.equal(x.nextChargeCents,4500);
 assert.ok(x.giftedUntil);
});
test("Repeating percentage discount expires before next billing date",()=>{
 const x=membershipRate({...base,discounts:[{start:1790791200,end:1793470000,coupon:{percent_off:50,duration:"repeating",duration_in_months:1}}]},Date.parse("2026-10-10T00:00:00Z"));
 assert.equal(x.currentMonthlyCents,2250);
 assert.equal(x.nextChargeCents,4500);
});
test("Unsupported discount never fabricates a billing amount",()=>{
 const x=membershipRate({...base,discounts:["di_unexpanded"]},Date.parse("2026-10-10T00:00:00Z"));
 assert.equal(x.currentMonthlyCents,null);
});
