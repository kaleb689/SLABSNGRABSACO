// Shared website/PWA membership controls. Stripe quotes and payment are authoritative.
(() => {
  "use strict";
  const root=document.getElementById("membership-extension-controls");
  if (!root) return;
  const $=id=>document.getElementById(id);
  const months=$("extensionMonths"), tier=$("extensionTier"), code=$("extensionDiscountCode"),
    quoteBtn=$("extensionPreview"), purchaseBtn=$("extensionPurchase"),
    quoteBox=$("extensionQuote"), status=$("extensionStatus"),
    cancelBtn=$("cancelMembershipRenewal"), currentLabel=$("extensionCurrentRenewal"),
    cancelNote=$("extensionCancelNote");
  const names={1:"Starter",2:"Intermediate",3:"Advanced",4:"Pro",5:"High Volume",
    6:"Power User",7:"Elite",8:"Ultimate"};
  const USD=cents=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(cents||0)/100);
  const date=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString("en-US",{dateStyle:"medium",timeStyle:"short"}):"Not available";};
  const read=async response=>{const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(data.error||"The membership request could not be completed.");
    return data;
  };
  let current=null,verifiedQuote=null,requestId=null,refreshing=false;
  function invalidate(){
    verifiedQuote=null;requestId=null;purchaseBtn.hidden=true;quoteBox.replaceChildren();
    status.textContent="";
  }
  function addText(parent,tag,text,className=""){
    const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;
    parent.append(el);return el;
  }
  function activeState(member){
    return member && ["active","trialing"].includes(String(member.status||"").toLowerCase());
  }
  async function sync(){
    if(refreshing||document.hidden) return;
    refreshing=true;
    try{
      const response=await fetch("/api/my-profile",{credentials:"same-origin",cache:"no-store"});
      if(response.status===401||response.status===403){current=null;root.hidden=true;return;}
      const data=await read(response),member=data.membership;
      if(!activeState(member)||data.account?.demo===true||
          new URLSearchParams(location.search).has("adminCustomerPreview")){
        current=null;root.hidden=true;return;
      }
      const level=Number(member.tier);
      if(!names[level]){root.hidden=true;return;}
      const wasTier=tier.value;
      const wasCurrent=current?.tier;
      current=member;
      tier.replaceChildren();
      for(let i=level;i<=8;i++){
        const opt=new Option(names[i]+(i>level?" · Upgrade":" · Current tier"),String(i));
        tier.add(opt);
      }
      if(wasCurrent===level&&Number(wasTier)>=level)tier.value=wasTier;
      currentLabel.textContent="Current paid term: "+date(member.currentPeriodEnd||member.subscriptionEndDate)+
        ". A prepaid extension begins after your current paid time ends.";
      const scheduled=Boolean(member.cancelAtPeriodEnd||member.cancelAt);
      cancelBtn.disabled=scheduled;
      cancelBtn.textContent=scheduled?"Cancellation scheduled":"Cancel automatic renewal";
      cancelNote.textContent=scheduled ?
        "Your current access is scheduled to end on "+date(member.cancelAt||member.subscriptionEndDate||member.currentPeriodEnd)+
        ". Contact support to reactivate before buying an extension." :
        "Canceling stops automatic renewal but retains access through your confirmed paid term.";
      quoteBtn.disabled=scheduled;
      root.hidden=false;
    }catch(error){console.debug("Membership extension sync:",error.message);}
    finally{refreshing=false;}
  }
  async function preview(){
    if(!current)return;
    const count=Number(months.value);
    if(!Number.isSafeInteger(count)||count<1||count>1200){
      status.textContent="Enter a positive whole number of months, up to the supported limit.";return;
    }
    quoteBtn.disabled=true;purchaseBtn.hidden=true;status.textContent="Checking your current Stripe term and discount…";
    try{
      const params=new URLSearchParams({months:String(count),tier:tier.value,discountCode:code.value.trim()});
      const data=await read(await fetch("/api/account/membership/extension-quote?"+params,{
        credentials:"same-origin",cache:"no-store"}));
      verifiedQuote={months:count,tier:Number(tier.value),discountCode:code.value.trim(),quote:data.quote};
      requestId=crypto.randomUUID();
      const q=data.quote;
      quoteBox.replaceChildren();
      addText(quoteBox,"strong",q.upgrade?"Prepaid extension + tier upgrade":"Prepaid membership extension");
      addText(quoteBox,"p",q.tierName+" · "+q.months+" month(s) · "+q.profiles+" ACO profiles");
      addText(quoteBox,"p","Regular total: "+USD(q.regularCents));
      if(q.discountCode){
        addText(quoteBox,"p",(q.discountLabel?q.discountLabel+" · ":"")+q.discountCode+
          ": "+q.discountPercent+"% off "+q.discountedMonths+" month(s)");
        addText(quoteBox,"p","Promotion savings: −"+USD(q.savedCents),"extension-savings");
      }
      addText(quoteBox,"strong","Pay now: "+USD(q.totalCents),"extension-pay-total");
      addText(quoteBox,"p","Paid access through "+date(data.nextRenewalAt));
      addText(quoteBox,"small","This is a one-time prepaid charge. After the prepaid term, automatic monthly billing resumes at the regular "+q.tierName+" rate unless cancelled.");
      status.textContent="Review the total and continue to secure payment when ready.";
      purchaseBtn.hidden=false;
    }catch(error){status.textContent=error.message;}
    finally{quoteBtn.disabled=false;}
  }
  [months,tier,code].forEach(el=>el.addEventListener("input",invalidate));
  quoteBtn.addEventListener("click",preview);
  purchaseBtn.addEventListener("click",async()=>{
    if(!verifiedQuote)return;
    const q=verifiedQuote.quote;
    if(!confirm("Confirm one-time payment of "+USD(q.totalCents)+" for "+q.months+
        " prepaid month(s) of "+q.tierName+"? Your regular monthly rate resumes after this term."))return;
    purchaseBtn.disabled=true;status.textContent="Opening secure Stripe Checkout…";
    try{
      const data=await read(await fetch("/api/account/membership/extension-checkout",{
        method:"POST",credentials:"same-origin",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({months:verifiedQuote.months,tier:verifiedQuote.tier,
          discountCode:verifiedQuote.discountCode,requestId,confirm:true})
      }));
      if(!data.url||!/^https:\/\//.test(data.url))throw Error("Stripe did not provide a valid checkout link.");
      location.assign(data.url);
    }catch(error){status.textContent=error.message;purchaseBtn.disabled=false;}
  });
  cancelBtn.addEventListener("click",async()=>{
    if(!current||cancelBtn.disabled)return;
    const end=current.cancelAt||current.currentPeriodEnd||current.subscriptionEndDate;
    if(!confirm("Cancel your next automatic membership renewal? Access continues through "+
        date(end)+". This does not refund an existing prepaid purchase."))return;
    cancelBtn.disabled=true;status.textContent="Confirming cancellation with Stripe…";
    try{
      const data=await read(await fetch("/api/account/membership/cancel",{
        method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({confirm:true})}));
      status.textContent="Automatic renewal stopped. Your access remains until "+
        date(Number(data.endAt)>0 ? Number(data.endAt)*1000 : end)+".";
      invalidate();await sync();
    }catch(error){status.textContent=error.message;cancelBtn.disabled=false;}
  });
  const url=new URL(location.href),flow=url.searchParams.get("extension");
  if(flow==="success"||flow==="cancelled"){
    status.textContent=flow==="success" ?
      "Payment submitted. Your updated prepaid term will appear after Stripe confirms it." :
      "Extension checkout was closed. No additional prepaid time was purchased.";
    url.searchParams.delete("extension");history.replaceState({}, "", url.pathname+url.search+url.hash);
  }
  window.addEventListener("account-session-changed",()=>void sync());
  document.addEventListener("click",event=>{
    if(event.target.closest('[data-account-tab="membership"]'))void sync();
  });
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)void sync();});
  setInterval(()=>{if(!document.hidden&&document.getElementById("my-profile")?.classList.contains("active"))
    void sync();},60000);
  void sync();
})();
