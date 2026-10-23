import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("Onboarding forms exist before app.js executes so Save buttons are bound", () => {
  const appScriptTag = html.match(/<script src="\/app\.js(?:\?[^\"]+)?"><\/script>/);
  const script = appScriptTag ? html.indexOf(appScriptTag[0]) : -1;
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
  assert.ok(app.includes("setAccountOnboardingVisibility(\"\")"));
  assert.ok(!app.includes('() => openAccountCheckoutOnboarding("address")'));
});

test("Purchased staff-managed memberships require no profile or IMAP checklist until user adds a personal profile",()=>{
 const start=server.indexOf("async function customerSetupChecklist(");
 const end=server.indexOf("async function customerMissingInformation(",start);
 const body=server.slice(start,end);
 assert.ok(body.includes("if (!owned.length) return []"));
 assert.ok(body.includes('add("Own profiles: IMAP email"'));
 assert.ok(body.includes('add("Own profiles: IMAP app password"'));
 assert.ok(!body.includes('add("Account: one shipping address"'));
 assert.ok(!body.includes('add("Account: one payment card"'));
 assert.ok(app.includes('updateOwnProfileImapVisibility'));
 assert.ok(html.includes('class="saved-detail-panel imap-detail-panel" hidden'));
});
test("Walmart inventory is request-only",()=>{
 assert.ok(server.includes('/api/account/walmart-profile-request'));
 assert.ok(server.includes('const retailers=["target","pokemoncenter"]'));
 assert.ok(!server.includes('const retailers=["target","walmart","pokemoncenter"]'));
 const start=server.indexOf("async function assignReferralRewardProfiles(");
 const referral=server.slice(start,server.indexOf("async function ",start+10));
 assert.ok(start>=0);
 assert.ok(!referral.includes('getAvailableManagedAccountsForRetailer("walmart")'));
 assert.ok(!referral.includes("walmart: matchingWalmart"));
 assert.ok(app.includes('/api/account/walmart-profile-request'));
});
