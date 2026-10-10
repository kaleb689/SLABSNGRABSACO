import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrateDropSkuState, buildDropSkuSubmission, createCustomerDropEditor } from '../public/app-drop-controls.js';

const source = (retailer, channelId, sourceId, products) => ({
  retailer, channelId, sourceId, label: retailer + ' Drop', products
});
const sample = {
  sources: [
    source('target', '100', '200', [
      {sku:'T-123',name:'Target booster bundle'},
      {sku:'T-456',name:'Target collection box'}
    ]),
    source('walmart', '101', '201', [{sku:'W-777',name:'Walmart TCG tin'}]),
    source('pokemon', '102', '202', [{sku:'PKC-1',name:'Pokemon Center ETB'}]),
    source('costco', '103', '203', [{sku:'C-900',name:'Costco bundle'}]),
    source('sams', '104', '204', [{sku:'SAM-55',name:"Sam's Club cards"}])
  ],
  selectedKeys:['100:200:T-123','100:200:T-456','101:201:W-777'],
  optedOutKeys:['103:203'],
  quantity:2,
  savedAt:'2026-10-10T18:27:00Z'
};
const button = (attribute, data={}) => ({
  dataset:data, hasAttribute: prop => prop === attribute
});
const escape = x => String(x ?? '').replace(/[&<>"]/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

test('rehydrates selections, opt-outs and one quantity across all retailers', () => {
  const state=hydrateDropSkuState(sample);
  assert.equal(state.quantity,2);
  assert.deepEqual([...state.entries.get('100:200').selected],['T-123','T-456']);
  assert.equal(state.entries.get('103:203').skip,true);
  const post=buildDropSkuSubmission(state);
  assert.equal(post.quantity,2);
  assert.deepEqual(post.sources[0].skus,['T-123','T-456']);
  assert.deepEqual(post.sources[1].skus,['W-777']);
  assert.deepEqual(post.sources[3].skus,[]);
  assert.equal(post.sources[3].skip,true);
  assert.ok(post.sources.every(s => s.skus.every(sku => typeof sku === 'string')));
  assert.ok(post.sources.every(s => !('quantity' in s)), 'individual SKU quantities forbidden');
});

test('only sources present in Discord are selected; invalid products never materialize', () => {
  const raw={...sample,selectedKeys:['100:200:T-123','100:200:FAKE','999:999:NEW']};
  const post=buildDropSkuSubmission(hydrateDropSkuState(raw));
  assert.deepEqual(post.sources[0].skus,['T-123']);
  assert.equal(post.sources.length,5);
});

test('customer drop page shows five retailers, closable selectors, shared Qty and Submit', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async() => ({ok:true,json:async()=>sample});
  try {
    const editor=createCustomerDropEditor({escape,onUpdate(){}});
    await editor.load();
    const html=editor.render();
    for (const title of ['Target','Walmart','Pokémon Center (PKC)','Costco',"Sam's Club"]) {
      assert.ok(html.includes(title), 'missing retailer '+title);
    }
    for (const text of ['Qty 1','Qty 2','Select all SKUs','Don’t run my account',
      'Submit changes','data-drop-source="100:200"','data-drop-product-sku="T-123"']) {
      assert.ok(html.includes(text), 'missing control '+text);
    }
    assert.match(html,/<details class="sng-drop-source"/);
    assert.match(html,/<summary>/);
    assert.match(html, /ONE QUANTITY FOR ALL SKUs/);
    assert.doesNotMatch(html, /data-drop-qty-per-product/);
  } finally { globalThis.fetch=original; }
});

test('single Qty 1 or 2 applies when customers submit even if several retailers selected', async () => {
  const original=globalThis.fetch;
  const sent=[];
  globalThis.fetch=async(url,options={}) => {
    if (options.method==='POST') {
      sent.push(JSON.parse(options.body));
      return {ok:true,json:async()=>({ok:true,selectedCount:3})};
    }
    return {ok:true,json:async()=>sample};
  };
  try {
    const editor=createCustomerDropEditor({escape,onUpdate(){}});
    await editor.load();
    assert.equal(editor.handleClick(button('data-drop-qty',{dropQty:'1'})),true);
    assert.equal(editor.handleClick(button('data-drop-submit')),true);
    // Wait for both POST and follow-up read to complete.
    for(let i=0;i<5;i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length,1);
    assert.equal(sent[0].quantity,1);
    assert.deepEqual(sent[0].sources[0].skus,['T-123','T-456']);
    assert.deepEqual(sent[0].sources[1].skus,['W-777']);
    assert.ok(sent[0].sources.every(s=>!('quantity' in s)));
  } finally { globalThis.fetch=original; }
});

test('select all and do not run clear/rebuild every retailer without splitting quantities', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>sample});
  try {
    const editor=createCustomerDropEditor({escape,onUpdate(){}});
    await editor.load();
    editor.handleClick(button('data-drop-skip-all'));
    assert.match(editor.render(), /0 SKUs selected/);
    editor.handleClick(button('data-drop-all'));
    assert.match(editor.render(), /6 SKUs selected/);
    editor.handleClick(button('data-drop-qty',{dropQty:'2'}));
    assert.match(editor.render(), /Qty 2 for every selected product/);
    editor.handleChange({
      hasAttribute: key => key==='data-drop-product-sku',
      dataset:{dropSourceKey:'100:200',dropProductSku:'T-123'},
      checked:false
    });
    assert.match(editor.render(), /5 SKUs selected/);
  } finally { globalThis.fetch=original; }
});

test('Membership is centered, and the Admin app shows right-side tier badges', () => {
  const app=readFileSync(new URL('../public/app-dashboard.js',import.meta.url),'utf8');
  const admin=readFileSync(new URL('../public/admin-mobile.js',import.meta.url),'utf8');
  const page=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const adminPage=readFileSync(new URL('../public/admin-app.html',import.meta.url),'utf8');
  assert.match(app,/const navLabels = \['home', 'tracking', 'profile', 'products', 'history'\]/);
  assert.match(app,/profile: 'Membership'/);
  assert.match(app,/if \(view === 'drops'\) html = dropEditor.render\(\)/);
  assert.match(admin,/class="admin-customer-tier-badge"/);
  assert.match(admin,/admin-customer-tier-10|tier-' \+ count/);
  assert.match(page,/href="\/app-drop-controls\.css\?v=20261010-approved-v4"/);
  assert.match(adminPage,/href="\/admin-customer-tiers\.css\?v=20261010-approved-v4"/);
});


test('approved Membership layout renders real subscription values and does not duplicate the old membership panel', () => {
  const app=readFileSync(new URL('../public/app-dashboard.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../public/app-drop-controls.css',import.meta.url),'utf8');
  const admin=readFileSync(new URL('../public/admin-mobile.js',import.meta.url),'utf8');
  const adminStyles=readFileSync(new URL('../public/admin-customer-tiers.css',import.meta.url),'utf8');
  assert.match(app,/membership\?\.profiles/);
  assert.match(app,/sng-membership-details/);
  assert.match(app,/membership-period-end/);
  assert.match(app,/membership-days-remaining/);
  assert.match(app,/data-app-upgrade/);
  assert.match(app,/preserveProfileTab/);
  assert.match(styles,/data-profile-tab="membership"\] #customer-dashboard #account-tab-membership/);
  assert.match(styles,/sng-app-nav > button\[data-app-view="profile"\]\.active/);
  for (const count of ['10','20','50']) assert.match(styles,new RegExp('sng-membership-hero\\.sng-tier-'+count));
  assert.match(admin,/admin-customer-renewal/);
  assert.match(admin,/currentPeriodEnd/);
  assert.match(admin,/admin-customer-tier-count/);
  assert.match(adminStyles,/Approved Admin customer layout/);
  assert.match(adminStyles,/admin-customer-tier-badge/);
});
