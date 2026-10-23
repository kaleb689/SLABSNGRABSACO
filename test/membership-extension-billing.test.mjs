import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {requestedMembershipExtension} from "../membership-extension-billing.js";

const now=Date.parse("2026-10-23T12:00:00.000Z");
test("custom membership extension starts after current paid term and defers Stripe billing",()=>{
 const plan=requestedMembershipExtension({
  endAt:"2027-05-08T14:30:00.000Z",now,periodEnd:Math.floor(Date.parse("2026-11-23T12:00:00.000Z")/1000)
 });
 assert.equal(plan.stripeTrialEnd,Math.floor(Date.parse("2027-05-08T14:30:00.000Z")/1000));
 assert.equal(plan.expiresAt,"2027-05-08T14:30:00.000Z");
 assert.equal(plan.startsAt,"2026-11-23T12:00:00.000Z");
});
test("custom membership extension cannot move Stripe renewal earlier or accept bad durations",()=>{
 const params={now,periodEnd:Math.floor(Date.parse("2026-11-23T12:00:00.000Z")/1000),trialEnd:Math.floor(Date.parse("2027-01-01T00:00:00.000Z")/1000)};
 for(const endAt of ["bad","2026-10-23T14:00:00.000Z","2026-12-01T00:00:00.000Z","2027-01-01T00:00:00.000Z","2100-01-01T00:00:00.000Z"]){
  assert.throws(()=>requestedMembershipExtension({...params,endAt}),/valid|later|within/i,endAt);
 }
 const plan=requestedMembershipExtension({...params,endAt:"2027-03-01T00:00:00.000Z"});
 assert.equal(plan.startsAt,"2027-01-01T00:00:00.000Z");
 assert.equal(plan.stripeTrialEnd,Math.floor(Date.parse("2027-03-01T00:00:00.000Z")/1000));
});
test("website, app, and Stripe extension are linked to one idempotent admin action",()=>{
 const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
 const admin=fs.readFileSync(new URL("../public/admin.html",import.meta.url),"utf8");
 const mobile=fs.readFileSync(new URL("../public/admin-mobile.js",import.meta.url),"utf8");
 assert.match(server,/app\.post\("\/api\/admin\/membership-extensions", requireAdmin/);
 assert.match(server,/stripe\.subscriptions\.update\(subscription\.id/);
 assert.match(server,/proration_behavior:"none"/);
 assert.match(server,/sng_last_admin_extension_request/);
 assert.match(server,/billingVerified:true/);
 assert.match(admin,/data-admin-extend-membership/);
 assert.match(admin,/\/api\/admin\/membership-extensions/);
 assert.match(mobile,/data-extend-membership/);
 assert.match(mobile,/\/api\/admin\/membership-extensions/);
 for(const match of admin.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){
  if(match[1].trim())assert.doesNotThrow(()=>new vm.Script(match[1]));
 }
 new vm.Script(mobile);
});

test("Paid Stripe extensions are not independent gifted entitlements",()=>{
 const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
 assert.match(server,/SUBSCRIPTION_EXTENSIONS_FILE/);
 assert.match(server,/getGiftedMemberships\(\)[\s\S]{0,250}\.filter\(x => x\?\.kind !== "admin_extension"\)/);
 assert.match(server,/async function getSubscriptionExtensions\(\)/);
 assert.match(server,/const records=await getSubscriptionExtensions\(\)/);
 assert.match(server,/await saveSubscriptionExtensions\(records\)/);
 assert.match(server,/const latestPaid=await readJson\(PAID_FILE,\[\]\)/);
 assert.match(server,/kind:"admin_extension"/);
 assert.match(server,/getSubscriptionExtensions\(\)\]\)/);
});
