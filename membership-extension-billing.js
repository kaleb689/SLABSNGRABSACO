// Exact admin-selected no-charge subscription end; billing is controlled by
// Stripe trial_end, never merely by a website-only time extension.
const ISO_UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// Durations are applied to the later of the verified Stripe renewal date,
// an existing trial, and an earlier admin extension; never to the click time.
export function requestedMembershipDuration({durationUnit,durationQuantity,now=Date.now(),periodEnd=0,trialEnd=0,priorExtensionEnd=0,billingCycleAnchor=0}={}){
 const unit=String(durationUnit||"").toLowerCase();
 const quantity=Number(durationQuantity);
 if(!["day","week","month","year"].includes(unit)||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000)
  throw Error("Choose a positive whole number of days, weeks, months or years.");
 const asMs=value=>{
  if(typeof value==="number")return value>0&&value<1e11?value*1000:value;
  const t=Date.parse(String(value||""));return Number.isFinite(t)?t:0;
 };
 const start=Math.max(now,asMs(periodEnd),asMs(trialEnd),asMs(priorExtensionEnd));
 const date=new Date(start);
 if(unit==="day"||unit==="week")date.setUTCDate(date.getUTCDate()+quantity*(unit==="week"?7:1));
 else {
  const day=date.getUTCDate();
  date.setUTCDate(1);
  if(unit==="month")date.setUTCMonth(date.getUTCMonth()+quantity);
  else date.setUTCFullYear(date.getUTCFullYear()+quantity);
  const finalDay=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  date.setUTCDate(Math.min(day,finalDay));
 }
 if(!Number.isFinite(date.getTime()))throw Error("Choose a valid extension duration.");
 return requestedMembershipExtension({endAt:date.toISOString(),now,periodEnd,trialEnd,priorExtensionEnd,billingCycleAnchor});
}

// Stripe documents trial_end as at most two years from billing_cycle_anchor.
// Existing subscription anchors may be older than today: respect the smaller
// account-specific limit rather than offering an extension Stripe would reject.
export function stripeMembershipExtensionLimit({now=Date.now(),billingCycleAnchor=0}={}){
 const anchor=Number(billingCycleAnchor);
 const anchorMs=Number.isFinite(anchor)&&anchor>0?(anchor<1e11?anchor*1000:anchor):now;
 const limit=new Date(Math.min(now,anchorMs));
 if(!Number.isFinite(limit.getTime()))throw Error('Stripe billing anchor is invalid.');
 limit.setUTCFullYear(limit.getUTCFullYear()+2);
 return limit.getTime();
}

export function requestedMaximumMembershipExtension({now=Date.now(),periodEnd=0,trialEnd=0,priorExtensionEnd=0,billingCycleAnchor=0}={}){
 // Keep a one-minute safety margin for network transit and second precision.
 const maxMs=stripeMembershipExtensionLimit({now,billingCycleAnchor})-60000;
 const endAt=new Date(Math.floor(maxMs/1000)*1000).toISOString();
 return requestedMembershipExtension({endAt,now,periodEnd,trialEnd,priorExtensionEnd,billingCycleAnchor});
}

export function requestedMembershipExtension({endAt,now=Date.now(),periodEnd=0,trialEnd=0,priorExtensionEnd=0,billingCycleAnchor=0}={}){
 const value=String(endAt||'');
 if(!ISO_UTC.test(value))throw Error('Choose a valid date and time for the new Stripe renewal.');
 const date=new Date(value),requested=date.getTime();
 if(!Number.isFinite(requested)||date.toISOString()!==new Date(requested).toISOString())
  throw Error('Choose a valid UTC date and time.');
 const dateMs=v=>{
  if(typeof v==='number')return v>0&&v<1e11?v*1000:v;
  const n=Date.parse(String(v||''));return Number.isFinite(n)?n:0;
 };
 const baseline=Math.max(now,dateMs(periodEnd),dateMs(trialEnd),dateMs(priorExtensionEnd));
 if(!Number.isFinite(baseline)||requested<=baseline)
  throw Error('The new renewal date must be later than the existing Stripe billing date and any prior extension.');
 // Stripe's trial_end date used to defer subscription renewal has a hard
 // two-year limit. Never accept an extension the billing provider cannot honor.
 const latestAllowed=stripeMembershipExtensionLimit({now,billingCycleAnchor});
 if(requested>latestAllowed)
  throw Error('This renewal date exceeds Stripe\'s two-year limit for this subscription. Choose a date within the allowed period; billing has not been changed.');
 return {expiresAt:new Date(requested).toISOString(),startsAt:new Date(baseline).toISOString(),stripeTrialEnd:Math.ceil(requested/1000)};
}
