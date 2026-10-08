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
    assert.match(app, new RegExp("getElementById\\(\\\"" + form + "\\\"\\)"));
  }
});

test("Every onboarding window can be dismissed without requiring saved fields", () => {
  for (const section of ["address", "card", "imap"]) {
    assert.ok(html.includes('data-onboarding-close="' + section + '"'));
  }
  const handler = app.match(/document.addEventListener\\("click", event => \\{\\s+const close = event.target.closest\\("\\[data-onboarding-close\\]"\\);[\\s\\S]*?\\n\\}\\);/);
  assert.ok(handler, "close handler must exist");
  assert.match(handler[0], /dismissAccountCheckoutOnboarding\\(\\)/);
  assert.doesNotMatch(handler[0], /addresses\\?\\.length|paymentMethods\\?\\.length/);
  assert.match(app, /localStorage\\.setItem\\(onboardingDismissalKey\\(\\), "1"\\)/);
  assert.match(app, /!accountOnboardingWasDismissed\\(\\)/);
});

test("Unfinished shipping and payment details remain checklist items for new accounts", () => {
  const checklistStart = server.indexOf("async function customerSetupChecklist(");
  const checklistEnd = server.indexOf("async function customerMissingInformation(", checklistStart);
  const body = server.slice(checklistStart, checklistEnd);
  assert.match(body, /add\\("Account: one shipping address", \\{ type: "shipping" \\}, hasAddress\\)/);
  assert.match(body, /add\\("Account: one payment card", \\{ type: "payment" \\}, hasCard\\)/);
  assert.doesNotMatch(body, /if \\(tasks\\.length\\) \\{/);
});