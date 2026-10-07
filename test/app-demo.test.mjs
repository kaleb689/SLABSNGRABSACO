import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { buildDemoData, demoSuccess, demoAccount, demoLogin, DEMO_ID, createDemoMiddleware } from '../app-demo.js';

async function fixture(t) {
  const app = express(), sent = [], calls = { rateLimit: 0, verified: 0 };
  app.use(express.json());
  app.use(createDemoMiddleware({
    authenticate: async req => req.headers.cookie === 'demo-session' ? demoAccount() : null,
    verifyPassword: async (password, account) => { calls.verified++; assert.equal(account.passwordHash, demoLogin.passwordHash); return password === 'correct-demo-password'; },
    setSession: res => res.set('Set-Cookie', 'demo-session'), clearSession: res => res.set('Set-Cookie', 'expired'),
    loginRateLimit: (_req, _res, next) => { calls.rateLimit++; next(); },
    sendTestNotification: async (id, notification) => { sent.push({ id, notification }); return { sent: 1 }; }
  }));
  app.use((_req, res) => res.status(404).json({ normalRoute: true }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { demo = true, method = 'GET', body } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(demo ? { Cookie: 'demo-session' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  return { request, sent, calls };
}

test('sample records are complete, distinct from production and cover shipping stages', () => {
  const d = buildDemoData(new Date('2026-10-07T12:00:00Z'));
  assert.equal(d.profiles.length, 100);
  assert.equal(d.membership.activationStatus, 'activated');
  assert.equal(d.address.zip, '10001'); assert.equal(d.card.acoCardNumber, '4242424242424242');
  assert.equal(d.account.checkoutOnboardingComplete, true);
  assert.ok(d.profiles.every(p => p.readiness.ready && p.activationStatus === 'activated' && p.customerCard && p.customerProfile));
  assert.deepEqual(new Set(d.checkouts.map(r => r.shipping.status)), new Set(['awaiting_shipment', 'shipped', 'in_transit', 'out_for_delivery', 'delivered']));
  assert.ok(d.checkouts.every(r => r.customerAccountId === DEMO_ID && r.orderNumber.startsWith('DEMO-')));
  const summary = demoSuccess(d).summary;
  assert.equal(summary.totalCheckouts, 6); assert.equal(summary.totalItems, 12);
  assert.equal(summary.checkoutValue, 459.88);
  assert.equal(demoSuccess(d, { start: '2026-10-07', end: '2026-10-07' }).summary.totalCheckouts, 1);
});

test('demo login verifies password and uses normal rate limit before issuing session', async t => {
  const f = await fixture(t);
  const wrong = await f.request('/api/account/login', { demo: false, method: 'POST', body: { email: demoLogin.email, password: 'wrong' } });
  assert.equal(wrong.status, 401); assert.equal(wrong.headers.get('set-cookie'), null);
  const right = await f.request('/api/account/login', { demo: false, method: 'POST', body: { email: demoLogin.email.toUpperCase(), password: 'correct-demo-password' } });
  assert.equal(right.status, 200); assert.equal(right.data.account.demo, true);
  assert.equal(right.headers.get('set-cookie'), 'demo-session');
  assert.equal(right.data.account.passwordHash, undefined);
  assert.equal(f.calls.rateLimit, 2); assert.equal(f.calls.verified, 2);
  assert.equal((await f.request('/api/account/register', { demo: false, method: 'POST', body: { email: demoLogin.email } })).status, 409);
});

test('all account tabs load only for authenticated demo; purchases and edits cannot reach normal routes', async t => {
  const f = await fixture(t);
  for (const path of ['/api/my-profile', '/api/account/session', '/api/account/saved-details', '/api/account/imap-credentials', '/api/account/retailer-profiles', '/api/account/free-memberships', '/api/account/rented-memberships', '/api/account/notifications', '/api/account/success']) {
    assert.equal((await f.request(path)).status, 200, path);
    assert.equal((await f.request(path, { demo: false })).status, 404, path);
  }
  for (const path of ['/api/create-checkout-session', '/api/create-rental-checkout-session', '/api/account/retailer-profiles/1', '/api/account/discord-link', '/api/account/change-password']) {
    const result = await f.request(path, { method: 'POST', body: {} });
    assert.equal(result.status, 403); assert.equal(result.data.normalRoute, undefined);
  }
  assert.equal((await f.request('/api/account/push-preferences')).data.normalRoute, true);
  assert.equal((await f.request('/api/account/logout', { method: 'POST' })).headers.get('set-cookie'), 'expired');
});

test('demo simulation adds an order and changes shipping without touching other customers', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/account/success')).data.summary.totalCheckouts, 6);
  await f.request('/api/account/demo/simulate', { method: 'POST', body: { event: 'order' } });
  const updated = await f.request('/api/account/success');
  assert.equal(updated.data.summary.totalCheckouts, 7);
  await f.request('/api/account/demo/simulate', { method: 'POST', body: { event: 'shipping' } });
  assert.equal((await f.request('/api/account/success')).data.recentCheckouts[0].shipping.status, 'shipped');
  assert.equal(f.sent.length, 2); assert.ok(f.sent.every(note => note.id === DEMO_ID));
  assert.equal((await f.request('/api/account/demo/simulate', { demo: false, method: 'POST', body: { event: 'order' } })).status, 404);
  assert.equal((await f.request('/api/account/demo/simulate', { method: 'POST', body: { event: 'bad' } })).status, 400);
  const notes = (await f.request('/api/account/notifications')).data.notifications;
  assert.equal(notes.length, 6);
});
