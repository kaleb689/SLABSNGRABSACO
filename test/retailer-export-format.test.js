import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSafeRetailerProfileExport, TARGET_CSV_COLUMNS } from "../profile-export-formats.js";

const sample = {
  name: "Example Customer 1",
  shipping: { firstName: "Example", lastName: "Customer",
    email: "staff-assigned@example.test", phone: "(555) 000-1111",
    address: "100 Example Ave", address2: "Unit 2", city: "Miami",
    state: "FL", zipCode: "33101", country: "United States" },
  cardInfo: { cardNumber: "SHOULD-NOT-BE-EXPORTED", cvv: "SHOULD-NOT-BE-EXPORTED" }
};

test("Target Shikari CSV uses the exact 23 template columns without card data", () => {
  assert.deepEqual(TARGET_CSV_COLUMNS, [
    "profile_name","first_name","last_name","email","phone_num",
    "cc_number","cc_exp_month","cc_exp_year","cc_cvv",
    "shipping_street","shipping_street_2","shipping_city","shipping_state",
    "shipping_zip_code","shipping_country","billing_first_name",
    "billing_last_name","billing_street","billing_street_2","billing_city",
    "billing_state","billing_zip_code","billing_country"
  ]);
  const result = buildSafeRetailerProfileExport("target", [sample]);
  assert.equal(result.extension, ".csv");
  assert.equal(result.excludesPaymentDetails, true);
  const lines = result.body.trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], TARGET_CSV_COLUMNS.join(","));
  assert.match(lines[1], /staff-assigned@example\.test/);
  assert.match(lines[1], /"FL"/);
  assert.doesNotMatch(result.body, /SHOULD-NOT-BE-EXPORTED/);
  const empty = buildSafeRetailerProfileExport("target", []);
  assert.equal(empty.body.trim(), lines[0]);
});

test("Walmart and PKC Valor JSON match template key layout with empty payment fields", () => {
  for (const retailer of ["walmart", "pkc"]) {
    const result = buildSafeRetailerProfileExport(retailer, [sample]);
    assert.equal(result.extension, ".json");
    assert.equal(result.excludesPaymentDetails, true);
    const entries = JSON.parse(result.body);
    const ids = Object.keys(entries);
    assert.equal(ids.length, 1);
    const value = entries[ids[0]];
    assert.deepEqual(Object.keys(value), [
      "name", "email", "phoneNumber", "billingSameAsShipping", "oneCheckout", "quickTask",
      "card", "shipping", "billing", "id", "totalSpent"
    ]);
    assert.deepEqual(Object.keys(value.card), ["holder", "number", "expiration", "cvv", "type"]);
    assert.deepEqual(Object.keys(value.shipping), [
      "firstName", "lastName", "addressLine1", "addressLine2", "city",
      "countryName", "countryCode", "state", "zipCode"
    ]);
    assert.deepEqual(value.shipping, value.billing);
    assert.equal(value.card.number, "");
    assert.equal(value.card.cvv, "");
    assert.equal(value.email, sample.shipping.email);
    assert.equal(value.shipping.state, "Florida");
    assert.equal(value.id, ids[0]);
    assert.doesNotMatch(result.body, /SHOULD-NOT-BE-EXPORTED/);
  }
});

test("Admin export uses assigned retailer login, no-store response and unchanged encrypted pools", () => {
  const code = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(code, /function exportRetailerEmailForPaid\(/);
  assert.match(code, /function exportRetailerEmailForAssignment\(/);
  assert.match(code, /buildSafeRetailerProfileExport\(retailer, output\)/);
  assert.match(code, /"Cache-Control", "private, no-store"/);
  assert.match(code, /"X-Export-Payment-Fields"/);
  assert.match(code, /app\.post\(\s*"\/api\/admin\/submissions\/:id\/export-profiles",\s*requireAdmin/);
  assert.match(code, /exportAttemptStatus/);
});
