import { verifiedTinVariants } from "./checkout-product-image-policy.js";

/** Only verified SKU variants, not arbitrary retailer IDs, identify the
 * exact design when a 30th Mini Tin title is generic. */
const tinVariants = new Map(verifiedTinVariants().map(item => [
  item.sku.toLowerCase(), String(item.name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
]));
const knownTinVariantNames = new Set(tinVariants.values());

/** Retailer-independent identity. Preserve editions, pack sizes, exclusives
 * and character variants; collapse only harmless title differences. */
export function communityProductKey(title, sku = "") {
  let value = String(title || "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/&amp;/gi, " and ")
    .replace(/[®©™]/g, " ").trim();

  value = value.replace(/^(?:(?:target|walmart|pkc|pokemon center(?: us)?)\s*(?:[:|]\s*|[-–—]\s+))+/i, "");
  value = value.replace(/\s*(?:\||\s[-–—]\s)\s*(?:target|walmart|pkc|pokemon center(?: us)?)\s*$/i, "");
  value = value.replace(/^(?:pokemon(?!\s+center\b)(?:\s+(?:tcg|trading\s+card\s+game))?|tcg|trading\s+card\s+game)\b\s*(?:[:\-–—]\s*)?/i, "");
  value = value.replace(/\betb\b/gi, "elite trainer box")
    .replace(/\bupc\b/gi, "ultra premium collection")
    .replace(/\b(\d+)\s*pk\b/gi, "$1 pack")
    .replace(/\b(\d+)\s*ct\b/gi, "$1 count")
    .replace(/&/g, " and ").replace(/['’]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ").trim();

  const knownVariant = tinVariants.get(String(sku || "").trim().toLowerCase());
  const marker = "30th celebration mini tin", at = value.indexOf(marker);
  if (knownVariant && at !== -1) {
    const remainder = value.slice(at + marker.length).trim();
    const character = knownVariant.split(" ")[0];
    if (!remainder || remainder === character)
      value = value.slice(0, at + marker.length) + " " + knownVariant;
    else if (knownTinVariantNames.has(remainder)) {
      // The explicit character/design name outranks a contradictory SKU.
    }
  }
  return value;
}

/** Display aggregation never modifies checkouts, ownership or prices. Callers
 * supply authoritative non-cancelled orders, including review holds. */
export function consolidateCommunityProducts(records, {
  normalizeName = value => String(value || "").trim(),
  allowItem = () => true,
  imageFor = (_name, _order, item) => item?.imageUrl || null
} = {}) {
  const products = new Map();
  for (const order of Array.isArray(records) ? records : []) {
    const at = new Date(order?.checkoutAt || order?.updatedAt || order?.createdAt || 0).getTime();
    const timestamp = Number.isFinite(at) ? at : 0;
    for (const item of Array.isArray(order?.items) ? order.items : []) {
      const name = normalizeName(item?.name);
      const quantity = Math.floor(Number(item?.quantity));
      if (!name || !Number.isSafeInteger(quantity) || quantity < 1 || !allowItem(name, item, order)) continue;
      const productKey = communityProductKey(name, item?.sku);
      if (!productKey) continue;
      const prior = products.get(productKey);
      products.set(productKey, {
        name: prior?.name || name,
        productKey,
        quantity: (prior?.quantity || 0) + quantity,
        imageUrl: prior?.imageUrl || imageFor(name, order, item),
        latestPurchasedAt: Math.max(prior?.latestPurchasedAt || 0, timestamp)
      });
    }
  }
  return [...products.values()].sort((a, b) =>
    b.latestPurchasedAt - a.latestPurchasedAt ||
    b.quantity - a.quantity ||
    a.name.localeCompare(b.name)
  ).map(({ latestPurchasedAt, ...product }) => product);
}
