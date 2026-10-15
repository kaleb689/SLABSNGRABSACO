(()=>{
"use strict";
const $=id=>document.getElementById(id);
const e=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let groups=[]; let trackingOrders=[];
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
