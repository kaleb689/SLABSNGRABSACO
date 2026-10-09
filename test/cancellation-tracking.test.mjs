import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { lateCancellation, cancelledOrder } from "../order-notifications.js";
import { visibleLateCancellation, shippingStage } from "../public/app-dashboard-data.js";
import { shippingStatusFromMessage, cancellationFromSubject } from "../shipping-tracking-policy.js";
import { matchVerifiedWebhookEmail } from "../success-source-policy.js";

const hour = 60 * 60 * 1000;
const placed = new Date("2026-10-05T13:00:00.000Z");
const record = hours => ({
  id: "discord:1532179373292257290:1580000000000000001",
  customerAccountId: "customer-a",
  status: "cancelled", retailer: "Target",
  orderNumber: "T-123456789",
  checkoutAt: placed.toISOString(),
  cancelledAt: new Date(placed.getTime() + hours * hour).toISOString()
});

test("cancelled less than 24 hours after checkout is invisible even one second before cutoff", () => {
  const cancelled = { ...record(24), cancelledAt: new Date(placed.getTime() + 24 * hour - 1000).toISOString() };
  assert.equal(cancelledOrder(cancelled), true);
  assert.equal(lateCancellation(cancelled), false);
  assert.equal(visibleLateCancellation(cancelled), false);
  assert.equal(shippingStage(cancelled), "cancelled");
});

test("cancellation exactly 24 hours after checkout is visible but never counted as a successful purchase", () => {
  const cancelled = record(24);
  assert.equal(lateCancellation(cancelled), true);
  assert.equal(visibleLateCancellation(cancelled), true);
  assert.equal(shippingStage(cancelled), "cancelled");
});

test("cancellations 25 hours and 72 hours after checkout stay visible in Tracking/History", () => {
  for (const hours of [25, 72]) {
    assert.equal(lateCancellation(record(hours)), true);
    assert.equal(visibleLateCancellation(record(hours)), true);
  }
});

test("missing, invalid, reversed, and future cancellation timestamps never produce customer history", () => {
  const examples = [
    { ...record(24), cancelledAt: null },
    { ...record(24), checkoutAt: null },
    { ...record(24), cancelledAt: "not a date" },
    { ...record(24), cancelledAt: new Date(placed.getTime() - hour).toISOString() },
    { ...record(24), cancelledAt: new Date(Date.now() + 3 * hour).toISOString() }
  ];
  for (const example of examples) {
    assert.equal(lateCancellation(example), false);
    assert.equal(visibleLateCancellation(example), false);
  }
});

test("refunds follow the same exact cancellation time boundary", () => {
  assert.equal(lateCancellation({ ...record(24), status: "refunded" }), true);
  assert.equal(lateCancellation({ ...record(2), status: "refunded" }), false);
});

test("shipping parser refuses generic email boilerplate claiming future delivery", () => {
  assert.equal(shippingStatusFromMessage("Order update", "Your package will be delivered tomorrow"), null);
  assert.equal(shippingStatusFromMessage("Your order shipped", "Once delivered, contact support if needed"), "shipped");
  assert.equal(shippingStatusFromMessage("Shipping confirmation", "Your order has shipped"), "shipped");
  assert.equal(shippingStatusFromMessage("Your package was delivered", "Order T-123456789"), "delivered");
  assert.equal(shippingStatusFromMessage("Tracking update", "Tracking status: In transit"), "in_transit");
});

test("only completed order cancellations and refunds are classified", () => {
  assert.equal(cancellationFromSubject("Your order was cancelled"), "cancelled");
  assert.equal(cancellationFromSubject("Your order has been canceled"), "cancelled");
  assert.equal(cancellationFromSubject("Order refund processed"), "refunded");
  assert.equal(cancellationFromSubject("How to cancel your order"), null);
  assert.equal(cancellationFromSubject("Order cancellation requested"), null);
});

test("managed business mailbox cannot create a checkout or match other customers' emails", () => {
  const confirmed = { ...record(24), status: "confirmed", cancelledAt: null };
  const evidence = {
    senders: [{ address: "ship@target.com" }],
    subject: "Your order has shipped",
    text: "Order T-123456789",
    receivedAt: "2026-10-06T13:00:00.000Z"
  };
  assert.equal(matchVerifiedWebhookEmail([confirmed], evidence)?.id, confirmed.id);
  assert.equal(matchVerifiedWebhookEmail([confirmed], { ...evidence, text: "Same product but no order number" }), null);
  assert.equal(matchVerifiedWebhookEmail([confirmed], { ...evidence, senders: ["account@gmail.com"] }), null);
});

test("customer Success API and app both enforce 24-hour cancellation cutoff", async () => {
  const server = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  const app = await fs.readFile(new URL("../public/app-dashboard.js", import.meta.url), "utf8");
  assert.match(server, /ownedRecords\.filter\(lateCancellation\)/);
  assert.match(server, /cancelledAt: record\?\.cancelledAt \|\| record\?\.canceledAt \|\| null/);
  assert.match(server, /managedHost: managed\.host/);
  assert.match(server, /matchVerifiedWebhookEmail\(records/);
  assert.match(app, /data\.cancelledCheckouts\.filter\(order => visibleLateCancellation\(order\)\)/);
  assert.match(app, /'cancelled'\]\.map/);
});
