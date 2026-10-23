import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {requestedMembershipDuration, requestedMaximumMembershipExtension, stripeMembershipExtensionLimit} from "../membership-extension-billing.js";

const now=Date.parse("2026-10-23T12:00:00.000Z");
const paid=Date.parse("2026-11-23T12:00:00.000Z")/1000;
test("relative duration is added to existing Stripe renewal, not today",()=>{
 const plan=requestedMembershipDuration({durationUnit:"week",durationQuantity:2,periodEnd:paid,now});
 assert.equal(plan.expiresAt,"2026-12-07T12:00:00.000Z");
});
test("month-end extension clamps to actual month end",()=>{
 const plan=requestedMembershipDuration({durationUnit:"month",durationQuantity:1,periodEnd:Date.parse("2027-01-31T10:00:00.000Z")/1000,now});
 assert.equal(plan.expiresAt,"2027-02-28T10:00:00.000Z");
});
test("multiple units and year extensions are supported within Stripe's range",()=>{
 assert.equal(requestedMembershipDuration({durationUnit:"year",durationQuantity:1,periodEnd:paid,now}).expiresAt,"2027-11-23T12:00:00.000Z");
 assert.throws(()=>requestedMembershipDuration({durationUnit:"year",durationQuantity:5,periodEnd:paid,now}),/two-year/i);
 for(const durationQuantity of [0,-1,1.5,NaN])assert.throws(()=>requestedMembershipDuration({durationUnit:"day",durationQuantity,periodEnd:paid,now}),/positive whole number/i);
});
test("Maximum available uses Stripe's two-year billing anchor limit",()=>{
 const billingCycleAnchor=Date.parse("2026-09-01T00:00:00.000Z")/1000;
 assert.equal(new Date(stripeMembershipExtensionLimit({now,billingCycleAnchor})).toISOString(),"2028-09-01T00:00:00.000Z");
 const plan=requestedMaximumMembershipExtension({now,periodEnd:paid,billingCycleAnchor});
 assert.equal(plan.expiresAt,"2028-08-31T23:59:00.000Z");
});
test("maximum selection cannot shorten a subscription or go beyond its Stripe limit",()=>{
 const oldAnchor=Date.parse("2024-01-01T00:00:00.000Z")/1000;
 assert.throws(()=>requestedMaximumMembershipExtension({now,periodEnd:paid,billingCycleAnchor:oldAnchor}),/later|two-year/i);
});
test("year extension cannot exceed an earlier Stripe billing anchor limit",()=>{
 const billingCycleAnchor=Date.parse("2025-01-01T00:00:00.000Z")/1000;
 assert.throws(()=>requestedMembershipDuration({durationUnit:"year",durationQuantity:2,now,periodEnd:paid,billingCycleAnchor}),/two-year/i);
});
test("admin controls, customer tracker, notification and Stripe actions wired",()=>{
 const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
 const admin=fs.readFileSync(new URL("../public/admin.html",import.meta.url),"utf8");
 const mobile=fs.readFileSync(new URL("../public/admin-mobile.js",import.meta.url),"utf8");
 const picker=fs.readFileSync(new URL("../public/membership-extension-picker.js",import.meta.url),"utf8");
 const app=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
 const index=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
 assert.match(server,/requestedMembershipDuration\(/);
 assert.match(server,/kind:"membership_extended"/);
 assert.match(server,/extensionRequestId===requestId/);
 assert.match(server,/stripe\.subscriptions\.update\(subscription\.id/);
 assert.match(admin,/activation-customer-actions/);
 assert.match(admin,/\.\.\.selection,requestId/);
 assert.match(mobile,/\.\.\.selection,requestId/);
 assert.match(app,/customer-membership-track/);
 assert.match(index,/customer-membership-track/);
 assert.match(picker,/data-maximum/);
 assert.match(server,/requestedMaximumMembershipExtension/);
 new vm.Script(picker);
 new vm.Script(mobile);
 for(const match of admin.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
});
