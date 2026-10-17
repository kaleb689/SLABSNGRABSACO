import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkoutIdentityFromDiscord, checkoutStatusFromDiscord,
  checkoutProductFromDiscord } from "../discord-checkout-identity.js";
import { checkoutExplicitPaidTotal } from "../checkout-price-policy.js";
import { isModuleLifecycleText, isModuleLifecycleDiscordMessage,
  isModuleLifecycleCheckout } from "../discord-checkout-event-policy.js";
import { webhookOnlyCheckouts, authoritativeDiscordCheckouts } from "../success-source-policy.js";
import { planDiscordCommunityHits } from "../discord-hit-mirror-policy.js";

const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = source.indexOf("function discordCheckoutFromMessage(");
const end = source.indexOf("const DISCORD_HIT_MIRROR_FILE", start);
assert.ok(start > -1 && end > start);
const channel = "1532179373292257290";
const green = 0x57f287;
const noticeText = "The **PokemonCenter US** module has been unlocked. Running tasks will resume.";

function parse(message) {
  const context = {
    message, channel, parsed: null, isModuleLifecycleDiscordMessage,
    discordCheckoutIdentity: checkoutIdentityFromDiscord,
    checkoutStatusFromDiscord, checkoutProductFromDiscord, checkoutExplicitPaidTotal,
    publicSuccessProductName: value => String(value || "").trim().slice(0, 120),
    isSafeDiscordCheckoutProductName: value => Boolean(String(value || "").length >= 3),
    publicSuccessImageUrl: value => value || null,
    normalizeSuccessRetailer: value => String(value || "")
  };
  vm.runInNewContext(source.slice(start, end) +
    "\nparsed = discordCheckoutFromMessage(message, channel);", context);
  return context.parsed ? JSON.parse(JSON.stringify(context.parsed)) : null;
}
function message(id, fields = [], description = "", title = "Retailer report") {
  return {
    id, webhook_id: "1580000000000000400", timestamp: "2026-10-15T17:30:00Z",
    embeds: [{ color: green, title, description, fields }]
  };
}
test("module unlocked and module closed phrases are notices, not actual products", () => {
  for (const wording of [
    noticeText, "The PokemonCenter US module has been closed. Running tasks will stop.",
    "MODULE UNLOCKED", "Module Closed", "Closed: PokemonCenter US module",
    "Module: PokemonCenter US has been unlocked"
  ]) assert.equal(isModuleLifecycleText(wording), true, wording);
  for (const name of [
    "Pokemon TCG: 30th Celebration Mini Tin - Mew (Day)",
    "Pokemon TCG: Ultra Premium Collection",
    "Order closed after checkout"
  ]) assert.equal(isModuleLifecycleText(name), false, name);
});
test("module lifecycle events never parse as GREEN checkouts", () => {
  assert.equal(parse(message("1580000000000000501", [], noticeText)), null);
  assert.equal(parse(message("1580000000000000502", [],
    "The **PokemonCenter US** module has been closed. Running tasks will pause.")), null);
  assert.equal(parse(message("1580000000000000503", [
    {name: "Site", value: "Pokemon Center US"},
    {name: "Product", value: noticeText},
    {name: "Quantity", value: "2"}, {name: "Price", value: "9.99"}
  ], "", "Successful Checkout!")), null);
  assert.equal(parse(message("1580000000000000504", [
    {name: "Module", value: "Closed"},
    {name: "Product", value: "Pokemon TCG: Mini Tin"}
  ], "", "Checkout Success")), null);
});
test("real Pokemon purchases are unaffected", () => {
  const order = parse(message("1580000000000000505", [
    {name: "Site", value: "Pokemon Center US"},
    {name: "Product", value: "Pokemon TCG: 30th Celebration Mini Tin - Pikachu (Day)"},
    {name: "Quantity", value: "2"}, {name: "Price", value: "9.99"}
  ]));
  assert.ok(order);
  assert.equal(order.status, "confirmed");
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.items[0].price, 9.99);
});
test("historic notices are excluded from saved checkout, public and customer views", () => {
  const bogus = {
    id: "discord:" + channel + ":1580000000000000510", customerAccountId: "member-test",
    status: "confirmed", orderTotal: 39.98, orderTotalBasis: "order_total",
    items: [{name: noticeText, quantity: 2, price: 19.99}]
  };
  const genuine = {
    ...bogus, id: "discord:" + channel + ":1580000000000000511",
    items: [{name: "Pokemon TCG: 30th Celebration Mini Tin", quantity: 2, price: 9.99}]
  };
  assert.equal(isModuleLifecycleCheckout(bogus), true);
  assert.equal(isModuleLifecycleCheckout(genuine), false);
  assert.equal(isModuleLifecycleDiscordMessage(message("1580000000000000512", [], noticeText)), true);
  assert.deepEqual(webhookOnlyCheckouts([bogus, genuine]).map(item => item.id), [genuine.id]);
  assert.deepEqual(authoritativeDiscordCheckouts([bogus, genuine], [channel]).map(item => item.id), [genuine.id]);
});
test("an already-posted module hit is withdrawn using its ledger receipt", () => {
  const originalSource = "1580000000000000520";
  const publishedId = "1580000000000000620";
  const excluded = {id: "discord:" + channel + ":" + originalSource,
    sourceIds: ["discord:" + channel + ":" + originalSource],
    status: "excluded_non_checkout", items: []};
  const sent = { [originalSource]: {messageId: publishedId, renderVersion: 4} };
  const plan = planDiscordCommunityHits([excluded], channel, sent);
  assert.equal(plan.eligible, 0);
  assert.equal(plan.newHits.length, 0);
  assert.equal(plan.withdrawals.length, 1);
  assert.equal(plan.withdrawals[0].messageId, publishedId);
});
test("production ingest rejects notices and migration retains safe source IDs for cleanup", () => {
  assert.match(source, /isModuleLifecycleDiscordMessage\(message\)/);
  assert.match(source, /const moduleLifecycleRecords = original\.filter\(isModuleLifecycleCheckout\)/);
  assert.match(source, /MODULE_LIFECYCLE_EXCLUSIONS_FILE/);
  assert.match(source, /communityRecords\.push\(/);
  assert.match(source, /mirrorDiscordCheckoutHits\(\s*communityRecords, token, channels\[0\]\)/);
});
