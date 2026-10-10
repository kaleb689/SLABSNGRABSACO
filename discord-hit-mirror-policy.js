import { sameCheckout } from "./webhook-success.js";
import { cancelledOrder } from "./order-notifications.js";
import { checkoutPriceSignature } from "./checkout-price-policy.js";

const SOURCE_CHANNEL = /^\d{17,22}$/;
const SOURCE_MESSAGE = /^\d{17,22}$/;
const CONFIRMED_STATUS = /^(confirmed|success|successful|placed|paid|completed|shipped|delivered)$/i;

// These are source message identifiers, not customer accounts. A successful
// checkout is a community hit whether or not an owner can be matched.
export function sourceMessageIdsForHit(record, channelId) {
  if (!SOURCE_CHANNEL.test(String(channelId || ""))) return [];
  const prefix = "discord:" + channelId + ":";
  return [...new Set([record?.id, ...(Array.isArray(record?.sourceIds) ? record.sourceIds : [])]
    .map(String).filter(id => id.startsWith(prefix) && SOURCE_MESSAGE.test(id.slice(prefix.length)))
    .map(id => id.slice(prefix.length)))];
}

function confirmed(record) {
  return Boolean(record && !cancelledOrder(record) && CONFIRMED_STATUS.test(String(record.status || "")));
}
function updatedAt(record) {
  const at = Date.parse(record?.statusUpdatedAt || record?.checkoutAt || "");
  return Number.isFinite(at) ? at : -Infinity;
}
function descendingSourceId(a, b) {
  const ai = BigInt(a.sourceMessageId), bi = BigInt(b.sourceMessageId);
  return ai === bi ? 0 : ai > bi ? -1 : 1;
}

/**
 * Build a non-destructive, order-based mirror plan from reconciled checkout
 * records. Do NOT plan against raw GREEN messages: a newer RED or ORANGE event
 * for the same retailer order must suppress that earlier GREEN.
 *
 * The old 11-hit baseline and all previously sent source IDs remain reserved
 * in the persistent ledger. Unsent older webhook orders are eligible for
 * backfill; an attribution/customerAccountId is never required.
 */
export function planDiscordCommunityHits(records, sourceChannelId, sent = {}, renderVersion = 4) {
  const groups = [];
  for (const record of Array.isArray(records) ? records : []) {
    const ids = sourceMessageIdsForHit(record, sourceChannelId);
    if (!ids.length) continue;
    const existing = groups.find(entry =>
      entry.ids.some(id => ids.includes(id)) || sameCheckout(entry.order, record));
    if (!existing) {
      groups.push({ order: record, ids });
      continue;
    }
    existing.ids = [...new Set([...existing.ids, ...ids])];
    if (updatedAt(record) > updatedAt(existing.order) ||
      (updatedAt(record) === updatedAt(existing.order) &&
       !confirmed(record) && confirmed(existing.order))) {
      existing.order = record;
    }
  }

  const newHits = [], updates = [], withdrawals = [];
  let eligible = 0, unmatched = 0;
  for (const { order, ids } of groups) {
    const prior = ids.filter(id => sent?.[id] && SOURCE_MESSAGE.test(String(sent[id].messageId || "")));
    if (!confirmed(order)) {
      for (const id of prior) withdrawals.push({ sourceMessageId: id, messageId: String(sent[id].messageId),
        reason: "no_longer_confirmed" });
      continue;
    }
    eligible++;
    if (!order.customerAccountId) unmatched++;
    if (prior.length) {
      // Keep one existing bot message for an order, even if multiple webhook
      // events or old bugs once created extra mirrored messages.
      const keeper = prior[0];
      if (Number(sent[keeper].renderVersion || 0) < renderVersion ||
          String(sent[keeper].priceSignature || "") !== checkoutPriceSignature(order)) {
        updates.push({ sourceMessageId: keeper, messageId: String(sent[keeper].messageId), order });
      }
      for (const id of prior.slice(1)) {
        if (String(sent[id].messageId) !== String(sent[keeper].messageId)) {
          withdrawals.push({ sourceMessageId: id, messageId: String(sent[id].messageId),
            reason: "duplicate_same_order" });
        }
      }
      continue;
    }
    // A blank/"posting" ledger entry is an already attempted POST. Do not
    // retry it blindly after a crash: that could create duplicate public hits.
    if (ids.some(id => sent?.[id])) continue;
    newHits.push({ sourceMessageId: ids[0], sourceMessageIds: ids, order });
  }

  // Newest missing purchases first, bounded by the caller to avoid flooding
  // Discord while older confirmed unmatched orders are gradually restored.
  newHits.sort(descendingSourceId);
  return { newHits, updates, withdrawals, eligible, unmatched };
}
