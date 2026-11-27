import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculatePaidExtensionOffer } from "../membership-extension-commerce.js";
import { validateThanksgivingExtensionMonths,validateThanksgivingPromotionSetup,
  THANKSGIVING_MAX_DISCOUNT_MONTHS,THANKSGIVING_END_AT } from "../thanksgiving-2026.js";

const plans={
  1:{name:"Starter",profiles:1,amount:15,priceId:"price_starter"},
  5:{name:"High Volume",profiles:10,amount:120,priceId:"price_hv"}
};
const code={code:"THANKS25",discountType:"percent",discountScope:"both",
  percent:25,extensionDiscountMonths:6};
const setup={
  code:"THANKS25",discountScope:"both",discountType:"percent",percent:25,
  duration:"repeating",durationMonths:6,extensionDiscountMonths:6,
  sitewide:true,ogOnly:false,recipientEmail:"",appliesToRentals:false,
  tier:"all",startsAt:"2026-11-15T23:00:00.000Z",
  expiresAt:THANKSGIVING_END_AT
};
test("THANKS25 hard limits the total prepaid term to six months",()=>{
  assert.equal(THANKSGIVING_MAX_DISCOUNT_MONTHS,6);
  for(let months=1;months<=6;months++){
    const quote=calculatePaidExtensionOffer({months,targetTier:1,currentTier:1,plans,code});
    assert.equal(quote.discountedMonths,months);
    assert.equal(quote.savedCents,Math.round(1500*months*.25));
    assert.equal(quote.prepaidCents,1500*months-quote.savedCents);
  }
  assert.throws(()=>calculatePaidExtensionOffer({
    months:7,targetTier:1,currentTier:1,plans,code
  }),/1–6 prepaid membership months/);
  assert.throws(()=>calculatePaidExtensionOffer({
    months:12,targetTier:1,currentTier:1,plans,
    code:{...code,extensionDiscountMonths:"all"}
  }),/1–6 prepaid membership months/);
  assert.equal(calculatePaidExtensionOffer({
    months:12,targetTier:1,currentTier:1,plans
  }).discountedMonths,0,"ordinary full-price extensions remain available");
});
test("Repeat Thanksgiving purchase attempts cannot exceed six total discounted months",()=>{
  validateThanksgivingExtensionMonths({months:4,code,priorMonths:2});
  assert.throws(()=>validateThanksgivingExtensionMonths({months:4,code,priorMonths:3}),
    /6 discounted extension months per membership/);
  assert.throws(()=>validateThanksgivingExtensionMonths({months:1,code,priorMonths:6}),
    /6 discounted extension months per membership/);
  validateThanksgivingExtensionMonths({months:12,code:{code:"OTHER10"},priorMonths:0});
});
test("Stripe admin configuration must limit signup coupon to six months as well",()=>{
  assert.doesNotThrow(()=>validateThanksgivingPromotionSetup(setup));
  for(const edit of [
    {duration:"forever"},{durationMonths:12},
    {extensionDiscountMonths:"all"},{extensionDiscountMonths:7},
    {discountScope:"signup"},{percent:30},{appliesToRentals:true},
    {sitewide:false},{tier:1}
  ]) assert.throws(()=>validateThanksgivingPromotionSetup({...setup,...edit}),/six|6/i);
  assert.throws(()=>validateThanksgivingPromotionSetup({...setup,expiresAt:"2026-11-29T05:00:00Z"}),/November 27/);
  assert.throws(()=>validateThanksgivingPromotionSetup({...setup,startsAt:"2026-11-16T23:00:00Z"}),/November 15/);
});
test("Website and both backend purchase paths honor the same six-month limit",()=>{
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const checkout=readFileSync(new URL("../membership-extension-commerce.js",import.meta.url),"utf8");
  const site=readFileSync(new URL("../public/member-extension-actions.js",import.meta.url),"utf8");
  assert.match(server,/validateThanksgivingPromotionSetup\(\{/);
  assert.match(checkout,/validateThanksgivingExtensionMonths\(\{months:body\.months,code,priorMonths:used\}\)/);
  assert.match(checkout,/active\.reduce\(\(sum,item\)/);
  assert.match(site,/if\(thanksgivingSelected\(\)\)/);
  assert.match(site,/Thanksgiving offer has ended/);
  assert.match(checkout,/if \(isThanksgivingCode\(typed\)\) throw fail/);
});
