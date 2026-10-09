/**
 * Historic, owner-reported community checkout summary.
 * Do not invent order IDs, customers, dates, or retailer receipts for this
 * aggregate. Itemized history from the older screenshots is unavailable.
 */
export const HISTORICAL_COMMUNITY_SNAPSHOT = Object.freeze({
  checkoutCount: 240,
  spentCents: 1587611,
  tinQuantity: 309,
  source: "owner_reported_earlier_community_tracker",
  itemizedRecordsAvailable: false
});
export function moneyToCents(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}
export function historicalPlusVerified({checkouts=0, spent=0, unknownPrices=0}) {
  const old = HISTORICAL_COMMUNITY_SNAPSHOT;
  const liveCheckouts = Math.max(0, Math.floor(Number(checkouts) || 0));
  const liveSpendCents = moneyToCents(spent);
  return {
    totalCheckouts: old.checkoutCount + liveCheckouts,
    totalSpent: (old.spentCents + liveSpendCents) / 100,
    historicalCheckouts: old.checkoutCount,
    historicalSpent: old.spentCents / 100,
    historicalTinQuantity: old.tinQuantity,
    historicalSummaryOnly: true,
    historicalSource: old.source,
    liveConfirmedCheckouts: liveCheckouts,
    liveVerifiedSpent: liveSpendCents / 100,
    pricePendingCheckouts: Math.max(0, Math.floor(Number(unknownPrices) || 0))
  };
}
/** Avoid passing raw retailer login emails or secrets to UI. */
export function safeAdminProfileLabel(record) {
  const scrub = value => String(value || "").trim()
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[private login]")
    .replace(/(?:password|pass|pwd|token|secret)\s*[:=]\s*\S+/gi, "[hidden]")
    .replace(/\s+/g," ").slice(0, 90);
  const retailer = scrub(record?.retailer) || "Retailer";
  const slot = Math.max(0, Math.floor(Number(record?.profileSlot) || 0));
  const managed = Boolean(record?.managedAccountId);
  const fallback = managed ? "Linked " + retailer + " account" : slot
    ? retailer + " paid profile " + slot : "Unspecified " + retailer + " account";
  const label = scrub(record?.profileName || record?.sourceProfileLabel) || fallback;
  const key = managed ? "managed:" + String(record.managedAccountId)
    : slot ? "paid:" + retailer.toLowerCase() + ":" + slot
    : "profile:" + retailer.toLowerCase() + ":" + label.toLowerCase();
  return { accountKey:key, accountLabel:label, accountKind:managed ? "linked" : slot ? "paid" : "unclassified" };
}
