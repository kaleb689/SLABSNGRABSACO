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

test("multi-page drafts retain other pages, preserve quantities, and require an explicit final confirmation", async () => {
  const { skuBrowsePayload, applySkuPageDraft, skuDraftReviewPayload } = await import("../discord-community.js");
  const source = "1234567890123456789", channel = "1234567890123456788";
  const products = Array.from({ length: 53 }, (_, i) => ({
    sku: "SKU-" + String(i + 1).padStart(3, "0"), name: "TCG Product " + (i + 1)
  }));
  const saved = changeSkuItems([], [products[0]], source, channel, 2);
  const firstPage = applySkuPageDraft(saved, products, source, channel, 0, ["0", "1"]);
  assert.equal(firstPage.find(item => item.sku === products[0].sku).quantity, 2);
  const secondPage = applySkuPageDraft(firstPage, products, source, channel, 1, ["25", "26"]);
  assert.equal(secondPage.length, 4);
  assert.ok(secondPage.some(item => item.sku === "SKU-027"));
  assert.ok(secondPage.some(item => item.sku === "SKU-001"));
  const revisedFirst = applySkuPageDraft(secondPage, products, source, channel, 0, ["1"]);
  assert.deepEqual(new Set(revisedFirst.map(item => item.sku)), new Set(["SKU-002", "SKU-026", "SKU-027"]));
  assert.equal(secondPage.length, 4, "page edits cannot mutate the original draft");
  const view = skuBrowsePayload(source, products, 1, secondPage);
  assert.equal(view.components[0].components[0].max_values, 25);
  assert.equal(view.components[0].components[0].min_values, 0);
  assert.equal(view.components[0].components[0].options[0].default, true);
  assert.equal(view.components[3].components[1].label, "Confirm Selections");
  assert.match(view.content, /4 SKU\(s\)/);
  const review = skuDraftReviewPayload(source, secondPage);
  assert.match(review.embeds[0].description, /TCG Product 27/);
  assert.equal(review.components.at(-1).components[1].label, "Confirm Selections");
  const cleared = applySkuPageDraft(secondPage, products, source, channel, 1, []);
  assert.deepEqual(cleared.map(item => item.sku).sort(), ["SKU-001", "SKU-002"]);
  assert.throws(() => applySkuPageDraft([], products, source, channel, 1, ["999"]));
});

test("draft review paginates safely when there are more than 25 selections", async () => {
  const { skuDraftReviewPayload } = await import("../discord-community.js");
  const draft = Array.from({ length: 30 }, (_, i) => ({
    key: "channel:source:SKU-" + i, sku: "SKU-" + i, name: "TCG Product " + i, quantity: i % 2 + 1
  }));
  const first = skuDraftReviewPayload("1234567890123456789", draft, 0);
  const second = skuDraftReviewPayload("1234567890123456789", draft, 1);
  assert.equal(first.components[0].components[0].options.length, 25);
  assert.equal(second.components[0].components[0].options.length, 5);
  assert.equal(second.components[1].components[1].disabled, true);
  assert.match(second.embeds[0].description, /SKU-29/);
});

test("Run All handles 100 products and private/admin review pages respect Discord message limits", async () => {
  const { changeSkuItems, skuSelectionView, skuAdminReviewPayload, skuDraftReviewPayload,
    applySkuPageDraft } = await import("../discord-community.js");
  const products = Array.from({ length: 100 }, (_, i) => ({
    sku: "TCGSKU-" + String(i).padStart(3,"0"),
    name: "Long Trading Card Game Booster Bundle Product Name No. " + i
  }));
  const source = "1234567890123456789", channel = "1234567890123456788", user = "1234567890123456787";
  const all = changeSkuItems([], products, source, channel, 2);
  assert.equal(all.length, 100);
  const first = applySkuPageDraft([], products, source, channel, 0,
    products.slice(0,25).map((_,i)=>String(i)));
  const draft = applySkuPageDraft(first, products, source, channel, 3,
    products.slice(75,100).map((_,i)=>String(i+75)));
  assert.equal(draft.length, 50);
  const draftView = skuDraftReviewPayload(source, draft, 0);
  assert.ok(draftView.content.length <= 2000);
  assert.ok(draftView.embeds[0].description.length <= 4096);
  const view = skuSelectionView(all, "", 3);
  assert.match(view.content,/Your selected SKUs \(100\)/);
  assert.match(view.content,/Page 4 of 4/);
  assert.ok(view.components.every(row => row.components.length <= 5));
  assert.ok(view.components.filter(row => row.components[0].type === 3)
    .every(row => row.components[0].options.length <= 25));
  assert.ok(view.embeds.every(embed => embed.description.length <= 4096));
  const admin = skuAdminReviewPayload(all,user,4);
  assert.match(admin.content,/100 total/);
  assert.match(admin.embeds[0].description,/TCGSKU-080/);
  assert.ok(admin.embeds[0].description.length <= 4096);
  assert.ok(admin.content.length <= 2000);
});

test("only the verified Discord guild owner can bypass paid-profile gating for SKU testing", async () => {
  const { isGuildOwnerSkuTester } = await import("../discord-community.js");
  const owner = "1551070928039845923";
  const paidUser = "1551070928039845924";
  assert.equal(isGuildOwnerSkuTester(owner, owner), true,
    "verified server owner may use the same SKU picker without a paid account");
  assert.equal(isGuildOwnerSkuTester(paidUser, owner), false,
    "ordinary users must still pass the membership check");
  assert.equal(isGuildOwnerSkuTester("", owner), false);
  assert.equal(isGuildOwnerSkuTester(owner, ""), false,
    "no fallback bypass when the server owner's ID is unknown");
  assert.equal(isGuildOwnerSkuTester("everyone", "everyone"), false,
    "text role names or malformed IDs never grant the owner bypass");
  assert.equal(isGuildOwnerSkuTester(owner, "0"), false);
  const { readFileSync } = await import("node:fs");
  const code = readFileSync(new URL("../discord-community.js", import.meta.url), "utf8");
  assert.match(code, /if \(isGuildOwnerSkuTester\(userId, ownerId\)\) return true;/);
  assert.match(code, /return Number\(await \(getPaidSkuAllowance \|\| getAllowance\)\(account.id\)\) > 0;/);
  assert.match(code, /ownerId = guild.owner_id;/,
    "owner ID comes from Discord itself, not a role label or user-provided input");
});

test("Target, Walmart and PKC drops reuse the private SKU selection flow and preserve older choices", async () => {
  const { skuControlPayload, skuBrowsePayload, skuAdminReviewPayload } =
    await import("../discord-community.js");
  const labels = { "channel-target": "Target Drops", "channel-walmart": "Walmart Drops",
    "channel-pkc": "PKC Drops" };
  const products = Array.from({ length: 200 }, (_, i) => ({
    sku: "TCGSKU-" + String(i).padStart(3, "0"),
    name: "Retailer Trading Card Game Product " + i
  }));
  const message = { id: "1234567890123456789", channel_id: "channel-pkc" };
  const parsed = parseDropSkus({
    content: products.map(p => p.name + "\nSKU: " + p.sku).join("\n")
  });
  assert.equal(parsed.length, 200);
  assert.deepEqual(parsed[199], products[199]);
  for (const [channelId, label] of Object.entries(labels)) {
    const panel = skuControlPayload({ ...message, channel_id: channelId },
      products, "channel-tonight", labels);
    assert.equal(panel.embeds[0].title, label + " — products");
    assert.equal(panel.components[0].components[0].label, "Choose Multiple SKUs");
    assert.equal(panel.components[0].components[1].label, "Run all SKUs");
    assert.equal(panel.components[1].components[0].label, "Don't run my profiles for this drop");
    assert.equal(panel.components[0].components[2].label, "My selected SKUs");
    assert.ok(panel.embeds[0].description.length <= 4096);
  }
  const endPage = skuBrowsePayload(message.id, parsed, 7);
  assert.equal(endPage.components[0].components[0].options.length, 25);
  assert.equal(endPage.components[0].components[0].options[24].value, "199");
  assert.equal(endPage.components[1].components[1].disabled, true);
  let selected = changeSkuItems([], [products[0]], "old-post", "channel-tonight", 2);
  selected = changeSkuItems(selected, [products[0], products[1]], message.id, message.channel_id, 1);
  assert.equal(selected.length, 3, "saved selections from other drop channels must remain");
  assert.equal(selected[0].quantity, 2);
  assert.ok(skuAdminReviewPayload(selected, "1234567890123456787").content.includes("3 total"));
  assert.throws(() => changeSkuItems(selected, products, message.id, message.channel_id, 1),
    /Up to 200 SKUs/);
});

test("new drop channels provision idempotently with staff posting and paid-only selection", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../discord-community.js", import.meta.url), "utf8");
  for (const name of ["target-drops", "walmart-drops", "pkc-drops"]) {
    assert.ok(source.includes('slug: "' + name + '"'));
  }
  assert.match(source, /normalizeName\(item\.name\) === spec\.key/);
  assert.match(source, /permission_overwrites: overwrites/);
  assert.match(source, /dropChannelIds\.add\(channel\.id\)/);
  assert.match(source, /retailerDropsReady = retailerChannels\.length === 3/);
  assert.match(source, /if \(!await hasPaidSkuAccess\(userId\)\) return await reply\(skuAccessMessage\)/);
  assert.match(source, /if \(isGuildOwnerSkuTester\(userId, ownerId\)\) return true/);
});
