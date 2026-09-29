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
