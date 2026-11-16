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

/* Additional exact TCIN retail prices verified on official Target product pages
 * on 2026-11-15. These are reference retail prices, not inventory guarantees. */
export const VERIFIED_TARGET_RETAIL_20261115 = Object.freeze({
  "1012793604": 59.99,
  "1013166573": 14.99,
  "1013166576": 179.99,
  "1013166578": 31.99
});

export function addFixedTargetRetail(master) {
  if (!master?.entries) throw Error("Invalid Target SKU master");
  const next = structuredClone(master),added=[];
  for (const [sku, price] of Object.entries({ ...VERIFIED_TARGET_RETAIL_20261112, ...VERIFIED_TARGET_RETAIL_20261115 })) {
    const entry=next.entries[sku];
    if (!entry) continue;
    entry.prices ||= {};
    if (Number.isFinite(entry.prices.target?.price)) continue;
    entry.prices.target={
      price,
      url:"https://www.target.com/p/-/A-"+sku,
      seller:"Target",
      checkedAt:Object.hasOwn(VERIFIED_TARGET_RETAIL_20261115,sku) ? "2026-11-15" : "2026-11-12",
      source:"Target product page (verified)",
      locked:true
    };
    added.push(sku);
  }
  if(added.length) next.updatedAt=new Date().toISOString();
  return {master:next, added};
}


const usablePrice = value =>
  typeof value==="number" && Number.isFinite(value) && value>0 && value<50000 ? value : null;
const exactNameKey = value => String(value||"").normalize("NFKD").toLowerCase()
  .replace(/[\u0300-\u036f]/g,"")
  .replace(/\b(?:pokemon|trading card game|tcg|mega evolution)\b/g," ")
  .replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
const validatedRetail = (entry,sku) => {
  const price=usablePrice(entry?.prices?.target?.price);
  if(price!==null && entry.prices.target.seller==="Target")return price;
  const fixed={...VERIFIED_TARGET_RETAIL_20261112,...VERIFIED_TARGET_RETAIL_20261115};
  return usablePrice(fixed[sku]);
};

// Only add Target's authorized/saved retail price when absent. A direct TCIN
// match is preferred; a unique exact normalized product name is the fallback.
// A name match never silently changes a posted SKU (typos stay visible).
export function withVerifiedTargetRetail(products,master) {
  if(!Array.isArray(products))return [];
  const entries=Object.values(master?.entries||{});
  const byName=new Map();
  for(const entry of entries) {
    const key=exactNameKey(entry?.name);
    if(!key||!entry?.sku)continue;
    if(!byName.has(key))byName.set(key,[]);
    byName.get(key).push(entry);
  }
  return products.map(product=>{
    const sku=String(product?.sku||"").trim().toUpperCase();
    const fields=Array.isArray(product?.fields)?product.fields:[];
    const hasPrice=usablePrice(Number(product?.price))!==null ||
      fields.some(field=>/^(?:retail|price|msrp)$/i.test(String(field?.label||"").trim()));
    if(hasPrice)return {...product};
    const direct=master?.entries?.[sku];
    let price=validatedRetail(direct,sku),needsReview=false;
    if(price===null){
      const matches=byName.get(exactNameKey(product?.name))||[];
      if(matches.length===1){
        price=validatedRetail(matches[0],String(matches[0].sku));
        needsReview=price!==null && String(matches[0].sku)!==sku;
      }
    }
    if(price===null)return {...product};
    const enriched={...product,price:price.toFixed(2)};
    if(needsReview)enriched.itemNumberNeedsReview=true;
    if(Array.isArray(product?.fields)){
      enriched.fields=[...fields,{label:"Retail",value:"$"+price.toFixed(2)}];
      if(needsReview)enriched.fields.push({label:"Note",value:"Posted item number needs verification"});
    }
    return enriched;
  });
}
