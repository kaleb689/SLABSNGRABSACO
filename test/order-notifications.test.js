import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOrderNotifications, orderEvents, validPushSubscription } from '../order-notifications.js';
const order = (id = 'one', overrides = {}) => ({ id, customerAccountId: 'a', retailer: 'Target', orderNumber: id, status: 'confirmed', ...overrides });
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } };
async function fixture(t, original = []) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sng-alerts-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const f = { records: original, accounts: [{ id: 'a', notifications: [] }, { id: 'b', notifications: [] }], sent: [], memberships: [] };
  f.options = { dataDir, baseUrl: 'https://slabsngrabsaco.com', getRecords: async () => f.records, getAccounts: async () => f.accounts,
    getAccountUpdates: async () => f.memberships, sendPush: async (sub, payload) => f.sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }) };
  f.service = createOrderNotifications(f.options); await f.service.initialize();
  return f;
}
test('demo pushes reach only demo subscribers and respect notification categories', async t => {
  const f = await fixture(t);
  await f.service.subscribe('a', subscription);
  const demoSubscription = { ...subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/demo' };
  await f.service.subscribe('APP-DEMO-CUSTOMER', demoSubscription);
  const note = { id: 'demo-note', kind: 'order_confirmed', title: 'Demo order', message: 'Sample only.' };
  await assert.rejects(f.service.sendDemoNotification('a', note));
  assert.equal((await f.service.sendDemoNotification('APP-DEMO-CUSTOMER', note)).sent, 1);
  assert.equal(f.sent[0].endpoint, demoSubscription.endpoint);
  assert.equal((await f.service.list('a')).length, 0);
  await f.service.setPreferences('APP-DEMO-CUSTOMER', { orders: false });
  assert.equal((await f.service.sendDemoNotification('APP-DEMO-CUSTOMER', note)).sent, 0);
  assert.equal(f.sent.length, 1);
});
test('cancelled orders and non-successful attempts never create alerts', () => {
  for (const override of [{ status: 'cancelled' }, { status: 'canceled' }, { cancelledAt: 'today' }, { status: 'pending' }, { status: 'failed' }]) {
    assert.deepEqual(orderEvents(order('one', { ...override, shipping: { status: 'shipped' } })), []);
  }
});
test('push endpoint validation rejects arbitrary URLs and deceptive provider domains', () => {
  assert.equal(validPushSubscription(subscription), true);
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.test/x', 'https://127.0.0.1/x', 'https://web.push.apple.com@evil.test/x', 'https://web.push.apple.com:8080/x']) {
    assert.equal(validPushSubscription({ ...subscription, endpoint }), false);
  }
});
test('rollout does not replay history; new orders notify only their owner and deduplicate after restart', async t => {
  const f = await fixture(t, [order('old')]);
  await f.service.subscribe('a', subscription);
  await f.service.tick(); assert.equal(f.sent.length, 0);
  f.records.push(order('new')); await f.service.tick();
  assert.equal(f.sent.length, 1); assert.equal((await f.service.list('b')).length, 0);
  await f.service.tick(); assert.equal(f.sent.length, 1);
  f.service = createOrderNotifications(f.options); await f.service.initialize(); await f.service.tick();
  assert.equal(f.sent.length, 1);
});
test('shipping status and delivery date updates notify once; timestamps alone do not', async t => {
  const f = await fixture(t, [order()]); await f.service.subscribe('a', subscription);
  f.records[0].shipping = { status: 'shipped', updatedAt: 'one', estimatedDelivery: 'Friday' }; await f.service.tick();
  f.records[0].shipping.updatedAt = 'two'; await f.service.tick(); assert.equal(f.sent.length, 1);
  f.records[0].shipping.estimatedDelivery = 'Saturday'; await f.service.tick(); assert.equal(f.sent.length, 2);
  f.records[0].shipping.status = 'delivered'; await f.service.tick(); assert.equal(f.sent.length, 3);
});
test('cancellation suppresses queued alerts before delivery and removes its inbox alerts', async t => {
  const f = await fixture(t); await f.service.subscribe('a', subscription);
  f.records.push(order()); await f.service.reconcile(f.records);
  f.records[0].status = 'cancelled'; await f.service.tick();
  assert.equal(f.sent.length, 0); assert.equal((await f.service.list('a')).length, 0);
});
test('preferences suppress selected categories while owner messages and account changes work', async t => {
  const f = await fixture(t); await f.service.subscribe('a', subscription);
  await f.service.setPreferences('a', { orders: false, shipping: false });
  f.records.push(order('new', { shipping: { status: 'shipped' } })); await f.service.tick(); assert.equal(f.sent.length, 0);
  f.accounts[0].notifications.push({ id: 'admin', kind: 'admin_message', title: 'Info needed', message: 'Please complete your profile.', createdAt: new Date().toISOString() });
  await f.service.tick(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].tab, 'notifications');
  f.memberships.push({ id: 'membership', customerAccountId: 'a', status: 'active', plan: { tier: 'ultimate' } });
  await f.service.tick(); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].tab, 'membership');
  await f.service.tick(); assert.equal(f.sent.length, 2);
});
test('shared-device subscriptions change owner and logout removes pending deliveries', async t => {
  const f = await fixture(t); await f.service.subscribe('a', subscription); await f.service.subscribe('b', subscription);
  f.records.push(order('a-order')); await f.service.tick(); assert.equal(f.sent.length, 0);
  f.records.push(order('b-order', { customerAccountId: 'b' })); await f.service.reconcile(f.records);
  await f.service.unsubscribe('b', subscription.endpoint); await f.service.tick(); assert.equal(f.sent.length, 0);
});

test('an order first seen pending alerts when confirmation arrives', async t => {
  const f = await fixture(t, [order('pending', { status: 'pending' })]);
  await f.service.subscribe('a', subscription);
  await f.service.tick(); assert.equal(f.sent.length, 0);
  f.records[0].status = 'confirmed'; await f.service.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].title, 'Target order confirmed');
  await f.service.tick(); assert.equal(f.sent.length, 1);
});
test('Action Needed pushes ignore timestamp churn and notify only on content changes, including after restart', async t => {
  const f = await fixture(t); await f.service.subscribe('a',subscription);
  const note={id:'action',kind:'missing_info',title:'Action Needed',message:'Add address',missingItems:['Address'],updatedAt:'one'};
  f.accounts[0].notifications.push(note);await f.service.tick();assert.equal(f.sent.length,1);
  note.updatedAt='two';await f.service.tick();assert.equal(f.sent.length,1);
  f.service=createOrderNotifications(f.options);await f.service.initialize();note.updatedAt='three';await f.service.tick();assert.equal(f.sent.length,1);
  note.message='Add payment card';note.missingItems=['Card'];await f.service.tick();assert.equal(f.sent.length,2);
});

test('entering a verified retailer order number does not send a second checkout alert', async t => {
  const f = await fixture(t, [order('discord-order', { orderNumber: '', checkoutAt: new Date().toISOString() })]);
  await f.service.subscribe('a', subscription);
  f.records[0].orderNumber = 'T-12345678';
  await f.service.tick();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.service.list('a')).length, 0);
});

test('matching a historical checkout cannot send stale new-order confirmations', async t => {
  const f = await fixture(t);
  await f.service.subscribe('a', subscription);
  f.records.push(order('old-webhook', { checkoutAt: '2026-01-01T00:00:00Z' }));
  await f.service.tick();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.service.list('a')).length, 0);
});

test('upgrading a historical order to shipped can still notify once for a new actual shipment', async t => {
  const f = await fixture(t);
  await f.service.subscribe('a', subscription);
  f.records.push(order('historic-shipped', {
    checkoutAt: '2026-01-01T00:00:00Z',
    shipping: { status: 'shipped', updatedAt: new Date().toISOString() }
  }));
  await f.service.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].title, 'Target order shipped');
});

test('one-time notification migration removes historical email-derived order alerts only', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sng-alert-cleanup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'app-order-notifications.json'), JSON.stringify({
    snapshots: { 'fake:retailer:order': { eligible: true } },
    inbox: { a: [
      { id: 'fake', kind: 'order_confirmed', title: 'Unverified order' },
      { id: 'legit-note', kind: 'admin_message', title: 'Admin notice' }
    ] },
    subscriptions: {}, outbox: [
      { accountId: 'a', key: 'fake:retailer:order', notification: { kind: 'order_confirmed' } }
    ],
    accountEvents: { a: { notices: {}, verified: false, disabled: false } },
    memberships: {}
  }));
  const service = createOrderNotifications({
    dataDir: dir, baseUrl: 'https://slabsngrabsaco.com',
    getRecords: async () => [order('one')], getAccounts: async () => [{ id: 'a', notifications: [] }],
    getAccountUpdates: async () => [], sendPush: async () => {}
  });
  await service.initialize();
  assert.deepEqual((await service.list('a')).map(x => x.title), ['Admin notice']);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'app-order-notifications.json')));
  assert.equal(saved.outbox.length, 0);
  assert.equal(Object.keys(saved.snapshots).length, 1);
  assert.equal(saved.webhookOnlyNotificationsVersion, 1);
});

test('quickly cancelled checkout under 24 hours is absent from inbox and sends no cancellation push', async t => {
  const placed = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const f = await fixture(t, [order('quick-cancel', { checkoutAt: placed })]);
  await f.service.subscribe('a', subscription);
  f.records[0].status = 'cancelled';
  f.records[0].cancelledAt = new Date().toISOString();
  await f.service.tick();
  await f.service.tick();
  assert.equal((await f.service.list('a')).length, 0);
  assert.equal(f.sent.length, 0);
});

test('a verified checkout cancelled after 24 hours notifies its owner once, including after restart', async t => {
  const checkoutAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const f = await fixture(t, [order('late-cancel', { checkoutAt })]);
  await f.service.subscribe('a', subscription);
  f.records[0].status = 'cancelled';
  f.records[0].cancelledAt = new Date().toISOString();
  await f.service.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].title, 'Target order cancelled');
  assert.equal((await f.service.list('a')).filter(n => n.kind === 'order_cancelled').length, 1);
  assert.equal((await f.service.list('b')).length, 0);
  await f.service.tick();
  f.service = createOrderNotifications(f.options);
  await f.service.initialize();
  await f.service.tick();
  assert.equal(f.sent.length, 1);
});

test('late cancel removes queued success alerts but leaves one cancel notification', async t => {
  const checkoutAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const f = await fixture(t);
  await f.service.subscribe('a', subscription);
  f.records.push(order('cancel-after-confirmed', { checkoutAt }));
  await f.service.reconcile(f.records);
  assert.equal((await f.service.list('a')).filter(n => n.kind === 'order_confirmed').length, 0,
    'historic checkout must not generate a confirmation alert');
  f.records[0].status = 'cancelled';
  f.records[0].cancelledAt = new Date().toISOString();
  await f.service.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].title, 'Target order cancelled');
});

test('orange Shikari review hold notifies as provisional, not confirmed, and later green sends one confirmation', async t => {
  const f = await fixture(t);
  await f.service.subscribe('a', subscription);
  f.records.push(order('review-hold', {checkoutAt: new Date().toISOString(), status:'review_hold',
    itemCount:2, orderTotal:0, orderTotalBasis:'unknown'}));
  await f.service.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].title, 'Target order on review hold');
  assert.match(f.sent[0].body,/may still cancel/i);
  assert.equal((await f.service.list('a')).filter(x=>x.kind==='order_confirmed').length, 0);
  await f.service.tick();
  assert.equal(f.sent.length, 1);
  f.records[0].status='confirmed';
  await f.service.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].title, 'Target order confirmed');
  await f.service.tick();
  assert.equal(f.sent.length, 2);
});

test('red cancellation 24+ hours after orange review shows one cancelled alert, no fake confirmation', async t => {
  const f = await fixture(t);
  await f.service.subscribe('a', subscription);
  f.records.push(order('held-old', {
    status: 'review_hold',
    checkoutAt: new Date(Date.now()-27*3600000).toISOString()
  }));
  await f.service.tick();
  assert.equal(f.sent.length, 0, 'historical holds never flood push alerts');
  f.records[0].status='cancelled';
  f.records[0].cancelledAt=new Date().toISOString();
  await f.service.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].title, 'Target order cancelled');
  assert.equal((await f.service.list('a')).filter(x=>x.kind==='order_confirmed').length,0);
});
