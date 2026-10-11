/**
 * Retailer-independent identity for grouping checkout product totals.
 * Original order details are never rewritten. Pack counts, variants, and
 * retailer-specific editions remain significant.
 */
export function productGroupKey(name) {
  let value = String(name ?? "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&(?:amp|#0*38|#x0*26);/gi, " and ")
    .replace(/[\u00ae\u2122\u00a9]/g, "")
    .replace(/[\u2018\u2019']/g, "")
    .trim().toLowerCase();

  // A delimited retailer prefix is listing metadata, but a retailer name
  // within a title/suffix can mean a distinct exclusive edition.
  const retailer = "(?:target|walmart|pokemon\\s+center|pkc|costco|sams?\\s+club)";
  value = value.replace(new RegExp("^" + retailer + "\\s*[:|\\-\\u2013\\u2014]\\s*", "i"), "");

  value = value
    .replace(/\b(?:trading\s+card\s+games?|trading\s+cards?|card\s+game|tcg)\b/g, " ")
    .replace(/\betbs?\b/g, "elite trainer box")
    .replace(/\belite\s+trainer\s+boxes\b/g, "elite trainer box")
    .replace(/\b(\d+)\s*(?:-\s*)?(?:packs?|pks?)\b/g, "$1 pack")
    .replace(/\b(\d+)\s*(?:-\s*)?(?:counts?|ct)\b/g, "$1 count")
    .replace(/\b(\d+)\s*(?:-\s*)?(?:pieces?|pcs?)\b/g, "$1 piece")
    .replace(/\b(?:and|the)\b|[&+]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ").trim();
  if (/\bpokemon\b/.test(value)) value = value.replace(/\bsv\b/g, "scarlet violet");
  return value.split(" ").filter(Boolean).sort().join(" ");
}
