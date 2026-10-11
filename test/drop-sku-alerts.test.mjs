import test from "node:test";
import assert from "node:assert/strict";
import { isRetailerSkuPost, dropSkuFingerprint, decideSkuAlert, skuAlertPayload } from "../drop-sku-alerts.js";

const labels = { "123": "Target Drops", "456": "PKC Drops" };
const post = { id: "789", channel_id: "123", guild_id: "guild", type: 0, author: { bot: false } };
const products = [
  { sku: "AB1234", name: "Pokemon ETB" },
  { sku: "CX9999", name: "Collection Box" }
];

test("notifies only original staff posts in a configured retailer channel", () => {
  assert.equal(isRetailerSkuPost(post, "guild", labels), true);
  assert.equal(isRetailerSkuPost({ ...post, channel_id: "outside" }, "guild", labels), false);
  assert.equal(isRetailerSkuPost({ ...post, guild_id: "other" }, "guild", labels), false);
  assert.equal(isRetailerSkuPost({ ...post, author: { bot: true } }, "guild", labels), false);
  assert.equal(isRetailerSkuPost({ ...post, webhook_id: "hook" }, "guild", labels), false);
  assert.equal(isRetailerSkuPost({ ...post, message_reference: { message_id: "parent" } }, "guild", labels), false);
  assert.equal(isRetailerSkuPost({ ...post, type: 19 }, "guild", labels), false);
});

test("same SKUs and names have one fingerprint even when product order changes", () => {
  const hash = dropSkuFingerprint(products);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(dropSkuFingerprint([...products].reverse()), hash);
  assert.equal(dropSkuFingerprint([{ sku: "ab1234", name: "Pokemon  ETB" }, products[1]]), hash);
  assert.notEqual(dropSkuFingerprint([...products, { sku: "NEW1", name: "New" }]), hash);
  assert.notEqual(dropSkuFingerprint([{ sku: "AB1234", name: "New name" }, products[1]]), hash);
  assert.equal(dropSkuFingerprint([]), "");
});

test("deduplicates gateway replays and batches rapid edits without silencing later updates", () => {
  const first = decideSkuAlert(null, "hash-a", 100000);
  assert.deepEqual(first, { remember: true, notify: true });
  const previous = { fingerprint: "hash-a", notifiedAt: new Date(100000).toISOString() };
  assert.deepEqual(decideSkuAlert(previous, "hash-a", 150000), { remember: false, notify: false });
  assert.deepEqual(decideSkuAlert(previous, "hash-b", 150000), { remember: true, notify: false });
  assert.deepEqual(decideSkuAlert(previous, "hash-b", 200000), { remember: true, notify: true });
  assert.deepEqual(decideSkuAlert(previous, "", 200000), { remember: false, notify: false });
});

test("app alert opens Drops and Discord DM links to the original product post", () => {
  const event = skuAlertPayload({
    retailer: "Target Drops", products, guildId: "guild", channelId: "123", messageId: "789"
  });
  assert.equal(event.kind, "drop_skus_updated");
  assert.equal(event.tab, "drops");
  assert.match(event.message, /2 SKUs are available/);
  assert.match(event.message, /one quantity/);
  assert.equal(event.sourceUrl, "https://discord.com/channels/guild/123/789");
  assert.match(event.title, /^Target drop SKUs updated$/);
});
