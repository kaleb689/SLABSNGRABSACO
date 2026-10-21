// Read-only formatter for staff-pasted retailer monitoring posts.
// Parsing never reaches external links or guesses product IDs.
export const FORMATTED_DROP_MARKER = "SLABSNGRABSACO | formatted drop";
const COLOR = 0x38dce8;
const clean = value => String(value || "").replace(/[*_`~]/g, "").trim();
const safe = value => String(value || "").replace(/[\r\n<>@`]/g, " ").trim();
function isNoise(line) {
  return /^(?:walmart draws?|target drops?|pkc drops?|pokemon(?: center)? drops?|costco drops?|sam.?s drops?|poke signals|app|monitors\b|links?\b|image\b|seller\b|type\b|new product\b|time\b|cart limit\b|pid\b|sku\b|ebay\b|report bugs\b|@)/i.test(line);
}
export function parseMonitorDropProducts(input) {
  const lines = String(input || "").split(/\r?\n/).map(clean).filter(Boolean);
  const products = [], seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const priceLabel = /^Price\b\s*:?[ \t]*(.*)$/i.exec(lines[i]);
    if (!priceLabel) continue;
    const name = lines[i - 1];
    if (!name || isNoise(name) || name.length > 350) continue;
    const inline = priceLabel[1]?.trim() || "";
    const amountLine = inline || lines[i + 1] || "";
    const amount = /^\$?\s*([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(?:USD)?$/i.exec(amountLine);
    if (!amount) continue;
    const number = Number(amount[1].replace(/,/g, ""));
    if (!Number.isFinite(number) || number <= 0 || number > 1_000_000) continue;
    let sku = "";
    for (let j = i + (inline ? 1 : 2); j < Math.min(lines.length, i + 24); j++) {
      if (/^Price\b/i.test(lines[j])) break;
      const match = /^(?:PID|SKU)\s*(?:[:#-]\s*|\s+)([A-Z0-9][A-Z0-9._-]{2,79})\s*$/i.exec(lines[j]);
      if (match) { sku = match[1].toUpperCase(); break; }
      if (/^(?:PID|SKU)\s*$/i.test(lines[j]) && /^[A-Z0-9][A-Z0-9._-]{2,79}$/i.test(lines[j + 1] || "")) {
        sku = lines[j + 1].toUpperCase(); break;
      }
    }
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    products.push({ name, price: number.toFixed(2), sku });
  }
  return products.slice(0, 200);
}
export function formattedDropName(label) {
  const name = String(label || "Retailer").replace(/\s+Drops?$/i, "").trim();
  if (/walmart/i.test(name)) return "Walmart Draw";
  if (/^pkc$/i.test(name)) return "PKC Drop";
  if (/upcoming/i.test(name)) return "Upcoming Drop";
  if (/tonight/i.test(name)) return "Dropping Tonight";
  return (name || "Retailer") + " Drop";
}
export function formattedDropPayloads(products, label) {
  if (!Array.isArray(products) || !products.length) return [];
  const title = formattedDropName(label);
  const result = [];
  // Discord accepts at most 10 embeds and 6000 total embed characters per message.
  for (let start = 0; start < products.length; start += 10) {
    const block = products.slice(start, start + 10);
    const count = Math.ceil(products.length / 10);
    const embeds = block.map((product, i) => ({
      ...(i === 0 ? { title: title + (count > 1 ? ` (${result.length + 1}/${count})` : "") } : {}),
      description: `**${safe(product.name).replace(/\*/g, "") .slice(0, 280)}**\nPrice $${Number(product.price).toFixed(2)}\nSKU: ${safe(product.sku).slice(0, 80)}`,
      color: COLOR,
      footer: { text: FORMATTED_DROP_MARKER }
    }));
    result.push({ content: "**" + title + "**", embeds, allowed_mentions: { parse: [] } });
  }
  return result;
}
export function isFormattedDropPost(message, botId) {
  return Boolean(botId && message?.author?.bot && String(message.author.id) === String(botId) &&
    !message.webhook_id && Array.isArray(message.embeds) &&
    message.embeds.some(embed => embed?.footer?.text === FORMATTED_DROP_MARKER));
}
