import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { authenticator } from "otplib";

test("admin discount edit, rollback, deactivation and deletion stay synchronized with Stripe", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signup-consent-test-"));
  const port = 46000 + Math.floor(Math.random() * 4000);
  const base = `http://127.0.0.1:${port}`;
  const adminSecret = authenticator.generateSecret();
  const serverOptions = {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(port), BASE_URL: base,
      RESEND_API_KEY: "", STRIPE_SECRET_KEY: "sk_test_missing", STRIPE_TIER1_PRICE_ID: "price_test",
      CUSTOMER_SESSION_SECRET: "synthetic-session-secret-123456789",
      SUBMISSION_ENCRYPTION_KEY: "synthetic-ledger-key-123456789",
      ADMIN_PASSWORD: "synthetic-admin-password-123456789", ADMIN_2FA_SECRET: adminSecret
    },
    stdio: "ignore"
  };
  let server = spawn("node", ["--import", "./test/fixtures/stripe-discounts.mjs", "server.js"], serverOptions);
  const request = async (route, method = "GET", body, cookie = "") => {
    const response = await fetch(base + route, {
      method, headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { await fetch(base); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, "test server started");
    const admin = await request("/api/admin/login", "POST", {
      password: "synthetic-admin-password-123456789", code: authenticator.generate(adminSecret)
    });
    assert.equal(admin.status, 200);
    const customer = await request("/api/account/register", "POST", { email: "jigs@example.test", password: "synthetic-password-123" });
    assert.equal(customer.status, 201);
    const accounts = JSON.parse(await fs.readFile(path.join(dataDir, "customer-accounts.json"), "utf8"));
    const main = { address: "8275 Oceanus drive", address2: "", city: "boca raton", state: "Florida", zip: "33496", country: "US" };
    await fs.writeFile(path.join(dataDir, "paid-submissions.json"), JSON.stringify([{ id: "jig-order", customerAccountId: accounts[0].id, profile: main }]));
    const jigPool = await request("/api/admin/submissions/jig-order/jigs", "GET", null, admin.cookie);
    assert.equal(jigPool.status, 200);
    assert.equal(jigPool.data.sources[0].original.address, main.address);
    assert.ok(jigPool.data.sources[0].variants.some(item => item.address.address === "8275 Oceanus DR"));
    assert.ok(jigPool.data.sources[0].variants.length <= 4);
    const settings = { code: "SAVE20", percent: 20, tier: "all", sitewide: true, duration: "forever" };
    assert.equal((await request("/api/admin/discount-codes", "POST", settings)).status, 401);
    const created = await request("/api/admin/discount-codes", "POST", settings, admin.cookie);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.discount.id;
    const url = `/api/admin/discount-codes/${id}`;
    const edited = await request(url, "PUT", { ...settings, percent: 30 }, admin.cookie);
    assert.equal(edited.status, 200);
    assert.equal(edited.data.discount.id, id);
    assert.notEqual(edited.data.discount.stripeCouponId, created.data.discount.stripeCouponId);
    assert.equal((await request("/api/public/membership-discounts")).data.discounts[1].percent, 30);
    const rejected = await request(url, "PUT", { ...settings, code: "FAIL20" }, admin.cookie);
    assert.equal(rejected.status, 502);
    assert.equal((await request("/api/admin/discount-codes", "GET", null, admin.cookie)).data.codes[0].percent, 30);
    assert.equal((await request(url, "PATCH", { active: false }, admin.cookie)).status, 200);
    assert.deepEqual((await request("/api/public/membership-discounts")).data.discounts, {});
    assert.equal((await request(url, "PATCH", { active: true }, admin.cookie)).status, 200);
    assert.equal((await request(url, "DELETE", null, admin.cookie)).status, 200);
    assert.deepEqual((await request("/api/admin/discount-codes", "GET", null, admin.cookie)).data.codes, []);
    assert.deepEqual((await request("/api/public/membership-discounts")).data.discounts, {});
    assert.equal((await request(url, "PUT", settings, admin.cookie)).status, 404);
    const privateCode = await request("/api/admin/discount-codes", "POST", { ...settings, sitewide: false, recipientEmail: "mike@example.test" }, admin.cookie);
    assert.equal(privateCode.status, 201);
    assert.equal(privateCode.data.discount.stripePromotionCodeId, null);
    assert.equal((await request(`/api/admin/discount-codes/${privateCode.data.discount.id}`, "DELETE", null, admin.cookie)).status, 200);
    const fixed = await request("/api/admin/discount-codes", "POST", {
      code: "FIXED10", discountType: "fixed-price", fixedPrice: 10,
      tier: 1, maxUses: 2, duration: "once", sitewide: false
    }, admin.cookie);
    assert.equal(fixed.status, 201);
    assert.equal(fixed.data.discount.fixedPrice, 10);
    assert.equal(fixed.data.discount.amountOffCents, 500);
    assert.equal(fixed.data.discount.maxUses, 2);
    assert.equal(fixed.data.discount.discountType, "fixed-price");
    const fixedList = await request("/api/admin/discount-codes", "GET", null, admin.cookie);
    assert.equal(fixedList.data.codes[0].redemptions, 0);
    assert.equal(fixedList.data.codes[0].exhausted, false);
    const fixedEdit = await request(`/api/admin/discount-codes/${fixed.data.discount.id}`, "PUT", {
      code: "FIXED10", discountType: "fixed-price", fixedPrice: 9.5,
      tier: 1, maxUses: 1, duration: "forever"
    }, admin.cookie);
    assert.equal(fixedEdit.status, 200);
    assert.equal(fixedEdit.data.discount.amountOffCents, 550);
    assert.equal(fixedEdit.data.discount.maxUses, 1);
    assert.equal((await request("/api/admin/discount-codes", "POST", {
      code: "INVALID1", discountType: "fixed-price", fixedPrice: 10,
      tier: "all", maxUses: 2
    }, admin.cookie)).status, 400, "fixed prices require one selected tier");
    assert.equal((await request("/api/admin/discount-codes", "POST", {
      code: "INVALID2", discountType: "fixed-price", fixedPrice: 15,
      tier: 1, maxUses: 2
    }, admin.cookie)).status, 400, "fixed price must be less than normal tier price");
    assert.equal((await request("/api/admin/discount-codes", "POST", {
      code: "INVALID3", discountType: "fixed-price", fixedPrice: 10,
      tier: 1, maxUses: 0
    }, admin.cookie)).status, 400, "redemption limit must be positive");
    assert.equal((await request("/api/admin/discount-codes", "POST", {
      code: "INVALID4", discountType: "fixed-price", fixedPrice: 10.001,
      tier: 1, maxUses: 2
    }, admin.cookie)).status, 400, "fixed price must use dollar-cent precision");
    assert.equal((await request(`/api/admin/discount-codes/${fixed.data.discount.id}`, "DELETE", null, admin.cookie)).status, 200);
  } finally {
    server.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
