/**
 * Historic, owner-reported community checkout summary.
 * Do not invent order IDs, customers, dates, or retailer receipts for this
 * aggregate. Itemized history from the older screenshots is unavailable.
 */
export const HISTORICAL_COMMUNITY_SNAPSHOT = Object.freeze({
  checkoutCount: 240,
  spentCents: 1587611,
  tinQuantity: 309,
  referenceReconciliationCents: 4,
  referenceCombinedCents: 2049980,
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
    // An owner-reported reference total differs by four cents; this is
    // informational only, not evidence of additional paid checkout value.
    totalSpent: (old.spentCents + liveSpendCents) / 100,
    historicalCheckouts: old.checkoutCount,
    historicalSpent: old.spentCents / 100,
    historicalTinQuantity: old.tinQuantity,
    historicalSummaryOnly: true,
    historicalSource: old.source,
    reportedReconciliation: old.referenceReconciliationCents / 100,
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


/**
 * Stable Admin-only identity label for paid and linked customer checkouts.
 * Prefer real signup/admin names; older customer accounts can have no saved
 * first/last name, so use a recognizable account email as the last fallback
 * rather than an indistinguishable "Customer" for every accordion.
 * NEVER use Shikari retailer logins, webhook profile names or passwords.
 */
export function adminCheckoutCustomerName(account, paidRecord = null) {
  const profiles = [
    account?.adminProfile,
    account?.profile,
    paidRecord?.profile,
    account
  ].filter(value => value && typeof value === "object");
  const first = profiles.map(item => String(item.firstName || "").trim()).find(Boolean) || "";
  const last = profiles.map(item => String(item.lastName || "").trim()).find(Boolean) || "";
  const full = [first, last].filter(Boolean).join(" ").slice(0, 100);
  if (full && !/^customer$/i.test(full)) return full;
  const validName = value => {
    const name = String(value || "").trim();
    return name && !/^(?:customer|aco profile|profile|member|customer profile)$/i.test(name) &&
      !/[\r\n]/.test(name) ? name.slice(0, 100) : "";
  };
  for (const value of [
    account?.name, account?.displayName,
    account?.adminProfile?.profileName, paidRecord?.profile?.profileName,
    account?.profile?.profileName
  ]) {
    const label = validName(value);
    if (label) return label;
  }
  const email = String(account?.email || account?.adminProfile?.email ||
    paidRecord?.profile?.email || "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email.slice(0, 100);
  const id = String(account?.id || paidRecord?.customerAccountId || "").trim();
  return id ? "Customer account " + id.slice(-8) : "Customer account";
}


/**
 * Admin-only aggregate diagnostics for confirmed webhook successes that have
 * no verified website owner. These never become customer checkout records.
 * Preserve PKC and morning counts without fabricating a profile assignment.
 */
export function summarizeUnmatchedCheckouts(records, now=Date.now()) {
  const source=Array.isArray(records)?records:[];
  const day=86400000;
  const within=(order,days)=>{
    const at=Date.parse(order?.checkoutAt||"");
    return Number.isFinite(at)&&at>=now-days*day&&at<=now+60000;
  };
  const byRetailer=new Map();
  for(const record of source){
    const retailer=String(record?.retailer||"Retailer").trim()||"Retailer";
    if(!byRetailer.has(retailer))
      byRetailer.set(retailer,{retailer,total:0,last24h:0,last7d:0,last30d:0});
    const item=byRetailer.get(retailer);
    item.total++;
    if(within(record,1))item.last24h++;
    if(within(record,7))item.last7d++;
    if(within(record,30))item.last30d++;
  }
  return {
    total:source.length,
    last24h:source.filter(record=>within(record,1)).length,
    last7d:source.filter(record=>within(record,7)).length,
    last30d:source.filter(record=>within(record,30)).length,
    byRetailer:[...byRetailer.values()].sort((a,b)=>b.last7d-a.last7d||
      b.total-a.total||a.retailer.localeCompare(b.retailer))
  };
}
