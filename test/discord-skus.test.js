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
