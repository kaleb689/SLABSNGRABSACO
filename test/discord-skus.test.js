import test from "node:test";
import assert from "node:assert/strict";
import { isNewDropPost, parseDropSkus } from "../discord-community.js";

test("pairs each explicitly labeled SKU with its product and deduplicates repeats", () => {
  assert.deepEqual(parseDropSkus({
    content: "Nike Dunk Low\nSKU: DD1391-100\nQty: 2\nAir Jordan 4\nSKU # FV5029-006\nSKU: DD1391-100"
  }), [
    { name: "Nike Dunk Low", sku: "DD1391-100" },
    { name: "Air Jordan 4", sku: "FV5029-006" }
  ]);
});

test("reads SKU labels in a drop embed without treating quantities as products", () => {
  assert.deepEqual(parseDropSkus({ embeds: [{
    title: "Pokemon Prismatic Evolutions",
    description: "SKU: 12345-ABC\nQty: 1"
  }] }), [{ name: "Pokemon Prismatic Evolutions", sku: "12345-ABC" }]);
});

test("replies leave previous posts intact even when Discord labels them as regular messages", () => {
  assert.equal(isNewDropPost({ type: 19, message_reference: { message_id: "123" } }), false);
  assert.equal(isNewDropPost({ type: 0, message_reference: { message_id: "123" } }), false);
  assert.equal(isNewDropPost({ type: 0 }), true);
});

import { changeSkuItems, skuSelectionView } from "../discord-community.js";

test("SKU changes replace quantity, remove only the selected item, and leave other drops intact", () => {
  const products = [{ name: "Dunk", sku: "DD1391-100" }, { name: "Jordan", sku: "FV5029-006" }];
  const first = changeSkuItems([], products, "post1", "channel", 1);
  const changed = changeSkuItems(first, [products[0]], "post1", "channel", 2);
  assert.equal(changed[0].quantity, 2);
  assert.equal(changed[1].quantity, 1);
  assert.equal(first[0].quantity, 1, "original state is unchanged until saved");
  const nextDrop = changeSkuItems(changed, [products[0]], "post2", "channel", 1);
  const removed = changeSkuItems(nextDrop, products, "post1", "channel", 0);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].key, "channel:post2:DD1391-100");
  assert.throws(() => changeSkuItems(first, products, "post1", "channel", 3));
});

test("private SKU summary shows quantities and exposes all 30 selections within Discord limits", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ key: `channel:post:sku-${i}`, name: "Product ".repeat(15), sku: `SKU-${i}`, quantity: i % 2 + 1 }));
  const view = skuSelectionView(items);
  assert.match(view.content, /Your selected SKUs \(30\)/);
  assert.match(view.embeds.map(x => x.description).join(""), /Qty: 2/);
  assert.ok(view.embeds.every(x => x.description.length <= 4096));
  assert.equal(view.components.filter(row => row.components[0].type === 3).flatMap(row => row.components[0].options).length, 30);
  assert.ok(view.components.every(row => row.components[0].type !== 3 || row.components[0].options.length <= 25));
  const empty = skuSelectionView([]);
  assert.match(empty.content, /no selected SKUs/);
  assert.deepEqual(empty.embeds, []);
});

import { dropChannelKind } from '../discord-community.js';
test('upcoming drop channels use the same controls with singular, plural, or decorated names', () => {
  assert.equal(dropChannelKind('❗️│upcoming-drops'), 'upcomingdrops');
  assert.equal(dropChannelKind('upcoming-drop'), 'upcomingdrops');
  assert.equal(dropChannelKind('❗️│dropping-tonight'), 'droppingtonight');
  assert.equal(dropChannelKind('sku-requests'), 'skurequests');
});

test("single public SKU panel labels products and private pagination scales beyond 25 entries", async () => {
  const { skuControlPayload, skuBrowsePayload } = await import("../discord-community.js");
  const products = Array.from({ length: 53 }, (_, i) => ({
    sku: "SKU-" + String(i + 1).padStart(3, "0"),
    name: "Trading Card Box " + (i + 1)
  }));
  const message = { id: "1234567890123456789", channel_id: "tonight-channel" };
  const publicPanel = skuControlPayload(message, products, "tonight-channel");
  assert.equal(publicPanel.components.length, 2, "one public panel contains controls without duplicated instructions");
  assert.match(publicPanel.embeds[0].description, /SKU-001.*Trading Card Box 1/);
  assert.ok(publicPanel.embeds.map(e => e.description.length).every(n => n <= 4096));
  assert.ok(publicPanel.embeds.reduce((length, e) => length + e.description.length + e.title.length, 0) <= 6000);
  const first = skuBrowsePayload(message.id, products, 0);
  const second = skuBrowsePayload(message.id, products, 1);
  const third = skuBrowsePayload(message.id, products, 2);
  assert.equal(first.components[0].components[0].options.length, 25);
  assert.equal(second.components[0].components[0].options.length, 25);
  assert.equal(third.components[0].components[0].options.length, 3);
  assert.match(second.components[0].components[0].options[0].label, /SKU-026.*Trading Card Box 26/);
  assert.equal(third.components[0].components[0].options[0].value, "50");
  assert.equal(third.components[1].components[1].disabled, true);
});
