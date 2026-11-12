// Price data must come from a licensed/authorized feed. This module never
// scrapes Target or TCGplayer pages, and never guesses prices.
const money = value => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 50000
  ? Math.round(value * 100) / 100 : null;
const skuKey = value => String(value || "").trim();
const targetUrl = (url, sku) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "target.com" ||
      parsed.hostname === "www.target.com") && parsed.pathname.includes(sku) ? parsed.href : null;
  } catch { return null; }
};
const tcgUrl = url => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "tcgplayer.com" ||
      parsed.hostname === "www.tcgplayer.com") ? parsed.href : null;
  } catch { return null; }
};
export function applyAuthorizedSkuPrices(master, document, at = new Date().toISOString()) {
  if (!master?.entries || !document || !Array.isArray(document.products))
    throw Error("Price feed must provide a products array.");
  const next = structuredClone(master);
  let updated = 0, rejected = 0;
  const seen = new Set();
  for (const row of document.products) {
    const sku = skuKey(row?.sku);
    if (!next.entries[sku] || seen.has(sku)) { rejected++; continue; }
    seen.add(sku);
    const old = next.entries[sku];
    const target = row?.target;
    const tcg = row?.tcgplayer;
    // Target price is *only* accepted with seller Target, matching TCIN link.
    const tPrice = money(target?.price);
    const tUrl = targetUrl(target?.url, sku);
    // TCGplayer market price is only accepted from an authorized provider's
    // exact TCGplayer product URL, not an arbitrary marketplace listing.
    const mPrice = money(tcg?.marketPrice);
    const mUrl = tcgUrl(tcg?.url);
    const prices = {...(old.prices || {})};
    let changed = false;
    if (target?.seller === "Target" && tPrice !== null && tUrl) {
      prices.target = {price:tPrice, url:tUrl, checkedAt:at, seller:"Target"};
      changed = true;
    } else if (target !== undefined) rejected++;
    if (mPrice !== null && mUrl && tcg?.authorized === true) {
      prices.tcgplayer = {marketPrice:mPrice, url:mUrl, checkedAt:at};
      changed = true;
    } else if (tcg !== undefined) rejected++;
    if (changed) {
      next.entries[sku] = {...old, prices};
      updated++;
    }
  }
  if (updated) { next.updatedAt = at; next.pricesUpdatedAt = at; }
  return {master:next, updated, rejected};
}
export async function fetchAuthorizedSkuPriceFeed(url, token) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:") throw Error("SKU price feed must use HTTPS.");
  const headers = {Accept:"application/json"};
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetch(endpoint.href, {headers, signal:AbortSignal.timeout(20000), redirect:"error"});
  if (!response.ok) throw Error("SKU pricing feed HTTP " + response.status);
  const text = await response.text();
  if (text.length > 200000) throw Error("SKU price feed exceeds size limit.");
  return JSON.parse(text);
}
