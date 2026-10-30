/**
 * Compare paid totals reported by Discord with exact-order retailer receipts.
 * The caller MUST match a trusted sender + unique retailer order number first.
 * This module never creates checkouts or changes customer ownership.
 */
function paidCents(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  const cents = Math.round(n * 100);
  return Number.isFinite(n) && Number.isSafeInteger(cents) &&
    cents > 0 && cents <= 100000000 ? cents : null;
}
const priceState = record => JSON.stringify([
  record.orderTotal, record.orderTotalBasis, record.priceSource,
  record.emailReceiptTotal, record.discordReportedTotal,
  record.conflictingEmailTotal, record.priceVerification,
  record.priceVerifiedAt
]);

/** A trusted full retailer receipt takes precedence over a webhook subtotal. */
export function reconcileRetailerEmailTotal(record, total, verifiedAt = null) {
  const amount = paidCents(total);
  if (!record || typeof record !== "object" || amount === null)
    return {changed:false, conflict:false};
  const before = priceState(record);
  const existingEmail = paidCents(record.emailReceiptTotal) ??
    (record.orderTotalBasis === "retailer_receipt" &&
     record.priceSource === "verified_retailer_receipt"
      ? paidCents(record.orderTotal) : null);
  const storedPaid = ["order_total", "retailer_receipt"].includes(record.orderTotalBasis)
    ? paidCents(record.orderTotal) : null;
  const discord = paidCents(record.discordReportedTotal) ??
    (record.orderTotalBasis === "order_total" ? storedPaid : null);

  if (discord !== null) record.discordReportedTotal = discord / 100;
  if (existingEmail !== null && existingEmail !== amount) {
    // Different receipt amounts may be split charges, payment adjustments,
    // or partial shipments. Preserve first evidence and require review.
    record.conflictingEmailTotal = amount / 100;
    record.priceVerification = "conflict";
  } else {
    record.emailReceiptTotal = amount / 100;
    const adminVerified = record.priceSource === "admin_verified_retailer_receipt";
    if (adminVerified) {
      // A human-confirmed corrected price is never rewritten by automation.
      record.priceVerification = storedPaid === amount ? "matched" : "conflict";
    } else {
      record.orderTotal = amount / 100;
      record.orderTotalBasis = "retailer_receipt";
      record.priceSource = "verified_retailer_receipt";
      record.priceVerification = discord === null
        ? "email_verified" : discord === amount ? "matched" : "conflict";
    }
  }
  if (paidCents(record.conflictingEmailTotal) !== null)
    record.priceVerification = "conflict";
  const changed = priceState(record) !== before;
  if (changed && verifiedAt && Number.isFinite(Date.parse(verifiedAt)))
    record.priceVerifiedAt = new Date(verifiedAt).toISOString();
  return {changed, conflict:record.priceVerification === "conflict"};
}

/** A late-arriving explicit final webhook amount can confirm a saved receipt. */
export function reconcileDiscordPaidTotal(record, total) {
  const amount = paidCents(total);
  if (!record || typeof record !== "object" || amount === null)
    return {changed:false, conflict:false};
  const before = priceState(record);
  record.discordReportedTotal = amount / 100;
  const email = paidCents(record.emailReceiptTotal) ??
    (record.priceSource === "verified_retailer_receipt" &&
     record.orderTotalBasis === "retailer_receipt" ? paidCents(record.orderTotal) : null);
  if (email !== null)
    record.priceVerification = email === amount ? "matched" : "conflict";
  else if (record.priceVerification !== "conflict")
    record.priceVerification = "webhook_verified";
  if (paidCents(record.conflictingEmailTotal) !== null)
    record.priceVerification = "conflict";
  return {changed:priceState(record) !== before,
    conflict:record.priceVerification === "conflict"};
}

/** Read-only customer/admin provenance without any email address or credentials. */
export function checkoutPriceEvidence(record) {
  const paid = ["order_total","retailer_receipt"].includes(record?.orderTotalBasis) &&
    paidCents(record?.orderTotal) !== null;
  return {
    priceVerification: String(record?.priceVerification || (paid ? "webhook_verified" : "unverified")),
    priceSource: record?.priceSource === "verified_retailer_receipt" ||
      record?.priceSource === "admin_verified_retailer_receipt"
      ? "retailer_receipt" : paid ? "discord_webhook" : "unverified"
  };
}
