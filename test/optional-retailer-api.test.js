import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

test("optional Costco/Sam's Club logins are encrypted, editable and isolated to the customer", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "optional-retailer-test-"));
  const port = 46500 + Math.floor(Math.random() * 400);
  const base = "http://127.0.0.1:" + port;
  const server = spawn("node", ["server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(port), BASE_URL: base,
      RESEND_API_KEY: "", STRIPE_SECRET_KEY: "sk_test_missing",
      CUSTOMER_SESSION_SECRET: "optional-retailer-test-session-secret-long",
      SUBMISSION_ENCRYPTION_KEY: "optional-retailer-test-encryption-key-long",
      ADMIN_PASSWORD: "optional-retailer-test-admin-password-long",
      ADMIN_2FA_SECRET: "JBSWY3DPEHPK3PXP"
    }, stdio: "ignore"
  });
  const request = async (route, method = "GET", body, cookie = "") => {
    const response = await fetch(base + route, {
      method, headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
      status: response.status, data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || ""
    };
  };
  try {
    let ready = false;
    for (let tries = 0; tries < 80; tries++) {
      try { await fetch(base); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, "test website starts");
    const reg = await request("/api/account/register", "POST", {
      email: "optional@example.test", password: "test-long-account-password-2026"
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.data));
    assert.ok(reg.cookie, "signup issues the customer's session");
    const baseRoute = "/api/account/optional-retailer-logins";
    assert.equal((await request(baseRoute)).status, 401);
    assert.equal((await request(baseRoute, "POST", { retailer: "walmart", username: "hidden", password: "pass" }, reg.cookie)).status, 400);
    const created = await request(baseRoute, "POST", {
      retailer: "costco", username: "member@example.test", password: "only-for-local-fixture"
    }, reg.cookie);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.entries.length, 1);
    assert.equal(created.data.entries[0].retailer, "costco");
    assert.equal(created.data.entries[0].passwordConfigured, true);
    assert.ok(!JSON.stringify(created.data).includes("only-for-local-fixture"));
    const id = created.data.entries[0].id;
    assert.equal((await request(baseRoute, "POST", {
      retailer: "costco", username: "MEMBER@example.test", password: "dup"
    }, reg.cookie)).status, 409);
    const sam = await request(baseRoute, "POST", {
      retailer: "samsClub", username: "member2@example.test", password: "second-fixture-pass"
    }, reg.cookie);
    assert.equal(sam.status, 201);
    assert.equal(sam.data.entries.length, 2);
    const edited = await request(baseRoute + "/" + id, "PUT", {
      username: "updated@example.test", password: ""
    }, reg.cookie);
    assert.equal(edited.status, 200);
    assert.equal(edited.data.entries.find(item => item.id === id)?.username, "updated@example.test");
    assert.equal(edited.data.entries.find(item => item.id === id)?.passwordConfigured, true);
    const stored = await fs.readFile(path.join(dataDir, "customer-accounts.json"), "utf8");
    assert.ok(!stored.includes("only-for-local-fixture") && !stored.includes("second-fixture-pass"));
    assert.match(stored, /optionalRetailerLogins/);
    const read = await request(baseRoute, "GET", undefined, reg.cookie);
    assert.equal(read.status, 200);
    assert.equal(read.data.entries.length, 2);
    assert.ok(!JSON.stringify(read.data).includes("fixture-pass"));
    assert.equal((await request(baseRoute + "/" + id, "DELETE", undefined, reg.cookie)).status, 200);
    assert.equal((await request(baseRoute, "GET", undefined, reg.cookie)).data.entries.length, 1);
  } finally {
    server.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
