import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { calculateMembershipExtension, membershipExtensionBounds } from "../membership-extension-window.js";

const base = {now: "2026-10-23T12:00:00.000Z", periodEnd: "2026-11-10T18:00:00.000Z", billingCycleAnchor: "2026-10-10T18:00:00.000Z"};

test("extension adds time after the current renewal, not today", () => {
  const result = calculateMembershipExtension({...base, durationUnit: "days", durationQuantity: 10});
  assert.equal(result.expiresAt, "2026-11-20T18:00:00.000Z");
});

test("extension stacks after existing gifted and trial periods", () => {
  const result = calculateMembershipExtension({...base, trialEnd: Date.parse("2026-12-01T18:00:00.000Z") / 1000,
    previousGiftEnd: "2027-01-01T18:00:00.000Z", durationUnit: "weeks", durationQuantity: 2});
  assert.equal(result.startsAt, "2027-01-01T18:00:00.000Z");
  assert.equal(result.expiresAt, "2027-01-15T18:00:00.000Z");
});

test("calendar months are clamped correctly", () => {
  const result = calculateMembershipExtension({...base, periodEnd: "2027-01-31T18:00:00.000Z", durationUnit: "months", durationQuantity: 1});
  assert.equal(result.expiresAt, "2027-02-28T18:00:00.000Z");
});

test("custom date sets the renewal exactly", () => {
  const result = calculateMembershipExtension({...base, until: "2026-12-25T17:00:00.000Z"});
  assert.equal(result.expiresAt, "2026-12-25T17:00:00.000Z");
});

test("invalid periods cannot shorten a current term or exceed Stripe limit", () => {
  assert.throws(() => calculateMembershipExtension({...base, until: "2026-11-01T17:00:00.000Z"}), /later/);
  assert.throws(() => calculateMembershipExtension({...base, durationUnit: "days", durationQuantity: 0}), /positive/);
  assert.throws(() => calculateMembershipExtension({...base, durationUnit: "years", durationQuantity: 3}), /two-year/);
  assert.equal(membershipExtensionBounds(base).maxRenewalAt, "2028-10-10T18:00:00.000Z");
});

test("Admin Extend action and server-side Stripe validation are connected", () => {
  const ui = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.ok(ui.includes('data-activation-customer-action='));
  assert.ok(ui.includes('data-subscription-extend-index='));
  assert.ok(ui.includes('data-subscription-extension-form='));
  assert.ok(api.includes('"/api/admin/membership-extensions/:customerAccountId"'));
  assert.ok(api.includes('requireAdmin'));
  assert.ok(api.includes('proration_behavior: "none"'));
  assert.ok(api.includes('sng_last_admin_extension_request'));
  assert.ok(api.includes('MEMBERSHIP_EXTENSIONS_FILE'));
});
