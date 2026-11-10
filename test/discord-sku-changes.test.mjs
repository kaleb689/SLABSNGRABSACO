import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { skuSelectionChanges, skuOwnerDetails, setGlobalSkuQuantity } from "../discord-community.js";

const row = (channel, post, sku, name, quantity = 2) => ({
  key: channel + ":" + post + ":" + sku, sku, name, quantity
});

test("SKU owner message bolds newly added SKU numbers and lists added/removed product names", () => {
  const previous = [
    row("target", "drop1", "T-KEEP", "Kept Target Box"),
    row("target", "drop1", "T-OLD", "Old Target Booster")
  ];
  const next = [
    previous[0],
    row("target", "drop1", "T-NEW", "New Target Collection")
  ];
  const changes = skuSelectionChanges(previous, next);
  assert.deepEqual(changes.added.map(item => item.sku), ["T-NEW"]);
  assert.deepEqual(changes.removed.map(item => item.sku), ["T-OLD"]);
  const embed = skuOwnerDetails(next, () => "Target", changes);
  assert.match(embed.description, /\*\*Target\*\* \(2\)/);
  assert.match(embed.description, /\*\*T-NEW\*\*/);
  assert.doesNotMatch(embed.description, /\*\*T-KEEP\*\*/);
  assert.match(embed.description, /\*\*Qty: 2 for ALL SKUs\*\*/);
  assert.match(embed.description, /SKU changes this update/);
  assert.match(embed.description, /New Target Collection added/);
  assert.match(embed.description, /Old Target Booster removed/);
  assert.ok(embed.description.indexOf("SKU changes") > embed.description.indexOf("Qty: 2"));
});

test("retailer channel and SKU define change identity, not reposted message ID or quantity", () => {
  const previous = [row("target", "older-source", "X-123", "Collection Box", 1)];
  const repost = [row("target", "newer-source", "x-123", "Renamed Collection Box", 2)];
  const unchanged = skuSelectionChanges(previous, repost);
  assert.equal(unchanged.added.length, 0);
  assert.equal(unchanged.removed.length, 0);
  assert.doesNotMatch(skuOwnerDetails(repost, () => "Target", unchanged).description, /SKU changes this update/);
  const crossRetailer = [...previous, row("pkc", "post", "X-123", "PKC Collection")];
  assert.deepEqual(skuSelectionChanges(previous, crossRetailer).added.map(item => item.name), ["PKC Collection"]);
  assert.deepEqual(skuSelectionChanges(previous, setGlobalSkuQuantity(previous, 2)),
    { added: [], removed: [] });
});

test("removal of the final SKU still displays its name and removal status", () => {
  const before = [row("walmart", "drop", "W-88", "Rare Collection Box")];
  const changes = skuSelectionChanges(before, []);
  const card = skuOwnerDetails([], () => "Walmart", changes);
  assert.match(card.description, /No SKUs selected/);
  assert.match(card.description, /Rare Collection Box removed/);
  assert.doesNotMatch(card.description, /Rare Collection Box added/);
});

test("long selection updates stay within Discord embed limits and show overflow counts", () => {
  const all = Array.from({ length: 200 }, (_, i) =>
    row("target", "post", "T" + String(i).padStart(3, "0"),
      "Special Trading Card Game Booster Bundle Product " + i + " Extra Long Name"));
  const changes = skuSelectionChanges([], all);
  const card = skuOwnerDetails(all, () => "Target", changes);
  assert.ok(card.description.length <= 4096, "Discord descriptions must be <=4096 chars");
  assert.match(card.description, /Qty: 2 for ALL SKUs/);
  assert.match(card.description, /Added \(200\)/);
  assert.match(card.description, /more added \(not shown here\)/);
  const cleared = skuOwnerDetails([], () => "Target", skuSelectionChanges(all, []));
  assert.ok(cleared.description.length <= 4096);
  assert.match(cleared.description, /Removed \(200\)/);
});

test("product names are escaped before Discord markdown and mentions are rendered", () => {
  const selected = [row("target", "post", "SAFE-1", "<@12345> **Untrusted** Pack")];
  const card = skuOwnerDetails(selected, () => "Target", skuSelectionChanges([], selected));
  assert.doesNotMatch(card.description, /<@12345>/);
  assert.match(card.description, /Untrusted   Pack added/);
});

test("owner message compares saved snapshots in Discord and customer-app selection paths", () => {
  const source = readFileSync(new URL("../discord-community.js", import.meta.url), "utf8");
  for (const marker of [
    "skippedUpcomingDrops, record.items);",
    "skippedUpcomingDrops, previousItems);",
    "skippedUpcomingDrops, old);",
    "skipped, record.items);"
  ]) assert.ok(source.includes(marker), "Missing previous selection snapshot: " + marker);
});
