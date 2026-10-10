// A gift starts AFTER the already-paid term. Never move a billing date earlier.
export function giftedBillingWindow({now=new Date(),periodEnd,priorGiftEnd,trialEnd,quantity,unit}) {
  if (!Number.isSafeInteger(quantity)||quantity<1||quantity>12||!["weeks","months"].includes(unit)) {
    throw new Error("Choose 1–12 weeks or months.");
  }
  const asMs=value=>{
    if(!value)return 0;
    const n=value instanceof Date?value.getTime():typeof value==="number"?value*1000:new Date(value).getTime();
    return Number.isFinite(n)?n:0;
  };
  const begin=Math.max(asMs(now),asMs(periodEnd),asMs(priorGiftEnd),asMs(trialEnd));
  if(!Number.isFinite(begin)||begin<=0)throw new Error("Missing subscription period end.");
  const startsAt=new Date(begin);
  const end=new Date(begin);
  if(unit==="weeks")end.setUTCDate(end.getUTCDate()+quantity*7);
  else {
    const day=end.getUTCDate();
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth()+quantity);
    end.setUTCDate(Math.min(day,new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()+1,0)).getUTCDate()));
  }
  if(end.getTime()-Date.now()>366*2*86400000)throw new Error("Gift period exceeds billing safety limit.");
  return {startsAt:startsAt.toISOString(),expiresAt:end.toISOString(),stripeTrialEnd:Math.floor(end.getTime()/1000)};
}
