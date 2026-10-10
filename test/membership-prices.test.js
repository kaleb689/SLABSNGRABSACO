import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { correctedMembershipPrice } from '../membership-prices.js';
const price = (id, amount) => ({ id, product: 'prod_membership', active: true, currency: 'usd', type: 'recurring', unit_amount: amount, recurring: { interval: 'month', interval_count: 1 } });
test('corrects all three membership amounts on the same Stripe product without changing old prices', async () => {
 for (const [tier, profiles, old, amount] of [[5, 10, 7000, 80], [6, 20, 10000, 150], [7, 50, 21500, 290]]) {
  const original = price('price_old', old); let created;
  const stripe = { prices: { retrieve: async () => original, list: async () => ({ data: [] }), create: async (data, options) => {
   created = { data, options }; return price('price_new', data.unit_amount);
  } } };
  const result = await correctedMembershipPrice(stripe, tier, { priceId: original.id, amount, profiles, name: 'Membership' });
  assert.equal(result.price.unit_amount, amount * 100);
  assert.equal(result.original.unit_amount, old);
  assert.equal(created.data.product, original.product);
  assert.equal(created.data.recurring.interval, 'month');
  assert.equal(created.options.idempotencyKey, created.data.lookup_key);
 }
});
test('reuses correct or cached prices and rejects non-monthly prices', async () => {
 let calls = 0; const original = price('old', 7000), corrected = price('new', 8000);
 const stripe = { prices: { retrieve: async id => id === 'old' ? original : corrected, list: async () => { calls++; return { data: [] }; } } };
 const plan = { priceId: 'old', amount: 80, profiles: 10, name: 'High Volume' };
 assert.equal((await correctedMembershipPrice(stripe, 5, plan, 'new')).price.id, 'new');
 assert.equal(calls, 0);
 assert.equal((await correctedMembershipPrice(stripe, 5, { ...plan, priceId: 'new' })).price.id, 'new');
 original.recurring.interval = 'year';
 await assert.rejects(correctedMembershipPrice(stripe, 5, plan), /monthly USD/);
});


test('customer plan cards and retailer guide use approved tier prices and supplied retailer accounts', () => {
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const guide=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert.match(app,/profiles: 10, amount: 80/);
 assert.match(app,/profiles: 20, amount: 150/);
 assert.match(app,/profiles: 50, amount: 290/);
 assert.doesNotMatch(guide,/20-profile tier needs 20 unique logins/);
 assert.match(guide,/Target, Walmart and Pokémon Center accounts are supplied by SLABSNGRABSACO/);
 assert.match(guide,/Costco and Sam’s Club accounts are optional/);
});
