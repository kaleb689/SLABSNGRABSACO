/**
 * Owner-approved IMAP receipts enrich an existing Discord checkout only after
 * trusted retailer sender and exact unique retailer order-number matching.
 * This module handles PRICE evidence; it never creates orders or changes owners.
 */
const cents = value => {
  const number = Number(value);
  const result = Math.round(number * 100);
  return Number.isFinite(number) && Number.isSafeInteger(result) &&
    result > 0 && result <= 100000000 ? result : null;
};
const dollars = value => cents(value) === null ? null : cents(value) / 100;
const snapshot = record => JSON.stringify([
  record.orderTotal, record.orderTotalBasis, record.priceSource,
  record.emailReceiptTotal, record.discordReportedTotal,
  record.priceVerification, record.priceVerifiedAt
]);

/**
 * A final order total from a trusted retailer email is stronger than a
 * provisional item subtotal. Two *different* claimed final paid amounts are
 * a conflict, not permission to silently replace the first value.
 */
export function reconcileRetailerEmailTotal(record, amount, verifiedAt = null) {
  if (!record || typeof record !== "object" || cents(amount) === null)
    return { changed: false, priceChanged: false, conflict: false };
  const before = snapshot(record);
  const priorPaid = ["order_total", "retailer_receipt"].includes(record.orderTotalBasis)
    ? dollars(record.orderTotal) : null;
  const emailTotal = dollars(amount);
  const previousEmail = dollars(record.emailReceiptTotal);
  const discordTotal = dollars(record.discordReportedTotal) ||
    (record.orderTotalBasis === "order_total" ? priorPaid : null);
  if (record.priceSource === "admin_verified_retailer_receipt") {
    // An owner-verified admin correction is immutable to an automated scan.
    return { changed: false, priceChanged: false, conflict: false };
  }
  if (record.orderTotalBasis === "order_total" && priorPaid !== null &&
      dollars(record.discordReportedTotal) === null) record.discordReportedTotal = priorPaid;
  if (previousEmail !== null && previousEmail !== emailTotal) {
    record.priceVerification = "conflict";
    // Retain both amounts in the private audit; do not replace the first
    // accepted retailer receipt with a later, potentially partial payment.
  } else {
    record.emailReceiptTotal = emailTotal;
    if (record.orderTotalBasis === "order_total" && priorPaid !== null) {
      record.priceVerification = cents(priorPaid) === cents(emailTotal)
        ? "matched" : "conflict";
    } else if (record.orderTotalBasis === "retailer_receipt" && priorPaid !== null) {
      record.priceVerification = cents(priorPaid) !== cents(emailTotal)
        ? "conflict" : discordTotal === null ? "email_verified" :
          cents(discordTotal) === cents(emailTotal) ? "matched" : "conflict";
    } else {
      // Webhook omitted a final amount or gave only an item subtotal.
      record.orderTotal = emailTotal;
      record.orderTotalBasis = "retailer_receipt";
      record.priceSource = "verified_retailer_receipt";
      record.priceVerification = "email_verified";
    }
  }
  const changed = snapshot(record) !== before;
  if (changed && verifiedAt && Number.isFinite(Date.parse(verifiedAt)))
    record.priceVerifiedAt = new Date(verifiedAt).toISOString();
  return { changed, priceChanged: dollars(record.orderTotal) !== priorPaid,
    conflict: record.priceVerification === "conflict" };
}

/** Compare a late-arriving explicit Discord total with a saved email receipt. */
export function reconcileDiscordPaidTotal(record, amount) {
  if (!record || typeof record !== "object" || cents(amount) === null)
    return { changed: false, conflict: false };
  const before = snapshot(record);
  const total = dollars(amount);
  record.discordReportedTotal = total;
  const emailTotal = dollars(record.emailReceiptTotal) ||
    (record.orderTotalBasis === "retailer_receipt" &&
     record.priceSource === "verified_retailer_receipt" ? dollars(record.orderTotal) : null);
  if (emailTotal !== null && record.priceSource !== "admin_verified_retailer_receipt")
    record.priceVerification = cents(total) === cents(emailTotal) ? "matched" : "conflict";
  return { changed: snapshot(record) !== before,
    conflict: record.priceVerification === "conflict" };
}
