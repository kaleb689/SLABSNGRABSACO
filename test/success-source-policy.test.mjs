import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { webhookOnlyCheckouts, isVerifiedDiscordCheckout,
  hasExactWebhookOrderNumber, isTrustedRetailerSender, matchVerifiedWebhookEmail, authoritativeDiscordCheckouts } from "../success-source-policy.js";

const id = "discord:1532179373292257290:1580000000000000001";
const now = new Date().toISOString();
const confirmed = {
  id, source: "discord_success", customerAccountId: "customer-a",
  retailer: "Target", orderNumber: "T-123456789", checkoutAt: now,
  status: "confirmed", items: [{ name: "Trading card pack", quantity: 1 }]
};

test("the checkout store excludes mailbox-only and synthetic false confirmations", () => {
  const records = [
    { ...confirmed, id: "imap-live-target:customer-a:123" },
    { ...confirmed, id: "community-mailbox:abc" },
    { ...confirmed, id: "discord:invalid" },
    confirmed, { ...confirmed, id }
  ];
  const saved = webhookOnlyCheckouts(records);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, id);
  assert.deepEqual(saved[0].sourceIds, [id]);
  assert.equal(isVerifiedDiscordCheckout({ ...confirmed, id: "imap:abc", source: "discord_success" }), false);
});

test("legacy mixed-email checkout attribution and shipment are cleared without losing its webhook identity", () => {
  const mixed = {
    ...confirmed, id: "imap-live-target:old", sourceIds: [id],
    orderNumber: "WRONG-12345", source: "imap-live-target",
    customerAccountId: "wrong-owner", profileName: "Personal Account",
    shipping: { status: "delivered", source: "retailer_email" },
    cancelledAt: "2026-09-01T00:00:00Z", status: "cancelled",
    priceSource: "imap-live-target", orderTotal: 200
  };
  const [safe] = webhookOnlyCheckouts([mixed], { resetLegacyShipping: true });
  assert.equal(safe.id, id);
  assert.equal(safe.customerAccountId, null);
  assert.equal(safe.orderNumber, "");
  assert.equal(safe.orderTotal, 0);
  assert.equal(safe.status, "confirmed");
  assert.equal(safe.shipping, undefined);
  assert.equal(safe.cancelledAt, undefined);
  assert.deepEqual(safe.sourceIds, [id]);
});

test("legacy shipment sourced only from retailer email is discarded for re-verification", () => {
  const [safe] = webhookOnlyCheckouts([
    { ...confirmed, shipping: { status: "delivered", source: "retailer_email" } }
  ], { resetLegacyShipping: true });
  assert.equal(safe.shipping, undefined);
  assert.equal(safe.customerAccountId, "customer-a");
});

test("only exact retailer order numbers count; product names and partial numbers do not", () => {
  assert.equal(hasExactWebhookOrderNumber(confirmed, "Order #T-123456789 is shipped."), true);
  assert.equal(hasExactWebhookOrderNumber(confirmed, "Order T-1234567890 is shipped."), false);
  assert.equal(hasExactWebhookOrderNumber(confirmed, "Order XT-123456789 is shipped."), false);
  assert.equal(hasExactWebhookOrderNumber({ ...confirmed, orderNumber: "" }, "Trading card pack shipped"), false);
  assert.equal(hasExactWebhookOrderNumber({ ...confirmed, id: "imap:abc" }, "T-123456789 shipped"), false);
});

test("retailer From domains are exact or proper subdomains, not lookalikes", () => {
  assert.equal(isTrustedRetailerSender("Target", [{ address: "orders@target.com" }]), true);
  assert.equal(isTrustedRetailerSender("Target", [{ address: "orders@notifications.target.com" }]), true);
  assert.equal(isTrustedRetailerSender("Target", [{ address: "orders@target.com.evil.test" }]), false);
  assert.equal(isTrustedRetailerSender("Walmart", [{ address: "orders@target.com" }]), false);
  assert.equal(isTrustedRetailerSender("PKC", [{ address: "receipt@pokemoncenter.com" }]), true);
  assert.equal(isTrustedRetailerSender("Costco", [{ address: "orders@costco.com" }]), true);
  assert.equal(isTrustedRetailerSender("Sam's Club", [{ address: "orders@samsclub.com" }]), true);
});

test("shipping email only enriches one verified webhook order with matching retailer and timestamp", () => {
  const input = {
    senders: [{ address: "shipping@target.com" }],
    subject: "Your order has shipped",
    text: "Tracking for order T-123456789",
    receivedAt: new Date(Date.now() + 1000).toISOString()
  };
  assert.equal(matchVerifiedWebhookEmail([confirmed], input)?.id, id);
  assert.equal(matchVerifiedWebhookEmail([confirmed], { ...input, senders: ["shipping@gmail.com"] }), null);
  assert.equal(matchVerifiedWebhookEmail([confirmed], { ...input, text: "Trading card pack delivered" }), null);
  assert.equal(matchVerifiedWebhookEmail([confirmed], { ...input, receivedAt: "2020-01-01T00:00:00Z" }), null);
  assert.equal(matchVerifiedWebhookEmail([confirmed, { ...confirmed, id: "discord:1532179373292257290:1580000000000000002" }], input), null);
});

test("production Success, shipping, and notification flow uses strict source barriers", async () => {
  const source = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /migrateWebhookOnlySuccessCheckouts\(\)/);
  assert.match(source, /return webhookOnlyCheckouts\(records\)/);
  assert.match(source, /if \(!isVerifiedDiscordCheckout\(record\)\) return false/);
  assert.match(source, /matchVerifiedWebhookEmail\(records/);
  assert.match(source, /withSuccessStoreLock\(async \(\) => \{/);
  const shippingScan = source.split("async function scanMailboxForShipping(")[1].split("async function syncShippingTrackers()")[0];
  assert.doesNotMatch(shippingScan, /itemName\s*&&\s*combined/);
  assert.doesNotMatch(shippingScan, /sendShippingDiscordDm/);
  const scheduler = source.split("function startLiveSuccessScheduler()")[1].split("function ", 1)[0];
  assert.doesNotMatch(scheduler, /syncAllActiveCustomerSuccess\(\)/);
  assert.doesNotMatch(scheduler, /runManagedSuccessScan\(\)/);
});

test("archived Discord checkout channels never inflate active customer or public Success", () => {
  const activeChannel = "1532179373292257290";
  const retiredChannel = "1551090141693485156";
  const current = { ...confirmed, id: "discord:" + activeChannel + ":1580000000000000001" };
  const archived = { ...confirmed, id: "discord:" + retiredChannel + ":1580000000000000002" };
  const crossFeedSameCheckout = { ...confirmed,
    id: "discord:" + retiredChannel + ":1580000000000000003",
    sourceIds: ["discord:" + activeChannel + ":1580000000000000004"]
  };
  const records = [current, archived, crossFeedSameCheckout];
  const visible = authoritativeDiscordCheckouts(records, [activeChannel]);
  assert.deepEqual(visible.map(record => record.id), [current.id, crossFeedSameCheckout.id]);
  assert.deepEqual(authoritativeDiscordCheckouts(records, []), []);
  assert.deepEqual(authoritativeDiscordCheckouts(records, [retiredChannel]).map(record => record.id),
    [archived.id, crossFeedSameCheckout.id]);
  // Audited history remains untouched; only the view is source-restricted.
  assert.equal(records.length, 3);
});

test("all Success aggregate and customer endpoints use an authoritative-source filter", async () => {
  const server = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /return authoritativeDiscordCheckouts\(records, authorizedChannelIds\)/);
  assert.match(server, /visibleDiscordSuccessRecords\(await getSuccessCheckouts\(\), hitsChannelId, chosen\.channels\)/);
  assert.equal((server.match(/visibleDiscordSuccessRecords\(/g) || []).length, 5);
  assert.equal((server.match(/\(await discordCheckoutSourceChannels\(\)\)\.channels/g) || []).length, 3);
});
