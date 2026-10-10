import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const adminPage = read('public/admin-app.html');
const customerPage = read('public/index.html');
const theme = read('public/mobile-reference-theme.css');
const mobileScript = read('public/admin-mobile.js');

test('reference theme loads after legacy controls without changing customer data flow', () => {
  const adminControls = adminPage.indexOf('/sng-premium-controls.css?v=2');
  const adminTheme = adminPage.indexOf('/mobile-reference-theme.css?v=20261010');
  const customerControls = customerPage.indexOf('/app-ui-uniform.css?v=20261010');
  const customerTheme = customerPage.indexOf('/mobile-reference-theme.css?v=20261010');
  assert.ok(adminControls !== -1 && adminTheme > adminControls);
  assert.ok(customerControls !== -1 && customerTheme > customerControls);
  assert.match(customerPage, /src="\/app-dashboard\.js\?v=2"/);
  assert.match(adminPage, /src="\/admin-mobile\.js\?v=23-ref-20261010"/);
  assert.match(theme, /html\[data-admin-mobile-theme="light"\]/);
  assert.match(theme, /body\.app-dashboard\.app-signed-in\[data-app-theme="day"\]/);
  assert.match(theme, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(theme, /#tabs\[hidden\]\s*\{display:none!important;\}/);
});

test('Admin app navigation has five accessible real tabs with app usage in More', () => {
  const nav = adminPage.match(/<nav id="tabs"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(nav, 'the installed Admin PWA has bottom navigation');
  const ids = [...nav.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids, ['overview', 'success', 'customers', 'profiles', 'more']);
  assert.equal((nav.match(/<svg /g) || []).length, 5);
  assert.match(nav, /aria-label="Home"/);
  assert.match(nav, /aria-label="More"/);
  assert.match(mobileScript, /id="open-admin-usage"/);
  assert.match(mobileScript, /id="admin-more-return"/);
  assert.match(mobileScript, /tab==="usage"\?"more":tab/);
  assert.match(theme, /\.admin-overview-hero\s*\{/);
  assert.match(theme, /\.admin-spend-hero\s*\{/);
});

test('Admin overview reads real community totals and itemized latest orders; More navigation works', async () => {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const listeners = new Map();
      nodes.set(id, {
        id, hidden: false, textContent: '', innerHTML: '', value: '', listeners,
        classList: { toggle() {} },
        addEventListener(event, callback) { listeners.set(event, callback); },
        querySelectorAll() { return []; },
        querySelector() { return null; },
      });
    }
    return nodes.get(id);
  }
  const fixtures = {
    '/api/admin/submissions': { submissions: [{profile:{firstName:'Jill'}}] },
    '/api/admin/profile-activation-tracker': { customers:[] },
    '/api/managed-availability': {},
    '/api/admin/app-usage': {activeUsers7d:3, installedDevices:7},
    '/api/admin/success-overview': {
      communityTotals:{totalCheckouts:55,totalSpent:4876.54},
      historicalSummary:{historicalCheckouts:50,historicalSpent:4000},
      communityRecords:[{retailer:'Target',checkoutAt:'2026-10-10T12:00:00Z',
        orderTotalKnown:true,orderTotal:48.99,items:[{name:'Trading card bundle',quantity:2}]}]
    }
  };
  const scope = {
    document: { hidden:false,activeElement:null,getElementById:node,querySelectorAll(){return [];},addEventListener(){} },
    window: {scrollX:0,scrollY:0,scrollTo(){},addEventListener(){}},
    navigator: {}, location: {assign(){}}, Date, Intl,
    fetch: async path => ({status:200,ok:true,json:async() => fixtures[path] || {}}),
    EventSource: class {addEventListener(){}close(){}},
    setTimeout(){return 1;},clearTimeout(){},setInterval(){return 2;},
    requestAnimationFrame(cb){cb();}, alert(){}, console
  };
  vm.runInNewContext(mobileScript, scope, {filename:'admin-mobile.js',timeout:2500});
  for (let i=0; i<7; i++) await new Promise(resolve => setImmediate(resolve));
  assert.match(node('content').innerHTML, /\$4,876\.54/);
  assert.match(node('content').innerHTML, /55/);
  assert.match(node('content').innerHTML, /Trading card bundle/);
  assert.match(node('content').innerHTML, /Recent confirmed checkouts/);
  assert.match(node('content').innerHTML, /Reported total/);
  const navClick = node('tabs').listeners.get('click');
  navClick({target:{closest:() => ({dataset:{tab:'more'}})}});
  assert.match(node('content').innerHTML, /VIEW APP USAGE/);
  assert.equal(typeof node('open-admin-usage').onclick, 'function');
  node('open-admin-usage').onclick();
  assert.equal(node('heading').textContent, 'App Usage');
  assert.match(node('content').innerHTML, /7/);
  node('admin-more-return').onclick();
  assert.equal(node('heading').textContent, 'More');
  assert.match(node('content').innerHTML, /SET UP FACE ID/);
});
