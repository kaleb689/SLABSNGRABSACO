/**
 * Manual price entry may supplement ONLY an already-confirmed Discord order.
 * The admin must have the real retailer receipt and re-enter its order number.
 * No order may be created, moved to a customer, or repriced from unit prices.
 */
export function adminVerifiedReceiptTotal(input, checkout) {
  if (input?.verifiedReceipt !== true || !checkout?.orderNumber) return null;
  const normalizedNumber = value => String(value || "").trim().replace(/^#/, "").toLowerCase();
  if (normalizedNumber(input?.orderNumberConfirmation) !== normalizedNumber(checkout.orderNumber)) return null;
  const amountText = String(input?.paidTotal ?? "").trim();
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(amountText)) return null;
  const cents = Math.round(Number(amountText) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 100000000) return null;
  return cents / 100;
}
