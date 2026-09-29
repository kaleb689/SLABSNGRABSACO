import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { authenticator } from "otplib";

test("startup reset replaces legacy jigs, caps each Main at four, flags overflow, and runs once", async () => {
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
  const main = { address: "3350 NW 2ND AVE", address2: "Ste A2", city: "Boca raton", state: "FL", zip: "33431", country: "US" };
  await fs.writeFile(path.join(dataDir, "customer-accounts.json"), JSON.stringify([{ id: "seed-customer", email: "seed@example.test", adminProfile: main }]));
  await fs.writeFile(path.join(dataDir, "paid-submissions.json"), JSON.stringify([{ id: "seed-order", customerAccountId: "seed-customer", profile: main }]));
  await fs.writeFile(path.join(dataDir, "retailer-profiles.json"), JSON.stringify(Array.from({ length: 5 }, (_, index) => ({
    id: `profile-${index}`, customerAccountId: "seed-customer", jigSourceAddress: main,
    jiggedAddress: { ...main, address2: "SUITE A2" }, jigHistoryKeys: ["old-key"], exportAttemptStatus: "successful",
    customerProfile: { ...main, firstName: "Preserved", email: `user${index}@example.test` }
  }))));
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
    const view = await request("/api/admin/submissions/seed-order/jigs", "GET", null, admin.cookie);
    assert.equal(view.status, 200);
    assert.equal(view.data.sources.length, 1);
    assert.equal(view.data.sources[0].variants.length, 4);
    assert.deepEqual(view.data.sources[0].original.address, main.address);
    assert.ok(view.data.sources[0].variants.some(item => item.address.address === "3350 NORTHWEST 2 AVENUE" && item.address.address2 === "# A2"));
    const profiles = JSON.parse(await fs.readFile(path.join(dataDir, "retailer-profiles.json"), "utf8"));
    assert.equal(new Set(profiles.filter(item => item.jiggedAddress).map(item => JSON.stringify(item.jiggedAddress))).size, 4);
    assert.equal(profiles.filter(item => item.jigNeeded).length, 1);
    assert.equal(profiles[4].jiggedAddress, null);
    for (const [index, item] of profiles.entries()) {
      assert.equal(item.customerProfile.email, `user${index}@example.test`);
      assert.equal(item.customerProfile.firstName, "Preserved");
      assert.equal(item.customerProfile.city, main.city);
      assert.equal(item.customerProfile.state, main.state);
      assert.equal(item.customerProfile.zip, main.zip);
      assert.equal(item.jigSourceAddress.address2, "Ste A2");
      assert.equal(item.exportAttemptStatus, null);
    }
    const source = view.data.sources[0];
    const add = await request(`/api/admin/submissions/seed-order/jigs/${source.id}`, "POST", { address: { ...main, address2: "SUITE A2" } }, admin.cookie);
    assert.equal(add.status, 409);
    const badUnit = await request(`/api/admin/submissions/seed-order/jigs/${source.id}/${source.variants[0].id}`, "PUT", { address: { ...main, address2: "UNIT B2" } }, admin.cookie);
    assert.equal(badUnit.status, 400);
    const first = source.variants[0];
    const firstUrl = `/api/admin/submissions/seed-order/jigs/${source.id}/${first.id}`;
    const rejig = await request(firstUrl + "/rejig", "POST", {}, admin.cookie);
    assert.equal(rejig.status, 200);
    assert.notDeepEqual(rejig.data.variant.address, first.address);
    const updated = JSON.parse(await fs.readFile(path.join(dataDir, "retailer-profiles.json"), "utf8"));
    assert.deepEqual(updated[0].jiggedAddress, rejig.data.variant.address);
    assert.equal((await request(firstUrl, "PUT", { address: first.address }, admin.cookie)).status, 409);
    const remove = await request(firstUrl, "DELETE", { block: true }, admin.cookie);
    assert.equal(remove.status, 200);
    assert.equal(remove.data.updatedProfiles, 1);
    assert.equal((await request(`/api/admin/submissions/seed-order/jigs/${source.id}`, "POST", { address: rejig.data.variant.address }, admin.cookie)).status, 409);
    const refreshed = await request("/api/admin/submissions/seed-order/jigs", "GET", null, admin.cookie);
    assert.equal(refreshed.data.sources[0].variants.length, 3);
    const second = refreshed.data.sources[0].variants[0];
    assert.equal((await request(`/api/admin/submissions/seed-order/jigs/${source.id}/${second.id}`, "DELETE", {}, admin.cookie)).status, 200);
    const mainUrl = "/api/admin/submissions/seed-order/jigs/main";
    const extraMain = { address: "123 SW 81st St", address2: "APT 2", city: "Fort Lauderdale", state: "FL", zip: "33330", country: "US" };
    assert.equal((await request(mainUrl, "POST", { address: extraMain })).status, 401);
    const addedMain = await request(mainUrl, "POST", { address: extraMain, label: "Second Main" }, admin.cookie);
    assert.equal(addedMain.status, 200);
    assert.equal(addedMain.data.source.original.address, extraMain.address);
    assert.equal(addedMain.data.source.original.address2, extraMain.address2);
    assert.equal(addedMain.data.source.variants.length, 4);
    assert.equal((await request(mainUrl, "POST", { address: extraMain }, admin.cookie)).status, 409);
    assert.equal((await request(mainUrl, "POST", { address: addedMain.data.source.variants[0].address }, admin.cookie)).status, 409);
    assert.equal((await request(mainUrl, "POST", { address: { address: "Incomplete" } }, admin.cookie)).status, 400);
    const profilesAfterActions = JSON.parse(await fs.readFile(path.join(dataDir, "retailer-profiles.json"), "utf8"));
    assert.equal(profilesAfterActions[0].jigNeeded, true);
    assert.equal(profilesAfterActions[0].customerProfile.address, main.address);
    const backups = await fs.readdir(path.join(dataDir, "secure-packages", "jig-reset-backups"));
    assert.equal(backups.length, 1);
    const backup = await fs.readFile(path.join(dataDir, "secure-packages", "jig-reset-backups", backups[0]), "utf8");
    assert.ok(!backup.includes("example.test"));
    server.kill();
    await new Promise(resolve => server.once("exit", resolve));
    server = spawn("node", ["--import", "./test/fixtures/stripe-discounts.mjs", "server.js"], serverOptions);
    let readyAgain = false;
    for (let i = 0; i < 60; i++) { try { await fetch(base); readyAgain = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
    assert.ok(readyAgain);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "retailer-profiles.json"), "utf8")), profilesAfterActions);
    assert.equal((await fs.readdir(path.join(dataDir, "secure-packages", "jig-reset-backups"))).length, 1);
  } finally {
    server.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
