// Direct Target product page prices checked on 2026-11-12.
// Store the observed Target retail price once. This is a reference price,
// not a claim that Target or the manufacturer guarantees it indefinitely.
// Never replace an existing saved retail price and never use marketplace offers.
export const VERIFIED_TARGET_RETAIL_20261112 = Object.freeze({
  "89432660": 27.99,
  "93954446": 31.99,
  "94636860": 59.99,
  "94636862": 59.99,
  "94681790": 129.99,
  "95082118": 59.99,
  "95093981": 54.99,
  "95093982": 54.99,
  "95093989": 29.99,
  "95120822": 19.99,
  "95120834": 31.99,
  "1010892065": 29.99,
  "1010892067": 19.99,
  "1010892068": 29.99,
  "1010892076": 69.99,
  "1010892078": 19.99,
  "1011206804": 69.99,
  "1011407490": 31.99,
  "1012055696": 129.99,
  "1012663804": 49.99,
  "1012793603": 39.99,
  "1012850570": 249.99,
  "1012850572": 249.99,
  "1012850573": 39.99
});
export function addFixedTargetRetail(master) {
  if (!master?.entries) throw Error("Invalid Target SKU master");
  const next = structuredClone(master),added=[];
  for (const [sku, price] of Object.entries(VERIFIED_TARGET_RETAIL_20261112)) {
    const entry=next.entries[sku];
    if (!entry) continue;
    entry.prices ||= {};
    if (Number.isFinite(entry.prices.target?.price)) continue;
    entry.prices.target={
      price,
      url:"https://www.target.com/p/-/A-"+sku,
      seller:"Target",
      checkedAt:"2026-11-12",
      source:"Target product page (verified)",
      locked:true
    };
    added.push(sku);
  }
  if(added.length) next.updatedAt=new Date().toISOString();
  return {master:next, added};
}
