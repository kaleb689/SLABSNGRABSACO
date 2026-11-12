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
    if (!prices.target?.locked && target?.seller === "Target" && tPrice !== null && tUrl) {
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


// TCGCSV publishes cached TCGplayer market prices for server-side syncs.
// Sync a narrow set of Pokemon groups only, at most once per published dataset.
// No TCGplayer API keys and no direct TCGplayer scraping are required.
const TCGCSV = "https://tcgcsv.com";
const TCGCSV_UA = "SLABSNGRABSACO-TargetSKUTracker/1.0 (daily Pokemon sealed catalog)";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function tcgcsvGet(route, asText=false) {
  const response = await fetch(TCGCSV + route, {
    headers: { "User-Agent": TCGCSV_UA, Accept: asText ? "text/plain" : "application/json" },
    signal: AbortSignal.timeout(30000), redirect: "error"
  });
  if (!response.ok) throw Error("TCGCSV " + route + " HTTP " + response.status);
  return asText ? (await response.text()).trim() : (await response.json()).results;
}
const relevantPokemonGroup = name =>
  /ascended heroes|prismatic evolutions|black bolt|white flare|paldean fates|30th|anniversary|celebration|miscellaneous|mega evolution|promo|special collection/i.test(String(name || ""));
const normalizedProduct = name => String(name || "")
  .normalize("NFKD").toLowerCase().replace(/pok[eé]mon|pokemon/gi, "")
  .replace(/\b(tcg|mega evolution)\b/gi, " ")
  .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const matchingNames = (a,b) => normalizedProduct(a) === normalizedProduct(b);
const validTcgProductUrl = url => {
  try {
    const result = new URL(url);
    return result.protocol === "https:" &&
      ["www.tcgplayer.com", "tcgplayer.com"].includes(result.hostname) &&
      /^\/product\/\d+\//.test(result.pathname);
  } catch { return false; }
};
export async function fetchTcgcsvPokemonMarket(master, previousBuild="") {
  const latest = await tcgcsvGet("/last-updated.txt", true);
  if (!latest || latest === previousBuild) return {build:latest, unchanged:true, products:[]};
  await wait(120);
  const groups = await tcgcsvGet("/tcgplayer/3/groups");
  if (!Array.isArray(groups)) throw Error("TCGCSV Pokemon groups unavailable");
  const candidates = groups.filter(g => relevantPokemonGroup(g?.name)).slice(0,70);
  // Target master can contain multiple listings of the same base product.
  // Skip shared display names: a Target TCIN alone cannot distinguish variants
  // in the TCGplayer catalog.
  const counts = new Map();
  for (const item of Object.values(master.entries || {})) {
    const key = normalizedProduct(item.name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const requested = new Map();
  for (const item of Object.values(master.entries || {})) {
    const key = normalizedProduct(item.name);
    if (!key || /pending|unverified/i.test(item.name) || counts.get(key) !== 1) continue;
    requested.set(key, String(item.sku));
  }
  const matched = new Map(), ambiguous = new Set();
  let groupsFetched = 0;
  for (const group of candidates) {
    await wait(150);
    const products = await tcgcsvGet("/tcgplayer/3/" + encodeURIComponent(group.groupId) + "/products");
    groupsFetched++;
    if (!Array.isArray(products)) continue;
    const matching = products.filter(product =>
      requested.has(normalizedProduct(product.name)) && validTcgProductUrl(product.url) &&
      !product.presaleInfo?.isPresale);
    if (!matching.length) continue;
    await wait(150);
    const prices = await tcgcsvGet("/tcgplayer/3/" + encodeURIComponent(group.groupId) + "/prices");
    if (!Array.isArray(prices)) continue;
    for (const product of matching) {
      const key = normalizedProduct(product.name);
      const market = prices.filter(p => String(p.productId) === String(product.productId)
        && /^(normal|)$/i.test(String(p.subTypeName || "")) && money(p.marketPrice) !== null);
      if (market.length !== 1) continue;
      if (matched.has(key) && matched.get(key).productId !== product.productId) {
        ambiguous.add(key);
        continue;
      }
      matched.set(key, {sku:requested.get(key), productId:product.productId,
        url:product.url, marketPrice:money(market[0].marketPrice)});
    }
  }
  const products = [...matched.entries()].filter(([key]) => !ambiguous.has(key))
    .map(([, product]) => product);
  return {build:latest, products, groupsFetched, candidates:candidates.length,
    unmatched:requested.size - products.length, ambiguous:ambiguous.size};
}
export function applyTcgcsvPokemonMarket(master, report, at=new Date().toISOString()) {
  if (!master?.entries || !Array.isArray(report?.products)) throw Error("Invalid TCGCSV market report.");
  const next = structuredClone(master);
  let updated=0;
  for (const product of report.products) {
    const entry = next.entries[product.sku];
    if (!entry || money(product.marketPrice) === null || !validTcgProductUrl(product.url)) continue;
    // Product-name check is repeated at mutation time in case a Discord
    // moderator renamed the product during the network sync.
    if (!entry.name || !entry.sku) continue;
    entry.prices ||= {};
    entry.prices.tcgplayer={marketPrice:product.marketPrice, url:product.url,
      productId:product.productId, checkedAt:at, source:"TCGCSV"};
    updated++;
  }
  if (updated) {next.pricesUpdatedAt=at;next.updatedAt=at;}
  return {master:next,updated};
}
