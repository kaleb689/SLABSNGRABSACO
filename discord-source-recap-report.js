/**
 * Source-only recap report for the original SLABSNGRABSTC Discord #success channel.
 * No website aggregates, checkout-mailbox orders, or guessed paid totals.
 * Source message identities are transient and are never returned to callers.
 */
import {checkoutIdentityFromDiscord,checkoutStatusFromDiscord} from "./discord-checkout-identity.js";
import {isModuleLifecycleDiscordMessage} from "./discord-checkout-event-policy.js";
import {checkoutPaidAmount} from "./checkout-price-policy.js";
import {ownerRecapExpectedChargeCents} from "./discord-checkout-tax-inclusive-policy.js";
import {communityProductKey,communityProductName} from "./community-product-identity.js";
import {SLABSNGRABSTC_SUCCESS_CHANNEL_ID,retailerFromTrustedSourceImage} from "./discord-source-price-field-policy.js";

const millis=v=>typeof v==="number"?v:Date.parse(String(v||""));
const amountCents=v=>{
  const n=Number(v);
  return Number.isFinite(n)&&n>0&&n<=1000000?Math.round(n*100):null;
};
const safeName=value=>{
  const n=communityProductName(value).slice(0,160);
  return n.length>=3 &&
    !/@|\b(?:email|password|account|login|address|phone|security code|cvv|order\s*(?:number|id|#)|proxy)\b/i.test(n) &&
    !/(?:\d[ -]*?){13,19}/.test(n) ? n:"";
};
const retailerName=value=>{
  const v=String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  if(/^(?:target|target go|target us|target com)$/.test(v))return "Target";
  if(/^(?:pkc|pokemon center|pokemon center usa|pokemon center us|pokemoncenter com)$/.test(v))return "PKC";
  if(/^(?:walmart|walmart go|walmart us|walmart com)$/.test(v))return "Walmart";
  if(v==="costco")return "Costco";
  if(v==="sams club"||v==="sam s club")return "Sam's Club";
  return "";
};
const canonicalRetailer=(message,parsed,channelId)=>{
  const embeds=Array.isArray(message?.embeds)?message.embeds:[];
  const fields=embeds.flatMap(e=>Array.isArray(e?.fields)?e.fields:[]);
  const raw=fields.find(f=>/^(?:retailer|store|site)$/i.test(String(f?.name||"").replace(/[*_\x60]/g,"").trim()))?.value;
  const known=retailerName(raw||parsed?.retailer);
  if(known)return known;
  const embed=embeds[0],url=embed?.thumbnail?.url||embed?.image?.url;
  return retailerName(retailerFromTrustedSourceImage({channelId,retailerLabel:raw,imageUrl:url}));
};
const validItems=items=>(Array.isArray(items)?items:[]).flatMap(item=>{
  const name=safeName(String(item?.name||"")),qty=Number(item?.quantity);
  if(!name||!Number.isSafeInteger(qty)||qty<1||qty>999)return [];
  const key=communityProductKey(name,item?.sku);
  if(!key)return [];
  return [{key,name,qty,unitCents:amountCents(item?.price),
    imageUrl:(()=>{
      try{const u=new URL(String(item?.imageUrl||""));
        return u.protocol==="https:"&&u.hostname==="target.scene7.com"?u.toString():null;
      }catch{return null;}
    })()}];
});
/** New York wall time -> UTC, including DST. Only hours 0, 3 and 8 are used. */
export function easternLocalInstant(date, hour=0) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||"")) ||
    !Number.isInteger(hour)||hour<0||hour>23)throw Error("Invalid Eastern date");
  const [y,m,d]=date.split("-").map(Number);
  if(new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10)!==date)
    throw Error("Invalid calendar date");
  const expected=Date.UTC(y,m-1,d,hour);
  let current=expected;
  const fmt=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",
    year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",
    second:"2-digit",hourCycle:"h23"});
  for(let pass=0;pass<3;pass++){
    const parts=Object.fromEntries(fmt.formatToParts(new Date(current))
      .filter(x=>x.type!=="literal").map(x=>[x.type,Number(x.value)]));
    const actual=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
    current+=expected-actual;
  }
  return new Date(current).toISOString();
}
/** Build a privacy-safe report from original webhook messages.
 * Superseding red events with the SAME retailer/order ID withdraw the success.
 * Unidentified red events need no price or order ID and are ignored.
 */
export function buildDiscordSourceRecap(messages,{
  channelId,from,toExclusive,asOf=Date.now(),retailer="Target",parseCheckout,
  historyComplete=true
}={}) {
  if(String(channelId)!==SLABSNGRABSTC_SUCCESS_CHANNEL_ID)
    throw Error("Only the original SLABSNGRABSTC Success source is allowed");
  if(typeof parseCheckout!=="function")throw Error("Missing source message parser");
  const start=millis(from),end=millis(toExclusive),cutoff=millis(asOf);
  if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(cutoff) ||
    start>=end||end>cutoff)throw Error("Invalid recap period");
  const selected=retailer==="All"?null:retailerName(retailer);
  if(retailer!=="All"&&!selected)throw Error("Unknown recap retailer");
  const grouped=new Map(),catalog=new Map();
  let redWithoutId=0,greenWithoutId=0,unknownRetailer=0,green=0,orange=0,red=0;
  const ordered=(Array.isArray(messages)?messages:[]).filter(msg=>{
    const at=millis(msg?.timestamp);
    return Number.isFinite(at)&&at>=start&&at<=cutoff;
  }).sort((a,b)=>millis(a.timestamp)-millis(b.timestamp));
  for(const msg of ordered) {
    if(!msg.webhook_id||isModuleLifecycleDiscordMessage(msg))continue;
    const status=checkoutStatusFromDiscord(msg);
    if(!["confirmed","review_hold","cancelled"].includes(status))continue;
    let checkout=null;
    try{checkout=parseCheckout(msg,String(channelId));}catch{/* Do not infer an order. */}
    const retailerValue=canonicalRetailer(msg,checkout,channelId);
    if(!retailerValue){if(status!=="cancelled")unknownRetailer++;continue;}
    if(selected&&retailerValue!==selected)continue;
    if(status==="confirmed")green++;
    else if(status==="review_hold")orange++;
    else red++;
    const identity=checkoutIdentityFromDiscord(msg);
    const number=String(identity?.orderNumber||checkout?.orderNumber||"").trim().replace(/^#/,"").toLowerCase();
    if(!number){if(status==="cancelled")redWithoutId++;else if(at>=start&&at<end)greenWithoutId++;continue;}
    const id=retailerValue+":"+number;
    const at=millis(msg.timestamp);
    const items=validItems(checkout?.items);
    const old=grouped.get(id)||{placedAt:null,status:"unverified",items:[],paidCents:null};
    if(status!=="cancelled"){
      if(old.placedAt===null)old.placedAt=at;
      if(items.length)old.items=items;
      const paid=checkoutPaidAmount(checkout);
      if(paid!==null)old.paidCents=amountCents(paid);
      if(at>=start&&at<end)for(const item of items){
        if(item.unitCents===null)continue;
        const c=catalog.get(item.key)||new Set();
        c.add(item.unitCents);catalog.set(item.key,c);
      }
    }
    old.status=status;
    grouped.set(id,old);
  }
  const initial=[...grouped.values()].filter(x=>x.placedAt!==null&&
    x.placedAt>=start&&x.placedAt<end);
  const valid=initial.filter(x=>x.status==="confirmed"||x.status==="review_hold");
  let units=0,unitMissing=0,paidMissing=0,verifiedPaidCents=0,
    lineSubtotalCents=0,lineSubtotalOrders=0;
  const productMap=new Map();
  for(const record of valid){
    if(record.paidCents===null)paidMissing++;
    else verifiedPaidCents+=record.paidCents;
    if(!record.items.length)unitMissing++;
    let partial=0,allPriced=Boolean(record.items.length);
    for(const item of record.items){
      units+=item.qty;
      const prev=productMap.get(item.key)||{name:item.name,units:0,imageUrl:null};
      prev.units+=item.qty;
      if(!prev.imageUrl&&item.imageUrl)prev.imageUrl=item.imageUrl;
      productMap.set(item.key,prev);
      if(item.unitCents===null)allPriced=false;
      else partial+=item.qty*item.unitCents;
    }
    if(allPriced){lineSubtotalOrders++;lineSubtotalCents+=partial;}
  }
  // Owner-confirmed tax and delivery policy: calculate each retained order
  // separately (not one tax/shipping charge on the whole drop).
  // Use unit prices only when the source's exact product has one consistent
  // price across the original green/orange checkout webhooks.
  let ruleTotalCents=0,ruleSubtotalCents=0,ruleTaxCents=0,ruleShippingCents=0;
  let ruleCalculatedOrders=0,ruleUnpricedOrders=0,ruleExplicitPaidConflicts=0;
  let shippedOrdersUnder35=0,freeShippingOrders35Plus=0;
  const perProductPriceCatalog=new Map([...catalog].map(([key,prices])=>
    [key,prices.size===1?[...prices][0]:null]));
  for(const record of valid){
    let subtotalCents=0,complete=record.items.length>0;
    for(const item of record.items){
      const cost=item.unitCents!==null ? item.unitCents :
        perProductPriceCatalog.get(item.key) ?? null;
      if(cost===null){complete=false;break;}
      subtotalCents+=cost*item.qty;
    }
    if(!complete){ruleUnpricedOrders++;continue;}
    const expected=ownerRecapExpectedChargeCents(subtotalCents);
    if(!expected){ruleUnpricedOrders++;continue;}
    ruleCalculatedOrders++;
    ruleSubtotalCents+=expected.subtotalCents;
    ruleTaxCents+=expected.taxCents;
    ruleShippingCents+=expected.shippingCents;
    ruleTotalCents+=expected.totalCents;
    if(expected.shippingCents>0)shippedOrdersUnder35++;
    else freeShippingOrders35Plus++;
    // Never overwrite a discord-authoritative final paid charge. A difference
    // remains visible for review rather than silently forcing agreement.
    if(record.paidCents!==null && record.paidCents!==expected.totalCents)
      ruleExplicitPaidConflicts++;
  }
  const ruleComplete=valid.length>0&&ruleUnpricedOrders===0&&unitMissing===0;
  let inferredSubtotalCents=0,inferredCoverage=0,unpricedUnits=0;
  const products=[...productMap.entries()].map(([key,p])=>{
    const prices=[...(catalog.get(key)||[])];
    const unitPriceCents=prices.length===1?prices[0]:null;
    if(unitPriceCents===null)unpricedUnits+=p.units;
    else {inferredCoverage+=p.units;inferredSubtotalCents+=p.units*unitPriceCents;}
    return {name:p.name,quantity:p.units,imageUrl:p.imageUrl,
      observedUnitPriceCents:unitPriceCents};
  }).sort((a,b)=>b.quantity-a.quantity||a.name.localeCompare(b.name));
  const ready=Boolean(historyComplete&&valid.length&&ruleComplete&&
    !ruleExplicitPaidConflicts&&!greenWithoutId&&!unknownRetailer);
  return {
    source:"SLABSNGRABSTC #success",
    retailer:selected||"All",
    periodStart:new Date(start).toISOString(),
    periodEndExclusive:new Date(end).toISOString(),
    asOf:new Date(cutoff).toISOString(),
    sourceColorMessages:{green,orange,red},
    ordersPlaced:valid.length,
    totalUnits:unitMissing?null:units,
    // Displayable spend uses the owner-confirmed tax/shipping rules only when
    // EVERY retained checkout has a unique known unit price.
    totalSpentCents:ruleComplete?ruleTotalCents:null,
    totalSpentBasis:ruleComplete?"rule_calculated_7pct_tax_shipping_under_35":null,
    salesTaxRatePercent:7,
    shippingThresholdCents:3500,
    shippingFeeUnderThresholdCents:599,
    ruleCalculatedOrders,
    ruleUnpricedOrders,
    ruleSubtotalCents,
    ruleTaxCents,
    ruleShippingCents,
    ruleTotalCents:ruleComplete?ruleTotalCents:null,
    shippingChargedOrders:shippedOrdersUnder35,
    freeShippingOrders:freeShippingOrders35Plus,
    ruleExplicitPaidConflicts,
    verifiedPaidCents,paidMissingOrders:paidMissing,
    incompleteQuantityOrders:unitMissing,
    deduplicatedCancelledOrders:initial.length-valid.length,
    redWithoutOrderIdIgnored:redWithoutId,
    greenWithoutOrderId:greenWithoutId,
    unknownRetailerMessages:unknownRetailer,
    knownLineSubtotalCents:lineSubtotalCents,
    fullyPricedLineOrders:lineSubtotalOrders,
    observedCatalogMerchandiseEstimateCents:unpricedUnits?null:inferredSubtotalCents,
    observedCatalogPricedUnits:inferredCoverage,
    observedCatalogUnpricedUnits:unpricedUnits,
    merchandiseEstimateIsVerifiedPaidTotal:false,
    topProducts:products.slice(0,5),
    readyToPublish:ready,
    blockedReasons:[
      ...(!historyComplete?["incomplete_discord_history"]:[]),
      ...(!ruleComplete?["missing_source_unit_prices_for_rule_total"]:[]),
      ...(ruleExplicitPaidConflicts?["explicit_paid_amount_disagrees_with_tax_shipping_rule"]:[]),
      ...(unitMissing?["missing_item_quantities"]:[]),
      ...(greenWithoutId?["green_or_orange_missing_order_id"]:[]),
      ...(unknownRetailer?["unknown_retailer"]:[]),
      ...(!valid.length?["no_success_orders"]:[])
    ]
  };
}
