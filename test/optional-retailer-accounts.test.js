import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const discord = fs.readFileSync(new URL("../discord-community.js", import.meta.url), "utf8");

test("customer profile no longer asks for staff-supplied Target, Walmart or PKC login fields", () => {
  const card = app.slice(app.indexOf("function retailerProfileCardHtml("), app.indexOf("function specialProfileCardHtml("));
  assert.ok(!card.includes("retailerFieldsHtml("), "paid customer profiles must not display retailer credential fields");
  const save = app.slice(app.indexOf("async function saveRetailerProfile("), app.indexOf("async function saveSpecialProfile("));
  assert.match(save, /const retailers = \{\};/);
  assert.ok(!save.includes('formData.get(\n             '), "test does not rely on UI secrets during customer profile save");
  const checklist = server.slice(server.indexOf("function paidProfileMissingItems("), server.indexOf("const PROFILE_SETUP_FIELDS"));
  assert.doesNotMatch(checklist, /for \(const retailer of \["target", "walmart"\]\)/);
  assert.ok(html.includes('data-optional-retailer="costco"') && html.includes('data-optional-retailer="samsClub"'));
});

test("optional retailer account endpoints encrypt data and return only safe metadata", () => {
  assert.match(server, /const OPTIONAL_RETAILERS = new Set\(\["costco", "samsClub"\]\)/);
  assert.match(server, /account\.optionalRetailerLogins = encryptJson\(entries\)/);
  assert.match(server, /app\.post\("\/api\/account\/optional-retailer-logins", requireCustomer/);
  assert.match(server, /app\.put\("\/api\/account\/optional-retailer-logins\/:id", requireCustomer/);
  assert.match(server, /app\.delete\("\/api\/account\/optional-retailer-logins\/:id", requireCustomer/);
  const safe = server.slice(server.indexOf("const safeOptionalRetailerLogins ="), server.indexOf('app.get("/api/account/optional-retailer-logins"'));
  assert.match(safe, /passwordConfigured: Boolean\(password\)/);
  assert.doesNotMatch(safe, /return.*password/);
  assert.match(app, /loadOptionalRetailerLogins/);
  assert.match(app, /data-optional-add/);
});

test("Discord enforces paid-only SKU confirmation and preserves older saved selections", () => {
  assert.match(server, /getPaidSkuAllowance: async accountId/);
  assert.match(discord, /if \(!await hasPaidSkuAccess\(userId\)\)/);
  assert.match(discord, /confirmSkuDraft\(userId/);
  assert.match(discord, /const other = \(record.items \|\| \[\]\).filter/);
  assert.match(discord, /writeSkuFile\(skuSelectionsFile, records\)/);
});
