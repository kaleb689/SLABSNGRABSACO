import { createHash } from "node:crypto";

const hashLogin = value => createHash("sha256")
  .update(String(value || "").trim().toLowerCase()).digest("hex");

function easternCheckoutDay(timestamp) {
  const at = new Date(timestamp || "");
  if (!Number.isFinite(at.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(at);
  const get = key => parts.find(part => part.type === key)?.value || "";
  return [get("year"), get("month"), get("day")].join("-");
}

/**
 * A manually verified ORIGINAL Discord checkout establishes evidence that
 * one retailer login belonged to the customer ON THAT CHECKOUT DATE.
 * It does not establish perpetual ownership: these accounts may be reassigned.
 * Never infer ownership from product name, account label or a billing email.
 */
export function verifiedSameDayCheckoutOwner(order, identity, records = [], candidates = [],
  eligible = () => false) {
  const email = String(identity?.email || "").trim().toLowerCase();
  const retailer = String(order?.retailer || "");
  const day = easternCheckoutDay(order?.checkoutAt);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
      !retailer || !day || !/^discord:\d{17,22}:\d{17,22}$/.test(String(order?.id || "")) ||
      /cancel|refund|failed|declined/i.test(String(order?.status || ""))) return null;
  const loginHash = hashLogin(email);
  const verified = records.filter(record =>
    record?.attributionSource === "admin_verified_original_discord_checkout" &&
    record.attributionAudit?.verification === "owner_confirmed_historical_retailer_account" &&
    record.attributionAudit?.retailerLoginHash === loginHash &&
    record.attributionAudit?.retailer === retailer &&
    record.retailer === retailer &&
    easternCheckoutDay(record.checkoutAt) === day &&
    record.customerAccountId &&
    String(record.attributionAudit?.customerAccountId || "") === String(record.customerAccountId) &&
    !/cancel|refund|failed|declined/i.test(String(record.status || "")));
  const owners = new Set(verified.map(record => String(record.customerAccountId)));
  if (owners.size !== 1) return null;
  const customerAccountId = [...owners][0];

  // A real, time-valid assignment takes precedence over this same-day
  // recovery. Never override a conflicting assignment or a prior owner.
  const exactOwners = new Set(candidates.filter(candidate =>
    candidate.email === email && candidate.retailer === retailer &&
    candidate.customerAccountId && eligible(candidate, order))
    .map(candidate => String(candidate.customerAccountId)));
  if (exactOwners.size > 1 || (exactOwners.size === 1 && !exactOwners.has(customerAccountId)))
    return null;
  const alreadyOwned = records.find(record =>
    record.customerAccountId && String(record.customerAccountId) !== customerAccountId &&
    [record.id, ...(record.sourceIds || [])].includes(order.id));
  if (alreadyOwned) return null;
  return { customerAccountId, attributionSource: "admin_verified_same_day_retailer_login" };
}
