/**
 * Exact Discord checkout amount validation.
 *
 * A "Price" or item subtotal is NEVER the final paid amount. Tax, shipping
 * and discounts must be accounted for using explicit checkout evidence.
 * Where the webhook has a confirmed Total Paid / Order Total, use it; when
 * no such total exists, derive it ONLY from a complete itemized checkout
 * breakdown: subtotal, tax, shipping AND discount (including explicit zero).
 * Missing amounts are unknown, not assumed zero.
 *
 * Reads original Discord checkout message fields only. No customer records,
 * guessed tax rates, location lookups, email orders or retailer purchases.
 */
import { checkoutExplicitPaidTotal } from "./checkout-price-policy.js";

const GROUP_LABELS = Object.freeze({
  subtotal: /^(?:items?\s+subtotal|merchandise\s+subtotal|order\s+subtotal|subtotal)$/i,
  tax: /^(?:sales\s+tax|tax|tax\s+total)$/i,
  shipping: /^(?:shipping|shipping\s+(?:and|&)\s+handling|shipping\s+(?:charge|cost|fee))$/i,
  discount: /^(?:discount|discount\s+applied|promo(?:tional)?\s+discount|coupon\s+discount)$/i
});
function normalizedLabel(value) {
  return String(value || "").replace(/[*_\x60]|\u200b/g,"")
    .replace(/:\s*$/,"").replace(/\s+/g," ").trim();
}
function parseCents(value,{allowFree=false,allowNegative=false}={}) {
  const text=String(value??"").replace(/[*_\x60]|\|\|/g,"")
    .replace(/\s+/g," ").trim();
  if(allowFree && /^(?:free|none|no charge)$/i.test(text))return 0;
  if(text==="0"||text==="0.00"||text==="$0.00"||/^USD 0\.00$/i.test(text))return 0;
  const match=text.match(/^(-)?\s*(?:(?:USD|US\$)\s*)?\$?\s*((?:\d{1,8}|\d{1,3}(?:,\d{3})+)\.\d{2})(?:\s*USD)?$/i);
  if(!match || (match[1]&&!allowNegative))return null;
  const numeric=Number(match[2].replace(/,/g,""));
  const cents=Math.round(numeric*100);
  return Number.isSafeInteger(cents) && cents>=0 && cents<=100000000 ? cents : null;
}
function parseFields(message){
  const lists={subtotal:[],tax:[],shipping:[],discount:[]};
  const assign=(label,rawValue)=>{
    const n=normalizedLabel(label);
    for(const [key,pattern] of Object.entries(GROUP_LABELS)){
      if(pattern.test(n)) {
        const cents=parseCents(rawValue,{
          allowFree:key==="shipping"||key==="discount"||key==="tax",
          allowNegative:key==="discount"
        });
        lists[key].push(cents);
        return;
      }
    }
  };
  const textBlock=input=>{
    const lines=String(input||"").split(/\r?\n/).map(normalizedLabel).filter(Boolean);
    for(let i=0;i<lines.length;i++){
      const inline=lines[i].match(/^([^:\n]{2,75}):\s*(.+)$/);
      if(inline){assign(inline[1],inline[2]);continue;}
      if(i+1<lines.length && Object.values(GROUP_LABELS).some(r=>r.test(lines[i])))
        assign(lines[i],lines[++i]);
    }
  };
  textBlock(message?.content);
  for(const embed of Array.isArray(message?.embeds)?message.embeds:[]){
    for(const field of Array.isArray(embed?.fields)?embed.fields:[])
      assign(field?.name,field?.value);
    textBlock(embed?.description);
  }
  const categories={};
  const ambiguous=[];
  for(const [key,values] of Object.entries(lists)){
    const distinct=[...new Set(values)];
    if(distinct.length>1 || distinct.includes(null)){
      ambiguous.push(key);categories[key]=null;
    }else categories[key]=distinct.length===1?distinct[0]:null;
  }
  return {categories,ambiguous};
}
/** Return paid Cents and tax/shipping context only when fully supported. */
export function discordVerifiedFullCharge(message){
  const stated=checkoutExplicitPaidTotal(message);
  const {categories,ambiguous}=parseFields(message);
  const {subtotal,tax,shipping,discount}=categories;
  const allComponentsPresent=[subtotal,tax,shipping,discount]
    .every(v=>Number.isSafeInteger(v)&&v>=0);
  const calculated=allComponentsPresent
    ? subtotal+tax+shipping-discount
    : null;
  if(ambiguous.length){
    return {paidCents:null,basis:null,
      taxCents:tax,shippingCents:shipping,discountCents:discount,
      subtotalCents:subtotal,reason:"conflicting_or_invalid_breakdown"};
  }
  const statedCents=stated===null?null:Math.round(stated*100);
  if(statedCents!==null && calculated!==null && statedCents!==calculated){
    return {paidCents:null,basis:null,
      taxCents:tax,shippingCents:shipping,discountCents:discount,
      subtotalCents:subtotal,reason:"stated_total_does_not_match_components"};
  }
  if(statedCents!==null){
    return {paidCents:statedCents,basis:"order_total",
      taxCents:tax,shippingCents:shipping,discountCents:discount,
      subtotalCents:subtotal,reason:null};
  }
  if(calculated!==null && calculated>0 && calculated<=100000000){
    return {paidCents:calculated,basis:"discord_verified_breakdown",
      taxCents:tax,shippingCents:shipping,discountCents:discount,
      subtotalCents:subtotal,reason:null};
  }
  return {paidCents:null,basis:null,
    taxCents:tax,shippingCents:shipping,discountCents:discount,
    subtotalCents:subtotal,reason:"incomplete_paid_amount_including_tax"};
}
