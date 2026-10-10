function endOfMonth(year,month){return new Date(Date.UTC(year,month+1,0)).getUTCDate()}
function addMonths(when,count){const d=new Date(when);const day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+count);d.setUTCDate(Math.min(day,endOfMonth(d.getUTCFullYear(),d.getUTCMonth())));return d.getTime();}
function discountAt(subscription,date) {
  const all=Array.isArray(subscription.discounts)&&subscription.discounts.length
    ?subscription.discounts:subscription.discount?[subscription.discount]:[];
  const applicable=all.filter(discount=>{
    if(!discount||typeof discount!=="object")return true;
    if(discount.end&&Number(discount.end)*1000<=date)return false;
    const coupon=discount.coupon;
    if(coupon?.duration==="repeating"&&discount.start&&!discount.end&&coupon.duration_in_months){
      return addMonths(Number(discount.start)*1000,Number(coupon.duration_in_months))>date;
    }
    return true;
  });
  if(applicable.length>1)return {error:true};
  if(!applicable.length)return {error:false,coupon:null};
  const coupon=applicable[0]?.coupon;
  if(!coupon||typeof coupon!=="object")return {error:true};
  if(coupon.valid===false)return {error:false,coupon:null};
  if(coupon.applies_to?.products?.length)return {error:true};
  return {error:false,coupon};
}
export function membershipRate(subscription,nowMs=Date.now()) {
  let base=0;
  const items=subscription.items?.data||[];
  if(!items.length)return {regularMonthlyCents:null,currentMonthlyCents:null,nextChargeCents:null};
  for(const item of items){
    const price=item.price,interval=price?.recurring?.interval;
    const count=Number(price?.recurring?.interval_count||1);
    if(interval!=="month"||!Number.isFinite(count)||count<1||!Number.isFinite(Number(price.unit_amount))||price.currency!=="usd")
      return {regularMonthlyCents:null,currentMonthlyCents:null,nextChargeCents:null};
    base+=Number(price.unit_amount)*Number(item.quantity||1)/count;
  }
  base=Math.round(base);
  const giftedUntil=Number(subscription.trial_end||0)*1000>nowMs?Number(subscription.trial_end)*1000:null;
  const terms=items.map(item=>Number(item.current_period_end)).filter(Number.isFinite);
  const nextAt=giftedUntil||Number(subscription.current_period_end||0)*1000||Math.max(...terms)*1000||null;
  function rateAt(date) {
    const {coupon,error}=discountAt(subscription,date);
    if(error)return null;
    if(!coupon)return base;
    if(Number.isFinite(Number(coupon.percent_off))&&coupon.percent_off!=null)
      return Math.max(0,Math.round(base*(1-Number(coupon.percent_off)/100)));
    if(Number.isFinite(Number(coupon.amount_off))&&coupon.amount_off!=null&&coupon.currency==="usd")
      return Math.max(0,base-Number(coupon.amount_off));
    return null;
  }
  const currentMonthlyCents=giftedUntil?0:rateAt(nowMs);
  const nextChargeCents=nextAt?rateAt(nextAt):null;
  return {regularMonthlyCents:base,currentMonthlyCents,nextChargeCents,
    nextChargeAt:nextAt?new Date(nextAt).toISOString():null,
    giftedUntil:giftedUntil?new Date(giftedUntil).toISOString():null};
}
