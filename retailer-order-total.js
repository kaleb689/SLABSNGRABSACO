/**
 * Extract an explicitly stated final amount charged from retailer receipts.
 * The caller must ALSO verify the sender and exactly match an existing
 * authoritative Discord checkout by retailer order number. Parsing a number
 * is never a new order or independent evidence of ownership.
 */
const TOTAL_LABEL = /^(?:order\s+total|grand\s+total|final\s+total|paid\s+total|total\s+(?:paid|charged|due)|amount\s+(?:charged|paid)|payment\s+total|you\s+paid|total)$/i;
const NON_FINAL = /\b(?:sub\s*total|estimated|estimate|before\s+tax|before\s+shipping|unit\s+price|per\s+item|each|discount|refund)\b/i;
const MAX_CENTS = 100000000;
function amountCents(raw) {
  const text = String(raw || "").replace(/\*|\u0060|\|\|/g, "").trim();
  if (NON_FINAL.test(text)) return null;
  const match = text.match(/^(?:(?:USD|US\$)\s*)?\$\s*([\d,]{1,10}\.\d{2})(?:\s*(?:USD))?\s*$/i) ||
    text.match(/^(?:USD|US\$)\s*([\d,]{1,10}\.\d{2})\s*$/i);
  if (!match) return null;
  const cents = Math.round(Number(match[1].replace(/,/g, "")) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_CENTS ? cents : null;
}
function normalizeText(value) {
  return String(value || "").replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&dollar;|&#36;/gi, "$")
    .replace(/[\u00a0\u202f]/g, " ").replace(/\r/g, "");
}
function collectExplicitTotals(source, results) {
  const lines = normalizeText(source).split(/\n/).map(line =>
    line.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 1800);
  for (let i = 0; i < lines.length; i++) {
    // Only exact paid-total labels. A product line with "Price" or "Subtotal"
    // cannot establish the retailer's final amount charged.
    const inline = lines[i].match(/^([^:$]{2,65}?)\s*[:\-]?\s*((?:(?:USD|US\$)\s*)?\$[\d,]+\.\d{2}(?:\s*USD)?|USD\s+[\d,]+\.\d{2})$/i);
    if (inline && TOTAL_LABEL.test(inline[1].trim())) {
      const cents = amountCents(inline[2]);
      if (cents !== null) results.push(cents);
      continue;
    }
    if (!TOTAL_LABEL.test(lines[i].replace(/[:\-]\s*$/, "")) || i + 1 >= lines.length) continue;
    // Common HTML/plaintext receipts put the label and charged amount in
    // adjacent table cells or on separate lines.
    const cents = amountCents(lines[i + 1]);
    if (cents !== null) results.push(cents);
  }
}
export function verifiedRetailerOrderTotal(text = "", html = "") {
  const plain = String(text || "").slice(0, 150000);
  const strippedHtml = normalizeText(String(html || "").slice(0, 150000))
    .replace(/<\s*br\b[^>]*>/gi, "\n")
    .replace(/<\s*\/\s*(?:tr|p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*\/?(?:td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  const totals = [];
  collectExplicitTotals(plain, totals);
  collectExplicitTotals(strippedHtml, totals);
  const unique = [...new Set(totals)];
  return unique.length === 1 ? unique[0] / 100 : null;
}
