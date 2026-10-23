import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const admin=fs.readFileSync(new URL("../public/admin.html",import.meta.url),"utf8");
const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");

test("Admin activation has no active-profile count tile or customer dropdown",()=>{
 assert.ok(!admin.includes('id="activatedProfileCount"'));
 const start=admin.indexOf("adminVisibleActivationGroups = customers;");
 const end=admin.indexOf("bindProfileActivationButtons();",start);
 assert.ok(start>=0&&end>start);
 const render=admin.slice(start,end);
 assert.ok(render.includes('class="activation-group activation-customer-row"'));
 assert.ok(render.includes('data-activation-customer-action='));
 assert.ok(render.includes('data-activation-customer-index='));
 assert.ok(render.includes('"Deactivate":"Set Active"'));
 assert.ok(!render.includes("<details"));
 assert.ok(!render.includes('group.profiles.length'));
});

test("Customer activation groups stay scoped and use the correct managed endpoints",()=>{
 const start=admin.indexOf("async function submitProfileActivation(");
 const end=admin.indexOf("refreshProfileActivationTracker",start);
 const code=admin.slice(start,end);
 assert.ok(code.includes('profile.managedActivation===true'));
 assert.ok(code.includes('["activated","awaiting_activation","deactivated","inactive"]'));
 assert.ok(code.includes('group.profiles.filter'));
 assert.ok(code.includes('await submitProfileActivation(profile,action)'));
 assert.ok(code.includes('adminLastActivationFingerprint=null'));
 const tracker=server.slice(server.indexOf('"/api/admin/profile-activation-tracker"'));
 assert.ok(tracker.includes('autoPaidPoolAssignment'));
 assert.ok(tracker.includes('managedActivation: true'));
});
