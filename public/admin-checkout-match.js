(()=>{
"use strict";
const $=id=>document.getElementById(id);
const e=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let groups=[]; let trackingOrders=[];

let unmatchedEmailOrders = [];
let linkableCustomers = [];
function renderUnlinkedEmails(){
 const needle=String($("unlinked-email-search").value||"").toLowerCase().trim();
 const shown=unmatchedEmailOrders.filter(o=>
  [o.retailerLogin,o.profileLabel,o.retailer,o.orderNumber,
   ...(o.exactLinkedAccounts||[]).map(p=>p.customer),
   ...(o.products||[]).map(p=>p.name)]
   .join(" ").toLowerCase().includes(needle));
 $("unlinked-email-results").innerHTML=shown.slice(0,100).map(o=>{
  const current=String(o.effectiveStatus||o.status||"").toLowerCase();
  const candidates=Array.isArray(o.exactLinkedAccounts)?o.exactLinkedAccounts:[];
  const owners=[...new Set(candidates.filter(x=>x.eligible).map(x=>x.customer).filter(Boolean))];
  const pendingEligible=candidates.filter(item=>item.eligible&&!item.activatedAt);
  const explanation=owners.length===1
   ?"One eligible linked account: "+owners[0]+
      (pendingEligible.length?" (profiles awaiting activation — checkout still counts).":"")+
      " Review assignment details if still unmatched."
   :owners.length>1?"Conflicting eligible owners. Verify the assignment before linking."
   :candidates.length?"Retailer login found, but its ownership dates do not cover this checkout."
   :"This retailer email was not found on any correctly linked retailer account.";
  const when=new Date(o.checkoutAt||0);
  const whenText=Number.isFinite(when.getTime())?when.toLocaleString():"Unknown date";
  const itemLabels=(Array.isArray(o.products)?o.products:[]).slice(0,6).map(p=>
   '<span>'+e(p.name)+' x'+Math.max(0,Number(p.quantity)||0)+'</span>').join("");
  const ix=unmatchedEmailOrders.indexOf(o);
  const options=linkableCustomers.map(c=>
   '<option value="'+e(c.id)+'"'+(owners.length===1&&owners[0]===c.label?' selected':'')+'>'+e(c.label)+'</option>').join("");
  const assign=o.retailerLogin
   ?'<details class="owner-review"><summary>Verify and recover this checkout</summary>'+
    '<p class="notice">Confirm the exact retailer login and who owned it on the checkout date. Activation is not required. This links only this original Discord order, updates linked checkouts and customer app, and sends the customer notification.</p>'+
    '<label for="owner-for-'+ix+'">Verified customer</label>'+
    '<select id="owner-for-'+ix+'"><option value="">Choose a customer...</option>'+options+'</select>'+
    '<button type="button" data-link-one="'+ix+'">VERIFY OWNERSHIP AND LINK THIS ORDER</button></details>'
   :'<p class="notice">No source login email; verify this order manually with support.</p>';
  const amount=Number(o.checkoutValue);
  const valueText=Number.isFinite(amount)&&amount>0
   ?"Checkout value "+String.fromCharCode(36)+amount.toFixed(2):"Value not verified";
  return '<section class="match"><h3>'+e(o.retailerLogin||"Email not provided")+'</h3>'+
   '<div class="meta">'+e(o.retailer||"Retailer")+' - '+e(whenText)+' - '+e(current)+
   ' - '+e(valueText)+'<div>Profile: '+e(o.profileLabel||"Not provided")+'</div></div>'+
   '<div class="match-products">'+itemLabels+'</div><p class="notice">'+e(explanation)+'</p>'+assign+'</section>';
 }).join("")||'<p class="notice">No unmatched checkout matches this search.</p>';
 if(shown.length>100)$("unlinked-email-results").insertAdjacentHTML("beforeend",
  '<p class="notice">Showing the first 100 matches. Narrow your search for more.</p>');
}
async function loadUnlinkedEmails(){
 const response=await fetch("/api/admin/checkout-link-diagnostics",{
  credentials:"same-origin",cache:"no-store"
 });
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(data.error||"Could not read checkout diagnostics. Sign in as Admin.");
 linkableCustomers=Array.isArray(data.customers)?data.customers:[];
 unmatchedEmailOrders=(Array.isArray(data.rows)?data.rows:[])
  .filter(o=>!o.owner&&!/cancel|refund|failed|declined/i.test(String(o.effectiveStatus||o.status||"")))
  .sort((a,b)=>Date.parse(b.checkoutAt||0)-Date.parse(a.checkoutAt||0));
 $("email-unmatched-count").textContent=unmatchedEmailOrders.length.toLocaleString();
 $("unlinked-email-status").className="notice";
 $("unlinked-email-status").textContent="Recent unlinked checkouts from the original Discord success feed.";
 renderUnlinkedEmails();
}
function refreshUnlinkedEmails(){
 if(document.hidden)return;
 void loadUnlinkedEmails().catch(error=>{
  $("unlinked-email-status").className="notice bad";
  $("unlinked-email-status").textContent=error.message;
 });
}
$("unlinked-email-results").addEventListener("click",async event=>{
 const button=event.target.closest("button[data-link-one]");
 if(!button)return;
 const index=Number(button.dataset.linkOne);
 if(!Number.isInteger(index))return;
 const order=unmatchedEmailOrders[index];
 if(!order)return;
 const customerAccountId=$("owner-for-"+index)?.value;
 const customer=linkableCustomers.find(item=>String(item.id)===String(customerAccountId));
 if(!customer){
  $("unlinked-email-status").textContent="Choose the customer who owned this retailer account at checkout time.";
  return;
 }
 if(!confirm("Have you verified in your retailer account records that "+
  customer.label+" owned "+order.retailerLogin+" at "+(order.checkoutAt||"checkout time")+
  "? Only this exact original Discord order will be linked. No order will be created."))return;
 button.disabled=true;
 $("unlinked-email-status").textContent="Verifying the original Discord checkout and customer assignment...";
 try{
  const response=await fetch("/api/admin/checkout-link-diagnostics/assign",{
   method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({sourceId:order.id,customerAccountId:customer.id,verifiedByAdmin:true})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||"Could not verify this checkout owner.");
  await loadUnlinkedEmails();
  await load().catch(()=>{});
  $("unlinked-email-status").className="notice good";
  $("unlinked-email-status").textContent=result.linked
   ?"Verified original checkout linked to "+customer.label+". The Success tab and order notification will update."
   :"Checkout already belonged to "+customer.label+".";
 }catch(error){
  $("unlinked-email-status").textContent=error.message;
  $("unlinked-email-status").className="notice bad";
  button.disabled=false;
 }
});
$("unlinked-email-search").addEventListener("input",renderUnlinkedEmails);
document.addEventListener("visibilitychange",refreshUnlinkedEmails);
setInterval(refreshUnlinkedEmails,60000);
refreshUnlinkedEmails();

const requestedRetailer=new URLSearchParams(location.search).get("retailer")||"";
if(/^(?:pkc|pokemon center)$/i.test(requestedRetailer))$("search").value="PKC";
function render(){
 const needle=$("search").value.trim().toLowerCase();
 const matches=groups.filter(g=>(g.profileLabel+" "+g.retailer+" "+(g.products||[]).map(p=>p.name).join(" ")).toLowerCase().includes(needle));
 $("results").innerHTML=matches.slice(0,100).map((g,i)=>{
  const ix=groups.indexOf(g);
  return '<section class="match"><h3>'+e(g.profileLabel)+'</h3><div class="meta">'+e(g.retailer)+
   ' · '+g.count+' unlinked checkouts · '+e(g.firstAt?.slice(0,10)||"Unknown date")+' to '+
   e(g.lastAt?.slice(0,10)||"Unknown date")+'</div>'+
   '<div class="match-products">'+(Array.isArray(g.products)?g.products:[]).slice(0,6).map(p=>
     '<span>'+e(p.name)+' ×'+Math.max(0,Math.floor(Number(p.quantity)||0))+'</span>').join('')+'</div>'+
   '<label for="target-'+ix+'">Website customer to link</label><select id="target-'+ix+'" '+(g.eligibleCustomers.length?'':'disabled')+'><option value="">Choose a verified customer…</option>'+
   g.eligibleCustomers.map(c=>'<option value="'+e(c.id)+'">'+e(c.label)+'</option>').join('')+
   '</select><button type="button" data-index="'+ix+'" '+(g.eligibleCustomers.length?'':'disabled')+'>CONFIRM PROFILE MATCH</button>'+
   (g.eligibleCustomers.length?'':'<p class="notice">No eligible paid or linked retailer account exists for these dates. Verify the account in Admin Profiles and assign it to the correct customer first, then refresh this page.</p>')+
   '</section>';
 }).join('')||'<p class="notice">No unmatched Discord profile labels found.</p>';
 if(matches.length>100)$("results").insertAdjacentHTML("beforeend",'<p class="notice">Showing the first 100 matches. Narrow your search for more.</p>');
}
async function load(){
 const response=await fetch("/api/admin/discord-checkout-profile-matching",{credentials:"same-origin",cache:"no-store"});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||"Unable to load profiles. Sign in to Admin again.");
 groups=Array.isArray(data.groups)?data.groups:[];
 $("unmatched").textContent=Number(data.unmatchedCount||0).toLocaleString();
 $("groups").textContent=groups.length.toLocaleString();
 $("status").textContent=data.unlabeledCount?
  data.unlabeledCount+" checkouts also lack a usable Discord profile label; those cannot be auto-matched.":
  "Select the correct customer only when you can verify who owned the checkout profile.";
 render();
 await loadTracking().catch(error=>{$("tracking-status").textContent=error.message;$("tracking-status").className="notice bad";});
}

function renderTracking(){
 const needle=$("tracking-search").value.trim().toLowerCase();
 const visible=trackingOrders.filter(o=>
   (o.customer+" "+o.retailer+" "+o.product+" "+o.profileLabel).toLowerCase().includes(needle));
 $("tracking-results").innerHTML=visible.slice(0,75).map(order=>{
  const index=trackingOrders.indexOf(order);
  return '<section class="match"><h3>'+e(order.product)+'</h3><div class="meta">'+
    e(order.retailer)+' · '+e(order.customer)+' · '+e(order.checkoutAt?.slice(0,16)||"Unknown date")+
    '<div>Discord profile: '+e(order.profileLabel||"not provided")+'</div></div>'+
    '<label for="order-number-'+index+'">Retailer order number from verified receipt</label>'+
    '<input id="order-number-'+index+'" type="text" autocomplete="off" maxlength="100" placeholder="Enter full exact retailer order number">'+
    '<button type="button" data-track-index="'+index+'">VERIFY RECEIPT & LINK ORDER NUMBER</button></section>';
 }).join('')||'<p class="notice">No matched checkouts are waiting for order-number verification.</p>';
 if(visible.length>75)$("tracking-results").insertAdjacentHTML("beforeend",
  '<p class="notice">Showing 75 orders. Search to narrow the list.</p>');
}
async function loadTracking(){
 const response=await fetch("/api/admin/discord-checkout-tracking-link",{credentials:"same-origin",cache:"no-store"});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||"Unable to retrieve missing retailer order numbers.");
 trackingOrders=Array.isArray(data.orders)?data.orders:[];
 $("tracking-count").textContent=Number(data.missingCount||0).toLocaleString();
 $("tracking-status").textContent="Only use an order number confirmed on the actual retailer receipt. The customer must already be linked to the checkout.";
 $("tracking-status").className="notice";
 renderTracking();
}
$("tracking-search").addEventListener("input",renderTracking);
$("tracking-results").addEventListener("click",async event=>{
 const button=event.target.closest("button[data-track-index]");
 if(!button)return;
 const index=Number(button.dataset.trackIndex),order=trackingOrders[index];
 if(!order)return;
 const number=$("order-number-"+index)?.value?.trim();
 if(!number){$("tracking-status").textContent="Enter the full retailer order number.";return;}
 if(!confirm('Have you verified order '+number+' on the actual '+order.retailer+
   ' confirmation for '+order.customer+'? This will update tracking on the existing Discord checkout only.'))return;
 button.disabled=true;
 $("tracking-status").textContent="Linking verified order number without creating a new checkout…";
 try{
  const response=await fetch("/api/admin/discord-checkout-tracking-link",{
   method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({id:order.id,orderNumber:number,verifiedByAdmin:true})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(result.error||"Unable to verify the retailer order number.");
  await loadTracking();
  $("tracking-status").textContent="Verified order number attached. The shipment scanner can now match future retailer updates without creating a duplicate checkout.";
  $("tracking-status").className="notice good";
 }catch(error){$("tracking-status").textContent=error.message;$("tracking-status").className="notice bad";button.disabled=false;}
});

$("search").addEventListener("input",render);
$("results").addEventListener("click",async event=>{
 const button=event.target.closest("button[data-index]");
 if(!button)return;
 const index=Number(button.dataset.index),group=groups[index];
 if(!group)return;
 const accountId=$("target-"+index)?.value;
 if(!accountId){$("status").textContent="Choose a verified customer before confirming.";return;}
 const owner=group.eligibleCustomers.find(c=>String(c.id)===accountId);
 if(!owner)return;
 if(!confirm('Link checkout profile "'+group.profileLabel+'" at '+group.retailer+' to '+owner.label+'? This may update historical success totals.'))return;
 button.disabled=true;$("status").textContent="Safely matching existing checkout records…";
 try{
  const response=await fetch("/api/admin/discord-checkout-profile-matching",{method:"POST",
    credentials:"same-origin",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({retailer:group.retailer,profileLabel:group.profileLabel,customerAccountId:accountId})});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(result.error||"Unable to match this profile.");
  await load();
  $("status").textContent="Matched "+result.linked+" existing checkouts. Remaining under this label: "+result.remaining+". No duplicates created.";
  $("status").className="notice good";
 }catch(error){$("status").textContent=error.message;$("status").className="notice bad";button.disabled=false;}
});
load().catch(error=>{$("status").textContent=error.message;$("status").className="notice bad"});
})();
