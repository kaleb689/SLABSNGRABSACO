import { createHash } from "node:crypto";
/**
 * Checkout totals must originate from an explicit paid total on the
 * authoritative Discord checkout webhook or a verified retailer receipt.
 * Unit prices and item subtotals exclude potential taxes, fees and shipping.
 */
export function checkoutPaidAmount(order) {
  const amount = Number(order?.orderTotal);
  const basis = String(order?.orderTotalBasis || "").trim().toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return null;
  if (basis !== "order_total" && basis !== "retailer_receipt" &&
    !(basis === "" && order?.priceSource === "verified_retailer_receipt")) return null;
  return Math.round(amount * 100) / 100;
}

export function checkoutItemSubtotal(order) {
  if (String(order?.orderTotalBasis || "").trim().toLowerCase() !== "item_subtotal") return null;
  const amount = Number(order?.orderTotal);
  return Number.isFinite(amount) && amount > 0 && amount <= 1000000
    ? Math.round(amount * 100) / 100 : null;
}

export function checkoutUnitPrice(item) {
  const amount = Number(item?.price);
  return Number.isFinite(amount) && amount > 0 && amount <= 1000000
    ? Math.round(amount * 100) / 100 : null;
}

// Order value is earned when the retailer confirms the checkout, including
// preorders. It is distinct from a verified charge and never invents fees.
export function checkoutOrderValue(order) {
  const total = checkoutPaidAmount(order);
  if (total !== null) return { amount: total, basis: "order_total" };
  const subtotal = checkoutItemSubtotal(order);
  if (subtotal !== null) return { amount: subtotal, basis: "item_subtotal" };
  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return { amount: null, basis: "unknown" };
  let cents = 0;
  for (const item of items) {
    const price = checkoutUnitPrice(item), quantity = Number(item?.quantity);
    if (price === null || !Number.isSafeInteger(quantity) || quantity < 1) {
      return { amount: null, basis: "unknown" };
    }
    cents += Math.round(price * 100) * quantity;
  }
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100000000
    ? { amount: cents / 100, basis: "item_subtotal" }
    : { amount: null, basis: "unknown" };
}

export function checkoutPriceSignature(order) {
  // All visible item details and the final verified amount affect the public
  // hit. Hash the signature so the ledger does not retain product image URLs
  // or display text, and changes to item 10+ still refresh existing hits.
  const detail = JSON.stringify({
    paid: checkoutPaidAmount(order),
    subtotal: checkoutItemSubtotal(order),
    items: (Array.isArray(order?.items) ? order.items : [])
      .map(item => [
        String(item?.name || "").slice(0, 300),
        checkoutUnitPrice(item),
        Math.max(0, Math.floor(Number(item?.quantity) || 0)),
        String(item?.imageUrl || "").slice(0, 2000)
      ])
  });
  return createHash("sha256").update(detail).digest("hex");
}

/**
 * Parse ONLY explicitly named paid totals from the source webhook.
 * A 'price', 'subtotal' or estimated amount never proves the paid total.
 * Conflicting explicit totals are rejected instead of silently guessed.
 */
export function checkoutExplicitPaidTotal(message) {
  const totalLabel = /^(?:order total|checkout total|grand total|total|total paid|total charged|total spent at checkout|amount paid|amount charged|paid total|payment total)$/i;
  const money = raw => {
    const value = String(raw || "").replace(/[\x60*]|\|\|/g, "").trim();
    const match = value.match(/^(?:(?:USD|US\$)\s*)?\$?\s*([\d,]{1,10}\.\d{2})(?:\s*(?:USD))?$/i);
    if (!match) return null;
    const cents = Math.round(Number(match[1].replace(/,/g, "")) * 100);
    return Number.isSafeInteger(cents) && cents > 0 && cents <= 100000000
      ? cents / 100 : null;
  };
  const values = [];
  const add = (label, value) => {
    if (!totalLabel.test(String(label || "").replace(/[*_`]/g, "").trim())) return;
    const total = money(value);
    if (total !== null) values.push(Math.round(total * 100));
  };
  const readText = text => {
    const lines = String(text || "").split(/\r?\n/).map(line => line.replace(/[*_`]/g, "").trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const inline = lines[i].match(/^([^:\n]{2,75}):\s*(.+)$/);
      if (inline) { add(inline[1], inline[2]); continue; }
      if (totalLabel.test(lines[i]) && i + 1 < lines.length) add(lines[i], lines[i+1]);
    }
  };
  readText(message?.content);
  for (const embed of Array.isArray(message?.embeds) ? message.embeds : []) {
    for (const field of Array.isArray(embed?.fields) ? embed.fields : []) add(field.name,field.value);
    readText(embed?.description);
  }
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] / 100 : null;
}
