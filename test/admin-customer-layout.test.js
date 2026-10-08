import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");

test("Admin embedded JavaScript compiles after hiding customer retailer credential forms", () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => !/\bsrc\s*=/.test(match[1]));
  assert.ok(scripts.length > 0, "Admin page includes its application script");
  for (const script of scripts) {
    assert.doesNotThrow(() => new vm.Script(script[2], { filename: "public/admin.html inline script" }));
  }
});

test("Customer order forms have no obsolete retailer credential fields, operator inventory remains available", () => {
  const paid = html.slice(html.indexOf("function retailerProfileHtml("), html.indexOf("function specialProfileHtml("));
  const gifted = html.slice(html.indexOf("function specialProfileHtml("), html.indexOf("function managedRetailerFields("));
  assert.match(paid, /const retailerBlocks = "";?/);
  assert.doesNotMatch(paid, /const retailerBlocks =\s*ADMIN_RETAILERS/);
  assert.match(gifted, /const retailerBlocks = "";?/);
  assert.ok(html.includes("function managedRetailerFields("), "Separate staff inventory management is retained");
  assert.match(html, /data-admin-customer-account=/);
  assert.match(html, /optional-retailer-logins/);
  assert.match(html, /Saved Shipping, Payment &amp; Optional Retailer Accounts/);
});
