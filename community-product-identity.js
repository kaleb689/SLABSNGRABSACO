import { verifiedTinVariants } from "./checkout-product-image-policy.js";

/** Only verified SKU variants, not arbitrary retailer IDs, identify the
 * exact design when a 30th Mini Tin title is generic. */
const tinVariants = new Map(verifiedTinVariants().map(item => [
  item.sku.toLowerCase(), String(item.name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
]));
const knownTinVariantNames = new Set(tinVariants.values());

// Exact retailer title aliases observed for the same product. Pack counts
// remain significant everywhere else, including multipacks and bundles of two.
const retailerTitleAliases = new Map([
  ["mega evolution delta reign booster bundle 6 packs", "mega evolution delta reign booster bundle"],
  ["mega evolution pitch black booster bundle 6 packs", "mega evolution pitch black booster bundle"],
  ["mega evolution 5 pitch black booster bundle", "mega evolution pitch black booster bundle"],
  ["mega evolution 5 pitch black elite trainer box", "mega evolution pitch black elite trainer box"]
]);

// Webhook titles sometimes repeat a retailer identifier before the product.
// Strip only code-shaped prefixes, never editions such as (151) or (3-Pack).
const skuPrefix = /^\s*\((?:(?:sku|pid|tcin|dpci)\s*[:#]?\s*)?([a-z0-9]+(?:-[a-z0-9]+)+|\d{8,})\)\s*/i;
export function communityProductName(title) {
  let name = String(title || "").trim(), match;
  while ((match = name.match(skuPrefix)) && /\d/.test(match[1]) &&
    !/\b(?:pack|count|pk|ct|edition|anniversary)\b/i.test(match[1])) name = name.slice(match[0].length).trim();
  return name;
}

/** Retailer-independent identity. Preserve editions, pack sizes, exclusives
 * and character variants; collapse only harmless title differences. */
export function communityProductKey(title, sku = "") {
  const embeddedSku = String(title || "").match(skuPrefix)?.[1] || "";
  let value = communityProductName(title).normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/&amp;/gi, " and ")
    .replace(/[®©™]/g, " ").trim();

  value = value.replace(/^(?:(?:target|walmart|pkc|pokemon center(?: us)?)\s*(?:[:|]\s*|[-–—]\s+))+/i, "");
  value = value.replace(/\s*(?:\||\s[-–—]\s)\s*(?:target|walmart|pkc|pokemon center(?: us)?)\s*$/i, "");
  value = communityProductName(value);
  value = value.replace(/^(?:pokemon(?!\s+center\b)(?:\s+(?:tcg|trading\s+card\s+games?))?|tcg|trading\s+card\s+games?)\b\s*(?:[:\-–—]\s*)?/i, "");
  value = value.replace(/\betb\b/gi, "elite trainer box")
    .replace(/\bupc\b/gi, "ultra premium collection")
    .replace(/\b(\d+)\s*pk\b/gi, "$1 pack")
    .replace(/\b(\d+)\s*ct\b/gi, "$1 count")
    .replace(/&/g, " and ").replace(/['’]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ").trim();
  value = retailerTitleAliases.get(value) || value;

  const knownVariant = tinVariants.get(String(sku || embeddedSku).trim().toLowerCase());
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
      const name = communityProductName(normalizeName(item?.name));
      const quantity = Math.floor(Number(item?.quantity));
      if (!name || !Number.isSafeInteger(quantity) || quantity < 1 || !allowItem(name, item, order)) continue;
      const productKey = communityProductKey(normalizeName(item?.name),
        item?.sku || String(item?.name || "").match(skuPrefix)?.[1]);
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
