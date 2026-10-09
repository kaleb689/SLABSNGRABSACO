/**
 * Retailer receipt totals are supplemental details for an already-verified
 * Discord checkout, NEVER an independent proof that a purchase happened.
 * Only explicit charged/grand/order totals qualify, never subtotal, estimated
 * price, shipping, tax, product price or a generic unrelated number.
 */
export function verifiedRetailerOrderTotal(text = "", html = "") {
  const plain = String(text || "").slice(0, 150000);
  // Preserve row breaks between HTML labels and amounts, but use only
  // sanitized text. No links, addresses, payment details or account
  // credentials are copied to checkout records.
  const strippedHtml = String(html || "").slice(0, 150000)
    .replace(/<\s*(?:br|\/tr|\/p|\/div|\/li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&");
  const values = [];
  for (const source of [plain, strippedHtml]) {
    for (const line of source.split(/\r?\n/).slice(0, 1200)) {
      const match = line.trim().match(/^(?:order\s+total|grand\s+total|total\s+charged|total\s+paid|amount\s+charged|amount\s+paid)\s*[:\-]?\s*(?:USD\s*)?\$\s*([\d,]{1,10}\.\d{2})(?:\s|$)/i);
      if (!match) continue;
      const cents = Math.round(Number(match[1].replace(/,/g, "")) * 100);
      if (Number.isSafeInteger(cents) && cents > 0 && cents <= 100000000) values.push(cents);
    }
  }
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] / 100 : null;
}
