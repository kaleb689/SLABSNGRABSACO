import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isCancelledCheckout, customerCancelledCheckouts,
  loadHiddenCancelledIds, hideCustomerCancelledOrder
} from "../customer-cancelled-history.js";

const idA = "discord:1532179373292257290:1580000000000000001";
const idB = "discord:1532179373292257290:1580000000000000002";
const idC = "discord:1532179373292257290:1580000000000000003";
const stamp = "2026-11-13T20:00:00.000Z";
const cancelled = (id, customerAccountId = "customer-a", fields = {}) => ({
  id, customerAccountId, retailer: "Target", status: "cancelled",
  checkoutAt: stamp, cancelledAt: "2026-11-13T20:01:00.000Z", ...fields
});

test("customer cancelled orders display immediately, even one minute after checkout", () => {
  const records = [
    cancelled(idA),
    cancelled(idB, "customer-b"),
    cancelled(idC, "customer-a", { status: "confirmed", cancelledAt: null }),
    cancelled("imap-live-not-a-webhook")
  ];
  assert.deepEqual(customerCancelledCheckouts(records, { accountId: "customer-a",
    startDate: "2026-11-13", endDate: "2026-11-13" }).map(x => x.id), [idA]);
  assert.equal(isCancelledCheckout({ status: "review_hold" }), false);
  assert.equal(isCancelledCheckout({ status: "refunded" }), true);
  assert.deepEqual(customerCancelledCheckouts(records, { accountId: "customer-a",
    preciseBounds: { start: Date.parse("2026-11-13T21:00:00Z"), end: Date.parse("2026-11-14T00:00:00Z") } }), []);
});

test("dismissal is account-scoped and persists without deleting source orders", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sng-hidden-orders-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const records = [cancelled(idA), cancelled(idB, "customer-b")];
  assert.equal(await hideCustomerCancelledOrder(dir, "customer-a", idA), true);
  assert.equal(await hideCustomerCancelledOrder(dir, "customer-a", idA), false);
  const hiddenA = await loadHiddenCancelledIds(dir, "customer-a");
  const hiddenB = await loadHiddenCancelledIds(dir, "customer-b");
  assert.deepEqual(hiddenA, [idA]);
  assert.deepEqual(hiddenB, []);
  assert.deepEqual(customerCancelledCheckouts(records, {
    accountId: "customer-a", hiddenIds: hiddenA
  }), []);
  assert.deepEqual(customerCancelledCheckouts(records, {
    accountId: "customer-b", hiddenIds: hiddenB
  }).map(x => x.id), [idB]);
  assert.equal(records[0].status, "cancelled");
  assert.equal(records.length, 2);
});

test("an order hidden under a webhook alias stays hidden after reconciliation", () => {
  const record = cancelled(idB, "customer-a", { sourceIds: [idA, idB] });
  assert.deepEqual(customerCancelledCheckouts([record], {
    accountId: "customer-a", hiddenIds: [idA]
  }), []);
});

test("only valid Discord checkout identities may be dismissed", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sng-hidden-orders-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(() => hideCustomerCancelledOrder(dir, "customer-a", "../other-account"), /Invalid/);
  await assert.rejects(() => hideCustomerCancelledOrder(dir, "customer-a", "not-an-order"), /Invalid/);
  assert.deepEqual(await loadHiddenCancelledIds(dir, "customer-a"), []);
});
