// Paid membership extensions, upgrades, and scheduled cancellation are available
// on the same My Profile screen in both the website and installed customer PWA.
(function(){
 "use strict";
 const root=document.getElementById("membership-extension-controls");
 if(!root)return;
 const q=id=>document.getElementById(id);
 const fmt=cents=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(cents||0)/100);
 const date=value=>{
  const number=Number(value),time=Number.isFinite(number)&&number>0?(number<1e11?number*1000:number):Date.parse(String(value||""));
  return Number.isFinite(time)?new Date(time).toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"}):"Not available";
 };
 const plans=[
  [1,"Starter"],[2,"Intermediate"],[3,"Advanced"],[4,"Pro"],
  [5,"High Volume"],[6,"Power User"],[7,"Elite"],[8,"Ultimate"]
 ];
 const select=q("extensionTier"),months=q("extensionMonths"),code=q("extensionDiscountCode");
 const preview=q("extensionPreview"),confirmButton=q("extensionPurchase");
 const status=q("extensionStatus"),details=q("extensionQuote"),cancelButton=q("cancelMembershipRenewal");
 let membership=null,lastQuote=null,lastRefresh=0,loading=false,requestId=null;
 const previewMode=new URLSearchParams(location.search).has("adminCustomerPreview");
 if(previewMode)return;
 const safeFetch=async(url,options={})=>{
  const r=await fetch(url,{credentials:"same-origin",cache:"no-store",...options});
  const body=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(body.error||"Unable to verify membership billing.");
  return body;
 };
 const reset=()=>{lastQuote=null;requestId=null;confirmButton.hidden=true;details.replaceChildren();status.textContent="";};
 [select,months,code].forEach(node=>node?.addEventListener("input",reset));
 const currentTier=()=>Number(membership?.tier||0);
 function showPlanChoices(tier) {
  const existing=Number(select.value);
  select.replaceChildren();
  for (const [id,label] of plans)if(id>=tier)select.add(new Option(id===tier?label+" (current)":label+" (upgrade)",String(id)));
  if([...select.options].some(o=>Number(o.value)===existing))select.value=String(existing);
  else select.value=String(tier);
 }
 async function refresh(force=false){
  if(loading || (!force && Date.now()-lastRefresh<25000))return;
  loading=true;
  try {
   const data=await safeFetch("/api/my-profile");
   membership=data.membership||data.currentMembership||null;
   const active=["active","trialing"].includes(String(membership?.status||"").toLowerCase());
   const tier=currentTier();
   root.hidden=!active||!tier;
   if(root.hidden)return;
   showPlanChoices(tier);
   const scheduled=membership.cancelAtPeriodEnd===true;
   q("extensionCurrentRenewal").textContent="Your current " + (scheduled?"membership end":"renewal") +
     " date: "+date(membership.subscriptionEndDate||membership.currentPeriodEnd);
   cancelButton.disabled=scheduled;
   cancelButton.textContent=scheduled?"Cancellation scheduled":"Cancel automatic renewal";
   q("extensionCancelNote").textContent=scheduled
    ?"Your paid membership remains active through the date shown. Contact support to resume auto-renewal."
    :"Cancelling stops future renewal payments. Your paid membership remains active through its current term.";
   preview.disabled=scheduled;
   select.disabled=scheduled;
   months.disabled=scheduled;
   code.disabled=scheduled;
   if(scheduled){lastQuote=null;confirmButton.hidden=true;}
   lastRefresh=Date.now();
  }catch(error){ if(/sign in|authenticated|not authenticated/i.test(error.message)){root.hidden=true;} }
  finally{loading=false;}
 }
 preview?.addEventListener("click",async()=>{
  if(preview.disabled)return;
  preview.disabled=true;details.replaceChildren();confirmButton.hidden=true;
  status.textContent="Checking the price and next Stripe renewal date…";
  try {
   const params=new URLSearchParams({
    tier:select.value,months:months.value,discountCode:code.value.trim()
   });
   const result=await safeFetch("/api/account/membership/extension-quote?"+params);
   const offer=result.quote;
   const rows=[
    ["Membership tier",offer.tierName+(offer.upgrade?" — upgrade included":"")],
    ["Extension period",offer.months+" month"+(offer.months===1?"":"s")],
    ["Regular extension amount",fmt(offer.regularCents)],
    ["Promotion",offer.discountCode?
      offer.discountCode+" — "+offer.discountPercent+"% off "+offer.discountedMonths+" month(s)"+(offer.discountLabel?" ("+offer.discountLabel+")":""):
      "No promotion applied"],
    ["Discount saved","−"+fmt(offer.savedCents)],
    ["Total to pay",fmt(offer.totalCents)],
    ["Next recurring renewal",date(result.nextRenewalAt)]
   ];
   for(const [k,v] of rows) {
    const row=document.createElement("div");
    const key=document.createElement("span"),value=document.createElement("strong");
    key.textContent=k;value.textContent=v;
    row.append(key,value);details.append(row);
   }
   const disclosure=document.createElement("p");
   disclosure.textContent=offer.upgrade
    ?"Your new tier becomes active when Stripe confirms payment. You pay the new tier's rate for the selected extension months; after the extension, monthly payments resume at the new tier's regular rate."
    :"After the extension, your current recurring monthly rate resumes. This promo will not permanently discount your subscription.";
   details.append(disclosure);
   lastQuote={tier:offer.targetTier,months:offer.months,discountCode:code.value.trim()};
   confirmButton.hidden=false;
   confirmButton.textContent=offer.totalCents>0?"Pay "+fmt(offer.totalCents)+" securely":"Confirm free extension through Stripe";
   status.textContent="Review the exact total above before proceeding.";
  }catch(error){status.textContent=error.message;lastQuote=null;}
  finally{preview.disabled=membership?.cancelAtPeriodEnd===true;}
 });
 confirmButton?.addEventListener("click",async()=>{
  if(!lastQuote)return;
  if(!window.confirm("Continue to Stripe with the extension total shown above?"))return;
  confirmButton.disabled=true;
  status.textContent="Creating secure Stripe Checkout…";
  try {
   requestId ||= crypto.randomUUID();
   const result=await safeFetch("/api/account/membership/extension-checkout",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({...lastQuote,confirm:true,requestId})
   });
   if(!result.url)throw Error("Checkout did not return a secure payment link.");
   location.assign(result.url);
  }catch(error){
   status.textContent=error.message;
   confirmButton.disabled=false;
  }
 });
 cancelButton?.addEventListener("click",async()=>{
  if(cancelButton.disabled)return;
  if(!window.confirm("Stop automatic membership renewal at the end of your paid term? This does not refund or cancel access immediately."))return;
  cancelButton.disabled=true;
  status.textContent="Asking Stripe to stop automatic renewal…";
  try {
   const result=await safeFetch("/api/account/membership/cancel",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({confirm:true})
   });
   reset();
   status.textContent="Stripe confirmed your cancellation. Your access stays active until "+date(result.endAt)+".";
   lastRefresh=0;await refresh(true);
  }catch(error){status.textContent=error.message;cancelButton.disabled=false;}
 });
 document.addEventListener("click",event=>{
  if(event.target.closest?.('[data-account-tab], #customer-login-submit, [data-nav]'))setTimeout(()=>{void refresh();},350);
 });
 const search=new URLSearchParams(location.search);
 if(search.get("extension")==="success")status.textContent="Stripe checkout returned. Your membership extension will show once payment is confirmed.";
 if(search.get("extension")==="cancelled")status.textContent="Stripe Checkout was closed without extending your membership.";
 void refresh(true);
 setInterval(()=>{
  if(!document.hidden && document.getElementById("my-profile")?.classList.contains("active"))
    void refresh();
 },60000);
})();
