import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { shippingStage, selectedOrders, dashboardTotals, dashboardProducts, dashboardActivity } from '../public/app-dashboard-data.js';
import { buildDemoData } from '../app-demo.js';
const now = new Date('2026-10-07T12:00:00Z');

test('app totals and products use real quantities, prices and delivery stages', () => {
  const orders = selectedOrders(buildDemoData(now).checkouts, 30, now);
  assert.deepEqual(dashboardTotals(orders), { orders: 6, items: 12, spend: 459.88, transit: 3, delivered: 2, awaiting: 1 });
  const products = dashboardProducts(orders);
  assert.equal(products.length, 3);
  assert.equal(products.reduce((n, p) => n + p.quantity, 0), 12);
  assert.equal(products.reduce((n, p) => n + p.delivered, 0), 5);
  assert.equal(Math.round(products.reduce((n, p) => n + p.value, 0) * 100), 45988);
  assert.equal(shippingStage({ status: 'cancelled', shipping: { status: 'delivered' } }), 'cancelled');
});
test('date filters and chart buckets retain totals and exclude cancelled orders', () => {
  const orders = buildDemoData(now).checkouts;
  orders.push({ ...orders[0], id: 'cancelled', status: 'cancelled' });
  const week = selectedOrders(orders, 7, now);
  assert.equal(week.length, 4);
  for (const days of [7, 30, 90, 180]) {
    const records = selectedOrders(orders, days, now), bars = dashboardActivity(records, days, now);
    assert.ok(bars.length <= 30);
    assert.equal(bars.reduce((n, bar) => n + bar.count, 0), records.length);
    assert.equal(Math.round(bars.reduce((n, bar) => n + bar.value, 0) * 100), Math.round(dashboardTotals(records).spend * 100));
  }
});
test('complete checklists stay hidden; incomplete app checklist appears only in Profile', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderSetupChecklist()');
  const header = source.slice(start, source.indexOf('  const complete =', start)) + '\n}';
  for (const view of ['home', 'tracking', 'notifications', 'products', 'history', 'profile']) {
    for (const complete of [true, false]) {
      const panel = {};
      const document = { body: { classList: { contains: () => true }, dataset: { appView: view } },
        getElementById: id => id === 'setup-checklist-panel' ? panel : { classList: { contains: () => true } } };
      vm.runInNewContext(header + ';renderSetupChecklist();', { document, state: { customer: {}, customerChecklist: [{ complete }] } });
      assert.equal(panel.hidden, complete || view !== 'profile', `${view}, complete=${complete}`);
    }
  }
});
test('app data includes orders beyond the legacy 20-item carousel limit', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function buildSuccessSummary(');
  const end = source.indexOf('/* -------------------------------------------------------', start);
  const orders = Array.from({ length: 35 }, (_, i) => ({ id: i, checkoutAt: now.toISOString(), itemCount: 1, orderTotal: 10 }));
  const sandbox = { safeSuccessCheckout: r => r, successDateKey: date => date.slice(0, 10), buildSuccessActivity: () => [], orders };
  vm.runInNewContext(source.slice(start, end) + ';legacy = buildSuccessSummary(orders); app = buildSuccessSummary(orders,null,null,true);', sandbox);
  assert.equal(sandbox.legacy.recentCheckouts.length, 20);
  assert.equal(sandbox.legacy.checkouts, undefined);
  assert.equal(sandbox.app.checkouts.length, 35);
});
