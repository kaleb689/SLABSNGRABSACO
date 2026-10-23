// Exact admin-selected no-charge subscription end; billing is controlled by
// Stripe trial_end, never merely by a website-only time extension.
const ISO_UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export function requestedMembershipExtension({endAt,now=Date.now(),periodEnd=0,trialEnd=0,priorExtensionEnd=0}={}){
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
 if(requested>now+20*366*86400000)
  throw Error('Choose a date within 20 years. Stripe billing has not been changed.');
 return {expiresAt:new Date(requested).toISOString(),startsAt:new Date(baseline).toISOString(),stripeTrialEnd:Math.ceil(requested/1000)};
}
