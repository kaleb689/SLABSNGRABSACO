/**
 * Retailer-verified, SKU-specific product artwork.
 * These are PUBLIC product photographs, never customer/profile images.
 * Prefer exact, SKU-specific art over an unrelated webhook thumbnail.
 * Missing/unknown products should remain image-pending, not show our logo.
 */
const thirtyCelebrationTins = Object.freeze({
  "166": { label:"Mew (Day)", url:"https://thecollectionrealm.com/cdn/shop/files/Pokemon30thCelebrationMiniTinMew.jpg?v=1783347540" },
  "167": { label:"Pikachu (Day)", url:"https://card-binder.com/cdn/shop/files/Pokemon_TCG_30th_Celebration_Mini_Tin_Day_Pikachu.webp?v=1782911419" },
  "168": { label:"Espeon (Day)", url:"https://totalcards.net/cdn/shop/files/1782826856_98f84fe59cdbf11e75e8679a19b4f2d2.webp?v=1782826867" },
  "169": { label:"Lapras (Day)", url:"https://totalcards.net/cdn/shop/files/1782826800_87b833468a5ee8a55865f77735218e9d.webp?v=1782826812" },
  "170": { label:"Moltres (Day)", url:"https://totalcards.net/cdn/shop/files/1782826948_7011c80010dcd79989f6a22fee1daa6d.webp?v=1782826974" },
  "171": { label:"Mewtwo (Night)", url:"https://totalcards.net/cdn/shop/files/1782827056_30734bdd4ee0e5aaea3c176c61d7c73e.webp?v=1782827122" },
  "172": { label:"Pikachu (Night)", url:"https://totalcards.net/cdn/shop/files/1782827210_949c6a867684a8a91733ff88a15125ed.webp?v=1782827239" },
  "173": { label:"Umbreon (Night)", url:"https://totalcards.net/cdn/shop/files/1782827257_60f45593661c9cef047877b824d5630f.webp?v=1782827285" },
  "174": { label:"Greninja (Night)", url:"https://totalcards.net/cdn/shop/files/1782827034_5f61599ec408d49b88c88153cb8f0802.webp?v=1782827073" },
  "175": { label:"Zapdos (Night)", url:"https://zatu.com/cdn/shop/files/ZBG-POK1010465101-ZAPDOS.jpg?v=1788944443" }
});
const tinSuffixByVariant = new Map(Object.entries(thirtyCelebrationTins)
  .map(([suffix,entry])=>[entry.label.toLowerCase(),suffix]));
function keyFromName(name) {
  const value = String(name || "");
  const sku = value.match(/\b10-10465-(16[6-9]|17[0-5])\b/i);
  if (sku) return sku[1];
  if (!/30th\s+celebration\s+mini\s+tin/i.test(value)) return null;
  const result = value.match(/\b(mewtwo|mew|pikachu|espeon|lapras|moltres|greninja|umbreon|zapdos)\s*\(\s*(day|night)\s*\)/i);
  return result ? tinSuffixByVariant.get((result[1]+" ("+result[2]+")").toLowerCase()) || null : null;
}
export function verifiedSkuProductImage(name, retailer, sku = "") {
  if (String(retailer || "").trim().toLowerCase() !== "pkc") return null;
  const suffix = keyFromName(sku) || keyFromName(name);
  if (!suffix) return null;
  const expected = thirtyCelebrationTins[suffix];
  // A mismatched name and SKU is a data-integrity problem, not permission to
  // place the wrong artwork on the customer's order.
  const named = keyFromName(name);
  if (named && named !== suffix) return null;
  return expected?.url || null;
}
export function verifiedTinVariants() {
  return Object.entries(thirtyCelebrationTins).map(([suffix, item]) => ({
    sku:"10-10465-"+suffix, name:item.label, imageUrl:item.url
  }));
}
