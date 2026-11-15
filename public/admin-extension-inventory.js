// Owner tools shared by desktop Admin and the installed Admin PWA.
// The server enforces ownership, refund safeguards and Stripe verification.
(() => {
  "use strict";
  const mobile=document.body.classList.contains("sng-admin-app");
  const names={target:"Target",pokemoncenter:"Pokémon Center",walmart:"Walmart"};
  const money=cents=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(cents||0)/100);
  const when=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?
    d.toLocaleString("en-US",{dateStyle:"medium",timeStyle:"short"}):"Not available";};
  const el=(tag,text,cls)=>{
    const node=document.createElement(tag);if(text!=null)node.textContent=String(text);
    if(cls)node.className=cls;return node;
  };
  const api=async(path,init={})=>{
    const r=await fetch(path,{credentials:"same-origin",cache:"no-store",...init});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(d.error||"The Admin request failed.");
    return d;
  };
  const post=(path,body)=>api(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const put=(path,body)=>api(path,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  function addAction(parent,text,callback){
    const b=el("button",text,"admin-edit-button action");b.type="button";b.addEventListener("click",callback);
    parent.append(b);return b;
  }
  function textRow(parent,text,tag="p"){return parent.appendChild(el(tag,text));}
  const message=(holder,value)=>{const status=holder.querySelector("[data-inventory-feedback]");
    if(status)status.textContent=value;};
  let lastData=null,lastRead=0,readBusy=false;
  async function loadData(force=false){
    if(readBusy)return lastData;
    if(!force&&lastData&&Date.now()-lastRead<30000)return lastData;
    readBusy=true;
    try{
      const [pool,purchases]=await Promise.all([
        api("/api/admin/pool-alerts"),api("/api/admin/membership-extensions/purchases")
      ]);
      lastData={pool,purchases};lastRead=Date.now();
      const attention=Object.values(pool.inventory||{}).filter(x=>x.enabled&&["warning","critical"].includes(x.severity));
      let chip=document.getElementById("sng-pool-alert-badge");
      if(!chip&&mobile){chip=el("span","","sng-pool-alert-badge");
        chip.id="sng-pool-alert-badge";document.querySelector("header")?.append(chip);}
      if(chip){const label=attention.length?attention.length+" LOW POOLS":"";
        if(chip.textContent!==label)chip.textContent=label;chip.hidden=!attention.length;}
      return lastData;
    }finally{readBusy=false;}
  }
  async function draw(root,force=false){
    try{
      const data=await loadData(force);
      if(!data)return;
      const list=root.querySelector("[data-inventory-contents]");
      if(!list)return;
      list.replaceChildren();
      const attention=Object.values(data.pool.inventory||{}).filter(x=>x.enabled&&
        ["warning","critical"].includes(x.severity));
      if(attention.length)textRow(list,"Attention needed: "+attention.map(x=>x.name+
        " ("+x.usable+" usable)").join(" · "),"strong");
      else textRow(list,"No enabled pool is below its current warning threshold.");
      if(!data.pool.discordConfigured)textRow(list,
        "Discord alert webhook is not configured. Set DISCORD_ADMIN_PROFILE_WEBHOOK_URL or DISCORD_ACTION_NEEDED_WEBHOOK_URL in Render.");
      for(const key of ["target","pokemoncenter","walmart"]){
        const item=data.pool.inventory?.[key];if(!item)continue;
        const form=el("form",null,"sng-pool-alert-row");
        const heading=el("strong",names[key]+" · "+item.usable+" usable / "+
          item.total+" total · "+item.severity.toUpperCase());
        form.append(heading);
        textRow(form,"Unassigned: "+item.available+" · Held: "+item.held);
        const tools=el("div",null,"sng-pool-alert-fields");
        const enabled=el("input");enabled.type="checkbox";enabled.checked=item.enabled;
        const enabledLabel=el("label","Enabled ");enabledLabel.append(enabled);tools.append(enabledLabel);
        const numeric=(caption,value)=>{
          const label=el("label",caption+" ");
          const field=el("input");field.type="number";field.min="0";field.max="100000";field.step="1";field.value=value;
          label.append(field);tools.append(label);return field;
        };
        const warning=numeric("Low warning ≤",item.warning);
        const critical=numeric("Critical ≤",item.critical);
        form.append(tools);
        const save=addAction(form,"Save "+names[key]+" thresholds",async()=>{
          const params={enabled:enabled.checked,warning:Number(warning.value),critical:Number(critical.value)};
          if(!Number.isSafeInteger(params.warning)||!Number.isSafeInteger(params.critical)||
            params.critical<0||params.warning<params.critical){
            message(root,"Enter valid thresholds: critical must be no higher than warning.");return;
          }
          save.disabled=true;message(root,"Saving and checking the inventory…");
          try{
            await put("/api/admin/pool-alerts",{[key]:params});
            lastData=null;await draw(root,true);
            message(root,names[key]+" thresholds updated.");
          }catch(e){message(root,e.message);}finally{save.disabled=false;}
        });
        list.append(form);
      }
    }catch(e){message(root,e.message);}
  }
  async function renderPurchases(root,force=false){
    try{
      const data=await loadData(force);
      if(!data)return;
      const list=root.querySelector("[data-refund-list]");
      if(!list)return;
      list.replaceChildren();
      const purchases=(data.purchases.purchases||[]).slice().reverse().slice(0,75);
      if(!purchases.length)textRow(list,"No prepaid extension purchases yet.");
      for(const item of purchases){
        const row=el("div",null,"sng-extension-purchase");
        textRow(row,(item.customerEmail||item.customerAccountId||"Customer")+" · "+item.months+" month(s) · "+
          money(item.amountCents),"strong");
        textRow(row,(item.discountCode?item.discountCode+" · ":"")+
          "Paid "+when(item.paidAt)+" · Term through "+when(item.renewalAt)+
          (item.status==="refunded"?" · Refunded "+money(item.refundCents):""));
        if(item.status==="completed"||item.status==="refunding"){
          for(const mode of ["full","unused"]){
            const button=addAction(row,mode==="full"?"Full refund":"Refund unused time",async()=>{
              button.disabled=true;message(root,"Checking exact refund amount and Stripe term…");
              try{
                const quote=await api("/api/admin/membership-extensions/refunds/"+
                  encodeURIComponent(item.id)+"/quote?mode="+mode);
                const amount=money(quote.refundCents);
                const summary=mode==="full"?"FULL REFUND":"UNUSED TIME REFUND";
                const ending=quote.endsImmediately ?
                  "The member's current subscription will end immediately." :
                  "Their original paid term will be restored through "+when(quote.priorPaidTermUntil)+".";
                const approved=confirm(summary+": "+amount+"\n\n"+ending+
                  "\n\nThis creates a real Stripe refund. Continue?");
                if(!approved){message(root,"Refund not submitted.");return;}
                const text=prompt("To confirm a "+amount+" Stripe refund, type REFUND:");
                if(text!=="REFUND"){message(root,"Refund not submitted.");return;}
                const result=await post("/api/admin/membership-extensions/refunds/"+
                  encodeURIComponent(item.id),{mode,confirmed:true,expectedAmountCents:quote.refundCents});
                message(root,"Refund "+result.refundStatus+": "+money(result.refundCents)+
                  ". Stripe reference: "+result.refundId);
                lastData=null;await renderPurchases(root,true);
              }catch(e){message(root,e.message);}finally{button.disabled=false;}
            });
          }
        }
        list.append(row);
      }
    }catch(e){message(root,e.message);}
  }
  async function drawPromotions(root){
    const target=root.querySelector("[data-extension-promos]");
    if(!target)return;
    try{
      const response=await api("/api/admin/discount-codes");
      const codes=(response.codes||[]).filter(x=>x.discountScope==="extension");
      target.replaceChildren();
      if(!codes.length)textRow(target,"No extension-only discounts created yet.");
      for(const code of codes.slice().reverse().slice(0,20)){
        textRow(target,(code.discountLabel?code.discountLabel+" · ":"")+code.code+
          " · "+code.percent+"% off · "+(code.extensionDiscountMonths||"all")+" discounted months"+
          " · "+(code.startsAt?"from "+when(code.startsAt):"available immediately")+
          " · "+(code.expiresAt?"until "+when(code.expiresAt):"no expiry")+
          " · "+(code.active ? (code.startsAt && Date.parse(code.startsAt)>Date.now() ? "Scheduled" : code.expiresAt && Date.parse(code.expiresAt)<=Date.now() ? "Expired" : "Active") : "Inactive"));
      }
    }catch(error){message(root,error.message);}
  }
  function createPromoForm(root,body){
    const form=el("form",null,"sng-pool-alert-row");
    const addField=(text,type="text",defaultValue="")=>{
      const l=el("label",text);
      const input=el("input");input.type=type;if(defaultValue!==undefined)input.value=defaultValue;
      if(type==="number")input.min="1";
      l.append(input);form.append(l);return input;
    };
    const label=addField("Promotion label (e.g. Thanksgiving extension sale)");
    const code=addField("Code (e.g. THANKS25)");code.required=true;code.maxLength=40;
    const percent=addField("Percentage off","number","25");percent.min=1;percent.max=100;percent.required=true;
    const months=addField("Discounted extension months: all or number","text","all");
    const email=addField("Restrict to one member email (optional)","email","");
    const tierLabel=el("label","Membership tier");
    const tier=el("select");
    tier.add(new Option("All tiers","all"));
    const namesTier={1:"Starter",2:"Intermediate",3:"Advanced",4:"Pro",5:"High Volume",
      6:"Power User",7:"Elite",8:"Ultimate"};
    for(const [k,v] of Object.entries(namesTier))tier.add(new Option(v,k));
    tierLabel.append(tier);form.append(tierLabel);
    const uses=addField("Maximum redemptions (optional)","number","");
    const starts=addField("Valid from (local date and time)","datetime-local","");
    const expires=addField("Expires at (local date and time)","datetime-local","");
    const save=addAction(form,"CREATE EXTENSION CODE",()=>{});
    save.type="submit";
    save.replaceWith(save.cloneNode(true));
    const submit=form.lastElementChild;
    form.addEventListener("submit",async e=>{
      e.preventDefault();
      submit.disabled=true;message(root,"Saving the extension-only code to Stripe and the website…");
      try{
        const discount={
          code:code.value.trim().toUpperCase(),percent:Number(percent.value),
          discountLabel:label.value.trim(),discountScope:"extension",
          extensionDiscountMonths:months.value.trim().toLowerCase()||"all",
          discountType:"percent",tier:tier.value,recipientEmail:email.value.trim().toLowerCase()||null,
          sitewide:false,ogOnly:false,appliesToRentals:false,
          maxUses:uses.value?Number(uses.value):null,
          startsAt:starts.value?new Date(starts.value).toISOString():null,
          expiresAt:expires.value?new Date(expires.value).toISOString():null,
          duration:"once"
        };
        const result=await post("/api/admin/discount-codes",discount);
        message(root,result.discount.code+" created. It becomes redeemable at the scheduled time.");
        form.reset();months.value="all";percent.value="25";await drawPromotions(root);
      }catch(error){message(root,error.message);}
      finally{submit.disabled=false;}
    });
    body.append(form);
    const list=el("div");list.dataset.extensionPromos="";body.append(list);
  }
  function newPanel(kind){
    const shell=el("section",null,mobile?"panel sng-admin-pool-shell":"admin-feature-panel sng-admin-pool-shell");
    shell.dataset.extensionInventoryShell=kind;
    const details=el("details");
    const title=el("summary",kind==="inventory"?"Pool availability alerts":kind==="promotion"?"Create extension discount codes":"Prepaid extensions & refunds");
    details.append(title);
    const body=el("div",null,"sng-admin-pool-body");
    const messageNode=el("p","",null);messageNode.setAttribute("role","status");
    messageNode.dataset.inventoryFeedback="";
    if(kind==="inventory"){
      textRow(body,"Live unassigned inventory minus Restore Holds. Alert thresholds are editable by retailer.");
      const list=el("div");list.dataset.inventoryContents="";body.append(list);
      const check=addAction(body,"CHECK POOLS & SEND DUE ALERTS",async()=>{
        check.disabled=true;message(shell,"Running the low-pool check…");
        try{await post("/api/admin/pool-alerts/check",{});lastData=null;await draw(shell,true);
          message(shell,"Pool check complete.");}
        catch(e){message(shell,e.message);}finally{check.disabled=false;}
      });
    }else if(kind==="promotion"){
      textRow(body,"Create percentage codes for prepaid extensions. The default applies to every month the member purchases. Enter exact start/end times to schedule a sale.");
      createPromoForm(shell,body);
    }else{
      textRow(body,"Refunds apply to the prepaid extension payment only. Stripe calculates the final payment status. Refunds change the remaining membership access.");
      const list=el("div");list.dataset.refundList="";body.append(list);
    }
    body.append(messageNode);details.append(body);shell.append(details);
    details.addEventListener("toggle",()=>{if(details.open){
      if(kind==="inventory")void draw(shell);
      else if(kind==="promotion")void drawPromotions(shell);
      else void renderPurchases(shell);
    }});
    return shell;
  }
  function desktopMount(){
    const form=document.getElementById("discountCodeForm");
    if(!form)return;
    const parent=form.closest(".admin-membership-tools")||form.parentElement;
    if(!parent||parent.querySelector("[data-extension-inventory-shell]"))return;
    parent.append(newPanel("inventory"),newPanel("refunds"));
  }
  function mobileMount(){
    if(!mobile||document.getElementById("workspace")?.hidden)return;
    const heading=document.getElementById("heading")?.textContent||"";
    const c=document.getElementById("content");
    if(!c||!["Profiles","More"].includes(heading))return;
    if(!c.querySelector('[data-extension-inventory-shell="inventory"]'))
      c.append(newPanel("inventory"));
    if(heading==="More"&&!c.querySelector('[data-extension-inventory-shell="promotion"]'))
      c.append(newPanel("promotion"));
    if(heading==="More"&&!c.querySelector('[data-extension-inventory-shell="refunds"]'))
      c.append(newPanel("refunds"));
  }
  function mobileCancelButtons(){
    if(!mobile)return;
    for(const extend of document.querySelectorAll("#content [data-extend-membership]")){
      const id=extend.dataset.extendMembership;
      if(!id||extend.parentElement?.querySelector('[data-admin-cancel-membership="'+CSS.escape(id)+'"]'))continue;
      const b=el("button","CANCEL RENEWAL","action");b.type="button";
      b.dataset.adminCancelMembership=id;extend.after(b);
    }
  }
  document.addEventListener("click",async event=>{
    const button=event.target.closest?.("[data-admin-cancel-membership]");
    if(!button)return;
    event.preventDefault();event.stopPropagation();
    const id=button.dataset.adminCancelMembership;
    const modeText=prompt("Membership cancellation for customer "+id+
      "\nType END to stop renewal at the end of paid time, or NOW to cancel immediately:");
    if(!modeText)return;
    const mode=modeText.trim().toUpperCase()==="END"?"period_end":
      modeText.trim().toUpperCase()==="NOW"?"now":null;
    if(!mode){alert("No cancellation was performed. Enter END or NOW.");return;}
    if(!confirm(mode==="now"?
      "Cancel the active Stripe subscription immediately? This ends the customer's access now and does not issue a refund.":
      "Schedule Stripe cancellation at the end of the member's fully paid term?"))return;
    button.disabled=true;
    try{
      const response=await post("/api/admin/customers/"+encodeURIComponent(id)+"/membership/cancel",
        {mode,confirmed:true});
      alert(response.already?"Cancellation was already scheduled.":
        mode==="now"?"Membership cancelled immediately in Stripe.":
        "Cancellation scheduled at the verified paid term end.");
      document.dispatchEvent(new Event("sng-membership-admin-changed"));
    }catch(e){alert(e.message);}finally{button.disabled=false;}
  },true);
  function mount(){
    if(mobile){mobileMount();mobileCancelButtons();}
    else desktopMount();
  }
  const observer=new MutationObserver(mount);
  observer.observe(document.body,{subtree:true,childList:true});
  mount();
  setInterval(()=>{if(document.hidden)return;lastData=null;
    if(mobile)mobileMount();
    const roots=document.querySelectorAll('[data-extension-inventory-shell]');
    roots.forEach(root=>{
      if(!root.querySelector("details")?.open)return;
      if(root.dataset.extensionInventoryShell==="inventory")void draw(root,true);
    });
    void loadData(true).catch(()=>{});
  },120000);
})();
