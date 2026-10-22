import test from "node:test";
import assert from "node:assert/strict";
import {membershipBoundaryNotice} from "../membership-lapse-notifications.js";
const NOW = Date.parse("2026-10-22T18:00:00Z");
const DAY = 86400000;
const record = (remainingDays, overrides={}) => ({
  stripeSubscriptionId:"sub_example", customerAccountId:"member-example",
  subscriptionStatus:"active",
  currentPeriodEnd:new Date(NOW + remainingDays * DAY).toISOString(),
  cancelAtPeriodEnd:false,
  ...overrides
});
test("auto-renewing active membership produces 5-day then 1-day reminder stage",()=>{
  const five=membershipBoundaryNotice(record(4.5),NOW);
  const one=membershipBoundaryNotice(record(0.8),NOW);
  assert.equal(five.stage,"5d");assert.equal(five.mode,"renewal");
  assert.equal(one.stage,"1d");assert.equal(one.mode,"renewal");
  assert.equal(five.end.toISOString(),record(4.5).currentPeriodEnd);
  assert.equal(membershipBoundaryNotice(record(5.2),NOW),null);
  assert.equal(membershipBoundaryNotice(record(-0.2),NOW),null);
});

test("scheduled cancellation is distinguished from an automatic renewal",()=>{
  const notice=membershipBoundaryNotice(record(4.9,{cancelAtPeriodEnd:true}),NOW);
  assert.equal(notice.stage,"5d");assert.equal(notice.mode,"cancellation");
  const withinDay=membershipBoundaryNotice(record(0.6,{cancelAtPeriodEnd:true}),NOW);
  assert.equal(withinDay.stage,"1d");assert.equal(withinDay.mode,"cancellation");
});
test("do not notify canceled, expired or unverifiable billing records",()=>{
  for(const status of ["canceled","unpaid","past_due","incomplete","unknown"]){
    assert.equal(membershipBoundaryNotice(record(3,{subscriptionStatus:status}),NOW),null,status);
  }
  assert.equal(membershipBoundaryNotice(record(3,{currentPeriodEnd:null}),NOW),null);
  assert.equal(membershipBoundaryNotice(record(3,{currentPeriodEnd:"not-a-date"}),NOW),null);
  assert.equal(membershipBoundaryNotice(record(3,{subscriptionStatus:"trialing"}),NOW)?.mode,"renewal");
});
test("renewal period must be supplied; do not use historical canceled-at timestamps",()=>{
  const pending=membershipBoundaryNotice(record(3,{currentPeriodEnd:null,subscriptionEndDate:new Date(NOW+3*DAY).toISOString()}),NOW);
  assert.equal(pending,null);
});
