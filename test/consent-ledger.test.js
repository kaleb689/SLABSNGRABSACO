import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { authenticator } from "otplib";

test("records a signup and individual checkbox changes without storing card data in receipts", async () => {
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
  let server = spawn("node", ["server.js"], serverOptions);
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
    const signup = await request("/api/account/register", "POST", {
      email: "consent-test@example.test", password: "synthetic-password-123"
    });
    assert.equal(signup.status, 201);
    const flowId = "11111111-1111-4111-8111-111111111111";
    for (const [checkbox, checked] of [
      ["confirm", true], ["acknowledgeAcoOutcome", true],
      ["authorizeRequestedPurchases", true], ["authorizeRequestedPurchases", false]
    ]) {
      const event = await request("/api/account/purchase-consent-event", "POST", {
        flowId, checkbox, checked, clientClickedAt: new Date().toISOString()
      }, signup.cookie);
      assert.equal(event.status, 200);
      assert.ok(event.data.receivedAt);
    }
    const denied = await request("/api/create-checkout-session", "POST", {
      tier: 1, consentFlowId: flowId, confirm: true,
      acknowledgeAcoOutcome: true, authorizeRequestedPurchases: true
    }, signup.cookie);
    assert.equal(denied.status, 400);
    assert.match(denied.data.error, /check each consent box/i);

    const admin = await request("/api/admin/login", "POST", {
      password: "synthetic-admin-password-123456789", code: authenticator.generate(adminSecret)
    });
    assert.equal(admin.status, 200);
    const audit = await request("/api/admin/signup-consent-log", "GET", null, admin.cookie);
    assert.equal(audit.status, 200);
    assert.equal(audit.data.total, 5);
    assert.equal(audit.data.entries[0].checked, false);
    assert.equal(audit.data.entries.at(-1).type, "signup_completed");
    const ledger = await fs.readFile(path.join(dataDir, "secure-packages", "signup-consent-ledger.jsonl"), "utf8");
    assert.equal(ledger.trim().split("\n").length, 5);
    assert.ok(!ledger.includes("consent-test@example.test"));
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, "secure-packages", "consent-email-queue.json"), "utf8"));
    assert.ok(!JSON.stringify(stored).includes("consent-test@example.test"));
    const decipher = crypto.createDecipheriv("aes-256-gcm",
      crypto.createHash("sha256").update("synthetic-ledger-key-123456789").digest(),
      Buffer.from(stored.iv, "base64"));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    const receipts = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(stored.data, "base64")), decipher.final()
    ]).toString("utf8"));
    assert.equal(receipts.length, 1);
    assert.match(receipts[0].text, /No card or purchase authorization checkbox is presented during account registration/);
    assert.ok(!JSON.stringify(receipts).includes("4111111111111111"));

    server.kill();
    await new Promise(resolve => server.once("exit", resolve));
    server = spawn("node", ["server.js"], serverOptions);
    let restarted = false;
    for (let i = 0; i < 60; i++) {
      try { await fetch(base); restarted = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(restarted, "test server restarted");
    const secondAdmin = await request("/api/admin/login", "POST", {
      password: "synthetic-admin-password-123456789", code: authenticator.generate(adminSecret)
    });
    assert.equal(secondAdmin.status, 200);
    const preserved = await request("/api/admin/signup-consent-log", "GET", null, secondAdmin.cookie);
    assert.equal(preserved.data.total, 5, "audit events remain after restart");
  } finally {
    server.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
