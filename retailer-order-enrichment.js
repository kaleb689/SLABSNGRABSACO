/**
 * PKC shipment emails are supporting evidence for an EXISTING exact-number,
 * Discord-confirmed checkout. They are never a new checkout or proof of owner.
 * The caller must first verify the sender and exact retailer order number.
 */
const MAX_PRODUCTS = 120;
const amount = value => {
  const match = String(value || "").trim().match(/^\$([\d,]{1,8}\.\d{2})$/);
  if (!match) return null;
  const cents = Math.round(Number(match[1].replace(/,/g, "")) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100000000 ? cents / 100 : null;
};
const normalize = value => String(value || "").normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim();
const normalizedName = name => {
  const text = String(name || "").trim();
  const tin = text.match(/30th\s+Celebration\s+Mini\s+Tin\s*[-–—:]\s*([a-z]+)\s*\((Day|Night)\)/i);
  return tin ? "30th-mini-tin:" + tin[1].toLowerCase() + ":" + tin[2].toLowerCase() : normalize(text);
};

function linesFromEmail(value, html = false) {
  let source = String(value || "").slice(0, 250000);
  if (html) source = source
    .replace(/<\s*(?:script|style)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, " ")
    .replace(/<\s*br\b[^>]*>/gi, "\n")
    .replace(/<\s*\/(?:div|p|tr|li|h[1-6]|table|section)\s*>/gi, "\n")
    .replace(/<\s*\/?(?:td|th)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return source
    .replace(/&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi, (whole,hex,dec) => {
      const code = parseInt(hex || dec, hex ? 16 : 10);
      return Number.isInteger(code) && code > 31 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
    })
    .replace(/&eacute;/gi, "é")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/\u00a0/g, " ").replace(/\r/g, "")
    .split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function scanSummary(lines) {
  const items = [];
  let inSummary = false, current = null;
  const finish = () => {
    if (current && current.sku && Number.isInteger(current.quantity) &&
      current.quantity > 0 && current.quantity <= 99) items.push(current);
    current = null;
  };
  for (const line of lines) {
    if (/^order\s+summary\s*:?$/i.test(line)) {
      finish();
      inSummary = true;
      continue;
    }
    if (!inSummary) continue;
    if (/^(?:customer support|the pok[eé]mon company|terms of use|privacy notice|tracking history|shipping details|order details|billing details|payment details|subtotal|order subtotal|order total|total|grand total)\b/i.test(line)) {
      finish();
      break;
    }
    const product = line.match(/^(Pok[eé]mon\s+TCG\s*:\s*[^<>]{5,220})$/i);
    if (product && !/@|\b(?:password|login|address|phone|security code|credit card|cvv)\b/i.test(product[1])) {
      finish();
      current = {name: product[1].replace(/\s+/g, " ").trim(), sku: null, quantity: null};
      if (items.length >= MAX_PRODUCTS) break;
      continue;
    }
    if (!current) continue;
    const sku = line.match(/^SKU\s*#?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,49})$/i);
    if (sku) { current.sku = sku[1]; continue; }
    const qty = line.match(/^(?:Qty|Quantity)\s*[:\-]\s*(\d{1,3})$/i);
    if (qty) current.quantity = Number(qty[1]);
  }
  finish();
  const seen = new Set();
  return items.filter(item => {
    const key = item.sku.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(item => ({name: item.name, sku: item.sku, quantity: item.quantity}));
}

export function pokemonCenterFulfillmentDetails({subject = "", text = "", html = ""} = {}) {
  const sources = [linesFromEmail(text), linesFromEmail(html, true)];
  // PKC order summaries consistently enumerate each SKU with a quantity.
  // Prefer the complete copy when both plaintext and HTML are available.
  const summaries = sources.map(scanSummary);
  const items = summaries.sort((a, b) => b.length - a.length)[0] || [];
  const all = [String(subject || ""), ...sources.flat()].join("\n");
  const subtotalCandidates = sources.flat().flatMap(line => {
    const match = line.match(/^order\s+subtotal\s*:\s*(\$[\d,]+\.\d{2})$/i);
    return match ? [amount(match[1])] : [];
  }).filter(value => value !== null);
  const uniqueSubtotal = [...new Set(subtotalCandidates)];
  const track = all.match(/\btracking\s*(?:number|#)\s*[:\-]\s*([A-Z0-9-]{8,35})\b/i);
  const trackingNumber = track ? track[1].replace(/-/g, "") : null;
  const carrier = trackingNumber
    ? /\bFedEx\b/i.test(all) ? "FedEx"
      : /\bUPS\b/i.test(all) ? "UPS"
      : /\bUSPS\b|United States Postal Service/i.test(all) ? "USPS" : null
    : null;
  return {
    items,
    subtotal: uniqueSubtotal.length === 1 ? uniqueSubtotal[0] : null,
    trackingNumber,
    carrier
  };
}

export function mergeRetailerFulfillmentItems(existing, receipt) {
  const prior = Array.isArray(existing) ? existing : [];
  const sourced = Array.isArray(receipt) ? receipt : [];
  const final = prior.filter(item =>
    String(item?.name || "").trim().toLowerCase() !== "product details unavailable"
  ).map(item => ({...item}));
  const keys = new Map();
  for (const [index, item] of final.entries()) {
    if (item.sku) keys.set("sku:" + String(item.sku).toLowerCase(), index);
    keys.set("name:" + normalizedName(item.name), index);
  }
  for (const source of sourced) {
    if (!source || !source.name || !source.sku ||
        !Number.isInteger(source.quantity) || source.quantity < 1) continue;
    const nameKey = "name:" + normalizedName(source.name);
    const skuKey = "sku:" + String(source.sku).toLowerCase();
    if (!normalizedName(source.name)) continue;
    const index = keys.has(skuKey) ? keys.get(skuKey) : keys.get(nameKey);
    if (index !== undefined) {
      const target = final[index];
      // Shipment emails are not evidence of a unit price or an increase in
      // quantity when the trusted webhook already carries a larger amount.
      target.quantity = Math.max(Number(target.quantity) || 0, source.quantity);
      if (!target.sku) target.sku = source.sku;
    } else {
      keys.set(nameKey, final.length);
      keys.set(skuKey, final.length);
      final.push({ name: source.name, sku: source.sku,
        quantity: source.quantity, price: 0, imageUrl: null });
    }
  }
  const before = JSON.stringify(prior);
  return {items: final, changed: JSON.stringify(final) !== before,
    itemCount: final.reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item.quantity) || 0)), 0)};
}
