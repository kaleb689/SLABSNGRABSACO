import test from "node:test";
import assert from "node:assert/strict";
import { planDiscordCommunityHits, sourceMessageIdsForHit } from "../discord-hit-mirror-policy.js";

const channel = "1532179373292257290";
const otherChannel = "1551090141693485156";
const sid = suffix => "158000000000000" + String(suffix).padStart(4, "0");
const key = (id, source = channel) => "discord:" + source + ":" + id;
function order(n, { status = "confirmed", owner = null, retailer = "Target",
  orderNumber = "", sourceIds = [], at = "2026-10-09T14:00:00.000Z" } = {}) {
  return {
    id: key(sid(n)), sourceIds, retailer, orderNumber, status,
    customerAccountId: owner, statusUpdatedAt: at, checkoutAt: at,
    items: [{ name: "Pokémon trading card pack", quantity: 2 }]
  };
}

test("every confirmed authoritative checkout qualifies, including unassigned and unlinked", () => {
  const matched = order(1, { owner: "member-123" });
  const unmatched = order(2);
  const hold = order(3, { status: "review_hold" });
  const red = order(4, { status: "cancelled" });
  const unknown = order(5, { status: "unverified" });
  const plan = planDiscordCommunityHits([matched, unmatched, hold, red, unknown], channel);
  assert.equal(plan.eligible, 2);
  assert.equal(plan.unmatched, 1);
  assert.deepEqual(plan.newHits.map(entry => entry.sourceMessageId), [sid(2), sid(1)]);
  assert.equal(plan.withdrawals.length, 0);
});

test("existing eleven-message baseline entries stay reserved while older unlinked hits backfill", () => {
  const linked = order(10, { owner: "member-123" });
  const unlinked = order(9);
  const sent = { [sid(10)]: { messageId: sid(500), renderVersion: 3 } };
  const plan = planDiscordCommunityHits([linked, unlinked], channel, sent, 3);
  assert.deepEqual(plan.newHits.map(entry => entry.sourceMessageId), [sid(9)]);
  assert.equal(plan.eligible, 2);
  assert.equal(plan.unmatched, 1);
  assert.equal(plan.updates.length, 0);
});

test("the same retailer Order ID from multiple webhooks yields one public hit", () => {
  const first = order(20, { orderNumber: "102003802680520" });
  const repeated = order(21, { orderNumber: "102003802680520", owner: "member-123" });
  const plan = planDiscordCommunityHits([first, repeated], channel);
  assert.equal(plan.newHits.length, 1);
  assert.equal(plan.newHits[0].sourceMessageIds.length, 2);
  const alreadySent = planDiscordCommunityHits([first, repeated], channel,
    { [sid(21)]: { messageId: sid(501), renderVersion: 3 } }, 3);
  assert.equal(alreadySent.newHits.length, 0);
});

test("two unrelated generic Success labels cannot silently merge", () => {
  const a = order(30, { orderNumber: "Success" });
  const b = order(31, { orderNumber: "Success" });
  const plan = planDiscordCommunityHits([a, b], channel);
  assert.equal(plan.newHits.length, 2);
});

test("newer cancellation retracts an older green hit instead of reposting it", () => {
  const oldGreen = order(40, { orderNumber: "102003802680599",
    at: "2026-10-09T13:00:00.000Z" });
  const newRed = order(41, { orderNumber: "102003802680599", status: "cancelled",
    at: "2026-10-09T14:00:00.000Z" });
  const plan = planDiscordCommunityHits([oldGreen, newRed], channel,
    { [sid(40)]: { messageId: sid(502), renderVersion: 3 } });
  assert.equal(plan.newHits.length, 0);
  assert.equal(plan.withdrawals.length, 1);
  assert.equal(plan.withdrawals[0].messageId, sid(502));
  assert.equal(plan.withdrawals[0].reason, "no_longer_confirmed");
});

test("newer orange hold also withdraws a stale green success", () => {
  const green = order(42, { orderNumber: "102003802680600",
    at: "2026-10-09T13:00:00.000Z" });
  const hold = order(43, { orderNumber: "102003802680600", status: "review_hold",
    at: "2026-10-09T14:00:00.000Z" });
  const plan = planDiscordCommunityHits([green, hold], channel,
    { [sid(42)]: { messageId: sid(503), renderVersion: 3 } });
  assert.equal(plan.newHits.length, 0);
  assert.equal(plan.withdrawals.length, 1);
});

test("duplicate existing bot posts for one order are scheduled for cleanup", () => {
  const a = order(50, { orderNumber: "102003802680601" });
  const b = order(51, { orderNumber: "102003802680601" });
  const plan = planDiscordCommunityHits([a, b], channel, {
    [sid(50)]: { messageId: sid(504), renderVersion: 3 },
    [sid(51)]: { messageId: sid(505), renderVersion: 3 }
  }, 3);
  assert.equal(plan.newHits.length, 0);
  assert.equal(plan.withdrawals.length, 1);
  assert.equal(plan.withdrawals[0].reason, "duplicate_same_order");
});

test("old known bot hit gets patched in place and is never posted again", () => {
  const existing = order(60);
  const plan = planDiscordCommunityHits([existing], channel, {
    [sid(60)]: { messageId: sid(506), renderVersion: 2 }
  }, 3);
  assert.equal(plan.newHits.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].messageId, sid(506));
});

test("ambiguous pre-POST reservations do not create duplicate retries", () => {
  const plan = planDiscordCommunityHits([order(70)], channel, {
    [sid(70)]: { messageId: "", posting: true }
  });
  assert.equal(plan.newHits.length, 0);
});

test("only the configured source contributes hits; mailbox and archived IDs are ignored", () => {
  const record = order(80, { sourceIds: [key(sid(81), otherChannel), "imap:personal-order"] });
  assert.deepEqual(sourceMessageIdsForHit(record, channel), [sid(80)]);
  assert.deepEqual(sourceMessageIdsForHit(record, otherChannel), [sid(81)]);
  assert.deepEqual(sourceMessageIdsForHit(record, "invalid"), []);
  const archived = order(90);
  archived.id = key(sid(90), otherChannel);
  assert.equal(planDiscordCommunityHits([archived], channel).newHits.length, 0);
});
