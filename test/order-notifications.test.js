import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOrderNotifications, orderEvents, validPushSubscription } from '../order-notifications.js';
const order = (id = 'one', overrides = {}) => ({ id, customerAccountId: 'a', retailer: 'Target', orderNumber: id, status: 'confirmed', ...overrides });
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } };
test('a newly linked preorder notifies only its owner once; cancellation retracts queued confirmation', async t => {
  const f = await fixture(t);
  await f.service.subscribe('a', subscription);
  await f.service.subscribe('b', {...subscription,endpoint:subscription.endpoint+'-other'});
  const preorder=order('preorder',{checkoutAt:new Date().toISOString(),orderTotal:79.98,orderTotalBasis:'item_subtotal',items:[{name:'Preorder pack',quantity:2,price:39.99}]});
  f.records=[{...preorder,customerAccountId:null}];
  await f.service.tick();assert.equal(f.sent.length,0);
  f.records=[preorder];await f.service.tick();await f.service.tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].endpoint,subscription.endpoint);
  assert.equal((await f.service.list('a')).filter(n=>n.kind==='order_confirmed').length,1);
  assert.equal((await f.service.list('b')).length,0);
  const another=order('cancel-before-push',{checkoutAt:new Date().toISOString()});
  f.records.push(another);await f.service.reconcile(f.records);
  f.records[1]={...another,status:'cancelled',cancelledAt:new Date().toISOString()};
  await f.service.tick();assert.equal(f.sent.length,1);
  assert.equal((await f.service.list('a')).some(n=>n.orderKey?.endsWith(':cancel-before-push')),false);
});
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
test('shipping alerts send once per order stage; ETA edits update tracking without another alert', async t => {
  const f = await fixture(t, [order()]); await f.service.subscribe('a', subscription);
  f.records[0].shipping = { status: 'shipped', updatedAt: 'one', estimatedDelivery: 'Friday' }; await f.service.tick();
  f.records[0].shipping.updatedAt = 'two'; await f.service.tick(); assert.equal(f.sent.length, 1);
  f.records[0].shipping.estimatedDelivery = 'Saturday'; await f.service.tick(); assert.equal(f.sent.length, 1);
  f.records[0].shipping.status = 'delivered'; await f.service.tick(); assert.equal(f.sent.length, 2);
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

test('changing an old green order to an orange review hold removes its stale confirmation notice', async t => {
  const f = await fixture(t, [order('color-change', {checkoutAt:new Date().toISOString(),status:'confirmed'})]);
  await f.service.subscribe('a',subscription);
  f.records[0].status='review_hold';
  await f.service.tick();
  const pending = await f.service.list('a');
  assert.equal(pending.filter(x => x.kind==='order_confirmed').length,0);
  assert.equal(pending.filter(x => x.kind==='order_review_hold').length,1);
  assert.equal(f.sent.length,1);
  f.records[0].status='unverified';
  await f.service.tick();
  assert.equal((await f.service.list('a')).some(x =>
    ['order_confirmed','order_review_hold','shipping_update'].includes(x.kind)),false);
  await f.service.tick();
  assert.equal(f.sent.length,1);
});


test('retailer SKU announcements use app push first and Discord fallback without duplicates', async t => {
  const f = await fixture(t);
  await f.service.subscribe('a', subscription);
  await f.service.syncRetailerRoles('a',['target']);
  await f.service.syncRetailerRoles('b',['target']);
  const event = {
    kind: 'drop_skus_updated', retailer:'target', title: 'Target drop SKUs updated',
    message: '2 SKUs available. Choose your products.', tab: 'drops'
  };
  const first = await f.service.notifyDropUpdate(['a', 'b', 'a'], event, 'drop:target:post:version-a');
  assert.deepEqual(first.pushAccountIds, ['a']);
  assert.deepEqual(first.dmAccountIds, ['b']);
  assert.equal((await f.service.list('a')).length, 1);
  assert.equal((await f.service.list('b')).length, 1);
  await f.service.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].tab, 'drops');
  assert.equal(f.sent[0].title, event.title);

  // A duplicate gateway message or Render restart cannot notify twice.
  assert.deepEqual(await f.service.notifyDropUpdate(['a', 'b'], event, 'drop:target:post:version-a'),
    { pushAccountIds: [], dmAccountIds: [] });
  f.service = createOrderNotifications(f.options);
  await f.service.initialize();
  assert.deepEqual(await f.service.notifyDropUpdate(['a', 'b'], event, 'drop:target:post:version-a'),
    { pushAccountIds: [], dmAccountIds: [] });
  await f.service.tick();
  assert.equal(f.sent.length, 1);

  // An edited SKU list is a new event, so a new alert is appropriate.
  const next = await f.service.notifyDropUpdate(['a', 'b'], event, 'drop:target:post:version-b');
  assert.deepEqual(next.pushAccountIds, ['a']);
  assert.deepEqual(next.dmAccountIds, ['b']);
  await f.service.tick();
  assert.equal(f.sent.length, 2);
});

test('drop notification preferences silence both push and DM fallback', async t => {
  const f = await fixture(t);
  await f.service.subscribe('a', subscription);
  await f.service.syncRetailerRoles('a',['pokemoncenter']);
  await f.service.syncRetailerRoles('b',['pokemoncenter']);
  await f.service.setPreferences('a', { drops: false });
  await f.service.setPreferences('b', { drops: false });
  const notice = { kind: 'drop_skus_updated', retailer:'pokemoncenter', title: 'PKC SKUs updated', message: 'Choose SKUs', tab: 'drops' };
  const result = await f.service.notifyDropUpdate(['a', 'b'], notice, 'drop:pkc:post:v1');
  assert.deepEqual(result, { pushAccountIds: [], dmAccountIds: [] });
  await f.service.tick();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.service.list('a')).length, 1);
  await assert.rejects(f.service.notifyDropUpdate(['a'], notice, 'account:invalid'), /Invalid/);
});


test('old carrier stages cannot replay Deep Steel shipping pushes or duplicate in-app notices', async t => {
  const f=await fixture(t,[order('deep-steel')]);
  await f.service.subscribe('a',subscription);
  const shipping=f.records[0].shipping={status:'shipped',estimatedDelivery:'Friday'};
  await f.service.tick();
  assert.equal(f.sent.length,1);
  shipping.estimatedDelivery='Saturday';
  await f.service.tick();
  assert.equal(f.sent.length,1);
  shipping.status='in_transit';
  await f.service.tick();
  assert.equal(f.sent.length,2);
  // A stale scan may replay the earlier shipped state. Neither the push
  // provider nor the app inbox should receive a duplicate.
  shipping.status='shipped';
  await f.service.tick();
  assert.equal(f.sent.length,2);
  assert.equal((await f.service.list('a')).filter(e=>e.kind==='shipping_update').length,2);
  shipping.status='delivered';
  await f.service.tick();
  assert.equal(f.sent.length,3);
  f.service=createOrderNotifications(f.options);
  await f.service.initialize();
  await f.service.tick();
  assert.equal(f.sent.length,3);
});

test('ambiguous provider timeout never retries the same customer push on restart',async t=>{
  const f=await fixture(t,[order('historical-baseline')]);
  await f.service.subscribe('a',subscription);
  let calls=0;
  f.options.sendPush=async()=>{calls++;throw Error('Synthetic timeout after remote acceptance');};
  f.service=createOrderNotifications(f.options);
  await f.service.initialize();
  // Baseline an old checkout, then introduce one new distinct checkout.
  f.records.push(order('new-provider-timeout'));
  await f.service.tick();
  assert.equal(calls,1);
  f.service=createOrderNotifications(f.options);
  await f.service.initialize();
  await f.service.tick();
  assert.equal(calls,1);
  assert.equal((await f.service.list('a')).filter(e=>e.kind==='order_confirmed').length,1);
});

test('membership 5/1-day app pushes persist and never replay after restart',async t=>{
  const f=await fixture(t);
  await f.service.subscribe('a',subscription);
  const event={kind:'membership_reminder',title:'Membership renews in 5 days',message:'Upcoming automatic renewal'};
  const key='membership:sub_123:2026-10-27T00:00:00.000Z:renewal:5d';
  const first=await f.service.notifyMembershipReminder('a',event,key);
  assert.equal(first.recorded,true);
  assert.equal(first.pushQueued,true);
  await f.service.tick();assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].tab,'membership');
  assert.equal((await f.service.list('b')).length,0);
  assert.equal((await f.service.list('a')).filter(x=>x.kind==='membership_reminder').length,1);
  assert.equal((await f.service.notifyMembershipReminder('a',event,key)).alreadyQueued,true);
  f.service=createOrderNotifications(f.options);await f.service.initialize();
  assert.equal((await f.service.notifyMembershipReminder('a',event,key)).alreadyQueued,true);
  await f.service.tick();assert.equal(f.sent.length,1);
  const tomorrow=await f.service.notifyMembershipReminder('a',{...event,title:'Renews tomorrow'},
    'membership:sub_123:2026-10-27T00:00:00.000Z:renewal:1d');
  assert.equal(tomorrow.recorded,true);
  await f.service.tick();assert.equal(f.sent.length,2);
});
test('account-notification preference prevents membership reminder pushes without losing inbox',async t=>{
  const f=await fixture(t);await f.service.subscribe('a',subscription);
  await f.service.setPreferences('a',{account:false});
  const result=await f.service.notifyMembershipReminder('a',{
    kind:'membership_reminder',title:'Membership ends soon',message:'Scheduled cancellation'
  },'membership:sub_456:2026-10-27T00:00:00.000Z:cancellation:5d');
  assert.equal(result.recorded,true);assert.equal(result.pushQueued,false);
  await f.service.tick();assert.equal(f.sent.length,0);
  assert.equal((await f.service.list('a')).filter(x=>x.kind==='membership_reminder').length,1);
});
