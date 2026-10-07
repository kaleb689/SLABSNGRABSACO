import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('optional IMAP skip and notification settings persist behind account authentication', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sng-settings-'));
  const port = 49000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn('node', ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: {
    ...process.env, DATA_DIR: dataDir, PORT: String(port), BASE_URL: base,
    RESEND_API_KEY: '', STRIPE_SECRET_KEY: 'sk_test_missing', CUSTOMER_SESSION_SECRET: 'synthetic-session-secret-123456789',
    SUBMISSION_ENCRYPTION_KEY: 'synthetic-ledger-key-123456789', ADMIN_PASSWORD: 'synthetic-admin-password-123456789', ADMIN_2FA_SECRET: 'JBSWY3DPEHPK3PXP'
  }, stdio: 'ignore' });
  t.after(async () => { server.kill(); await new Promise(resolve => server.once('exit', resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  for (let i = 0; i < 80; i++) { try { await fetch(base); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
  async function request(route, method = 'GET', body, cookie = '') {
    const response = await fetch(base + route, { method, headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  assert.equal((await request('/api/account/push-preferences')).status, 401);
  assert.equal((await request('/api/account/imap-onboarding/skip', 'POST')).status, 401);
  const signup = await request('/api/account/register', 'POST', { email: 'app-settings@example.test', password: 'synthetic-password-123' });
  assert.equal(signup.status, 201);
  assert.equal((await request('/api/account/imap-onboarding/skip', 'POST', {}, signup.cookie)).status, 200);
  const session = await request('/api/account/session', 'GET', null, signup.cookie);
  assert.ok(session.data.account.imapOnboardingCompletedAt);
  assert.equal((await request('/api/account/imap-credentials', 'GET', null, signup.cookie)).data.entries.length, 0);
  const settings = await request('/api/account/push-preferences', 'PUT', { shipping: false, messages: true, unrelated: true }, signup.cookie);
  assert.equal(settings.status, 200); assert.equal(settings.data.preferences.shipping, false); assert.equal(settings.data.preferences.unrelated, undefined);
  const reloaded = await request('/api/account/push-preferences', 'GET', null, signup.cookie);
  assert.equal(reloaded.data.preferences.shipping, false); assert.equal(reloaded.data.preferences.orders, true);
  const key = await request('/api/account/push-key', 'GET', null, signup.cookie);
  assert.match(key.data.publicKey, /^[A-Za-z0-9_-]{87}$/);
  const invalid = await request('/api/account/push-subscriptions', 'POST', { endpoint: 'https://localhost/private' }, signup.cookie);
  assert.equal(invalid.status, 400);
});
