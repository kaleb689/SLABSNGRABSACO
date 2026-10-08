import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("Onboarding forms exist before app.js executes so Save buttons are bound", () => {
  const script = html.indexOf('<script src="/app.js"></script>');
  assert.ok(script > 0);
  for (const form of ["account-address-onboarding-form", "account-card-onboarding-form", "account-imap-onboarding-form"]) {
    assert.ok(html.indexOf('id="' + form + '"') < script, form + " must exist before app.js loads");
    assert.ok(app.includes(form), form + " must be handled in app.js");
  }
});

test("Every onboarding window can be dismissed without requiring saved fields", () => {
  for (const section of ["address", "card", "imap"]) {
    assert.ok(html.includes('data-onboarding-close="' + section + '"'));
  }
  const pos = app.indexOf('const close = event.target.closest("[data-onboarding-close]")');
  assert.ok(pos >= 0, "close handler must exist");
  const handler = app.slice(pos, pos + 150);
  assert.ok(handler.includes("dismissAccountCheckoutOnboarding()"));
  assert.ok(!handler.includes("addresses?.length") && !handler.includes("paymentMethods?.length"));
  assert.ok(app.includes('localStorage.setItem(onboardingDismissalKey(), "1")'));
  assert.ok(app.includes("!accountOnboardingWasDismissed()"));
});

test("Unfinished shipping and payment details remain checklist items for new accounts", () => {
  const start = server.indexOf("async function customerSetupChecklist(");
  const end = server.indexOf("async function customerMissingInformation(", start);
  assert.ok(start >= 0 && end > start);
  const body = server.slice(start, end);
  assert.ok(body.includes('add("Account: one shipping address", { type: "shipping" }, hasAddress)'));
  assert.ok(body.includes('add("Account: one payment card", { type: "payment" }, hasCard)'));
  assert.ok(!body.includes("if (tasks.length) {"), "checklist must not require an existing paid order");
});
