import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { shippingStage, periodStart, selectedOrders, verifiedOrderSpend, dashboardTotals, dashboardProducts, dashboardActivity } from '../public/app-dashboard-data.js';
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
      vm.runInNewContext(header + ';renderSetupChecklist();', { document, ADMIN_CUSTOMER_PREVIEW_MODE: false, state: { customer: {}, customerChecklist: [{ complete }] } });
      assert.equal(panel.hidden, complete || view !== 'profile', `${view}, complete=${complete}`);
    }
  }
});
test('app data includes orders beyond the legacy 20-item carousel limit', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function buildSuccessSummary(');
  const end = source.indexOf('/* -------------------------------------------------------', start);
  const orders = Array.from({ length: 35 }, (_, i) => ({ id: i, checkoutAt: now.toISOString(), itemCount: 1, orderTotal: 10 }));
  const sandbox = { safeSuccessCheckout: r => r, confirmedDiscordPurchase: r => !/cancel|review_hold|unverified/i.test(String(r.status || "")), successDateKey: date => date.slice(0, 10), buildSuccessActivity: () => [], orders };
  vm.runInNewContext(source.slice(start, end) + ';legacy = buildSuccessSummary(orders); app = buildSuccessSummary(orders,null,null,true);', sandbox);
  assert.equal(sandbox.legacy.recentCheckouts.length, 20);
  assert.equal(sandbox.legacy.checkouts, undefined);
  assert.equal(sandbox.app.checkouts.length, 35);
});
test('24 hours is rolling and YTD includes January while excluding future and cancelled orders', () => {
  const orders = ['2026-10-06T11:59:59Z','2026-10-06T12:00:00Z','2026-10-07T11:00:00Z','2026-01-01T12:00:00Z','2025-12-31T12:00:00Z','2026-10-08T00:00:00Z'].map((checkoutAt,i) => ({id:i,checkoutAt,status:'confirmed',orderTotal:10}));
  assert.equal(selectedOrders(orders,1,now).length,2);
  assert.equal(selectedOrders(orders,'ytd',now).length,4);
  for (const period of [1,'ytd']) {
    const records = selectedOrders(orders,period,now);
    assert.equal(dashboardActivity(records,period,now).reduce((sum,b) => sum+b.count,0),records.length);
  }
});
test('popup deduplication survives reloads and is scoped to customer and meaningful content', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const segment = source.slice(source.indexOf('const shownCustomerNotifications'),source.indexOf('function showCustomerNotificationPopup('));
  const saved = new Map();
  const sandbox = {state:{customer:{id:'a'}},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)}};
  const note = {id:'one',kind:'missing_info',message:'Add address',missingItems:['Address']};
  sandbox.note=note;vm.runInNewContext(segment+';first=claimCustomerNotification(note);second=claimCustomerNotification({...note,updatedAt:"changed"});',sandbox);
  assert.equal(sandbox.first,true);assert.equal(sandbox.second,false);
  const reloaded={...sandbox};vm.runInNewContext(segment+';again=claimCustomerNotification(note);',reloaded);assert.equal(reloaded.again,false);
  sandbox.state.customer.id='b';vm.runInNewContext('other=claimCustomerNotification(note);',sandbox);assert.equal(sandbox.other,true);
  sandbox.note={...note,message:'Add card'};vm.runInNewContext('changed=claimCustomerNotification(note);',sandbox);assert.equal(sandbox.changed,true);
});

test('green orders count as purchased; orange review holds and red cancellations are excluded from tracker metrics', () => {
  const records = [
    {id:'confirmed',checkoutAt:now.toISOString(),status:'confirmed',itemCount:2,orderTotal:39.98,orderTotalKnown:true,items:[{name:'Trading card pack',quantity:2,price:19.99}]},
    {id:'hold',checkoutAt:now.toISOString(),status:'review_hold',itemCount:2,orderTotal:39.98,items:[{name:'Trading card pack',quantity:2,price:19.99}]},
    {id:'cancel',checkoutAt:now.toISOString(),status:'cancelled',itemCount:2,orderTotal:39.98}
  ];
  assert.equal(shippingStage(records[1]),'review_hold');
  const confirmed=selectedOrders(records,1,now);
  assert.deepEqual(confirmed.map(x=>x.id),['confirmed']);
  assert.equal(dashboardTotals(confirmed).orders,1);
  assert.equal(dashboardTotals(confirmed).items,2);
  assert.equal(dashboardTotals(confirmed).spend,39.98);
});


test('customer spending requires verified paid evidence, not legacy subtotals', () => {
  const base={checkoutAt:now.toISOString(),retailer:'Target',status:'confirmed',itemCount:1};
  assert.equal(verifiedOrderSpend({...base,orderTotal:99.00}),0);
  assert.equal(verifiedOrderSpend({...base,orderTotal:99.00,orderTotalBasis:'item_subtotal'}),0);
  assert.equal(verifiedOrderSpend({...base,orderTotal:99.00,orderTotalKnown:false,orderTotalBasis:'retailer_receipt'}),0);
  assert.equal(verifiedOrderSpend({...base,orderTotal:105.56,orderTotalKnown:true}),105.56);
  assert.equal(verifiedOrderSpend({...base,orderTotal:105.56,orderTotalBasis:'retailer_receipt'}),105.56);
  assert.equal(verifiedOrderSpend({...base,orderTotal:105.56,priceSource:'admin_verified_retailer_receipt'}),105.56);
  assert.equal(dashboardTotals([
    {...base,orderTotal:105.56,orderTotalKnown:true},
    {...base,orderTotal:99.00,orderTotalBasis:'item_subtotal'}
  ]).spend,105.56);
});

test('customer 24H, 7D, 30D, 90D, MTD, YTD and lifetime filters agree with activity totals', () => {
  const date=new Date('2026-10-09T12:00:00');
  const at=(iso)=>({checkoutAt:iso,status:'confirmed',orderTotal:12.34,orderTotalKnown:true,items:[]});
  const rows=[
    at(new Date(date.getTime()-3600000).toISOString()),
    at(new Date(date.getTime()-3*86400000).toISOString()),
    at(new Date(date.getTime()-20*86400000).toISOString()),
    at(new Date(date.getTime()-80*86400000).toISOString()),
    at(new Date(date.getTime()-180*86400000).toISOString()),
    at(new Date(date.getTime()-450*86400000).toISOString()),
    {...at(date.toISOString()),orderTotalKnown:false,orderTotal:9999},
    {...at(date.toISOString()),status:'cancelled'}
  ];
  const expected=new Map([[1,2],[7,3],[30,4],[90,5],['mtd',3],['ytd',6],['all',7]]);
  assert.equal(periodStart('mtd',date).getTime(),new Date(date.getFullYear(),date.getMonth(),1).getTime());
  assert.equal(periodStart('ytd',date).getTime(),new Date(date.getFullYear(),0,1).getTime());
  assert.equal(periodStart('all',date).getTime(),0);
  assert.equal(periodStart(7,date).getTime(),date.getTime()-7*86400000);
  for(const [period,count] of expected){
    const selected=selectedOrders(rows,period,date);
    assert.equal(selected.length,count,String(period));
    const bars=dashboardActivity(selected,period,date);
    assert.ok(bars.length<=30,String(period));
    assert.equal(bars.reduce((n,bar)=>n+bar.count,0),selected.length,String(period));
    const values=Math.round(bars.reduce((n,bar)=>n+bar.value,0)*100);
    assert.equal(values,Math.round(dashboardTotals(selected).spend*100),String(period));
  }
  const source=readFileSync(new URL('../public/app-dashboard.js',import.meta.url),'utf8');
  assert.match(source,/\[1,7,30,90,'ytd','all'\]/);
  assert.match(source,/\^\(ytd\|all\)\$/);
  const css=readFileSync(new URL('../public/sng-controls.css',import.meta.url),'utf8');
  assert.match(css,/\.app-dashboard \.sng-range \{\s*display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
});
