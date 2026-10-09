(() => {
const $=id=>document.getElementById(id),esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let tab="overview",data={customers:[],activation:null,availability:null,usage:null,success:{records:[]}},authenticated=false,stream=null;
let successDays=30;
let customerSearchText="", mobileRefreshTimer=null, mobileRefreshPending=false, mobileRefreshRunning=false;
const mobileControlFocused=()=>{
  const active=document.activeElement;
  return Boolean(authenticated && active?.closest?.("#workspace") &&
    (active.matches?.("input, textarea, select, [contenteditable='true']") || active.isContentEditable));
};
function scheduleMobileRefresh(){
  mobileRefreshPending=true;
  clearTimeout(mobileRefreshTimer);
  mobileRefreshTimer=setTimeout(()=>void refresh(),300);
}
const get=async path=>{const r=await fetch(path,{credentials:"same-origin",cache:"no-store"});if(r.status===401)throw Error("SESSION_EXPIRED");const j=await r.json();if(!r.ok)throw Error(j.error||"Unable to load data");return j;};
function auth(value){authenticated=value;$("signin").hidden=value;$("workspace").hidden=!value;$("tabs").hidden=!value;if(!value){stream?.close();stream=null;}}
const decode64=v=>Uint8Array.from(atob(String(v).replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(v.length/4)*4,"=")),c=>c.charCodeAt(0));
const encode64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
const post=async(path,body)=>{const r=await fetch(path,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error||"Passkey request failed");return j;};
async function passkeyRegister(){const x=await post("/api/admin/passkeys/register/options",{});const pk=x.publicKey;pk.challenge=decode64(pk.challenge);pk.user.id=decode64(pk.user.id);pk.excludeCredentials=(pk.excludeCredentials||[]).map(c=>({...c,id:decode64(c.id)}));const c=await navigator.credentials.create({publicKey:pk});await post("/api/admin/passkeys/register/verify",{requestId:x.requestId,credential:{id:c.id,type:c.type,response:{clientDataJSON:encode64(c.response.clientDataJSON),attestationObject:encode64(c.response.attestationObject)}}});alert("Face ID passkey registered. You can now sign in with Face ID.");}
async function passkeyLogin(){const x=await post("/api/admin/passkeys/login/options",{});const pk=x.publicKey;pk.challenge=decode64(pk.challenge);pk.allowCredentials=(pk.allowCredentials||[]).map(c=>({...c,id:decode64(c.id)}));const c=await navigator.credentials.get({publicKey:pk});await post("/api/admin/passkeys/login/verify",{requestId:x.requestId,credential:{id:c.id,type:c.type,response:{authenticatorData:encode64(c.response.authenticatorData),clientDataJSON:encode64(c.response.clientDataJSON),signature:encode64(c.response.signature)}}});await refresh(true);}
const pushLabels={newOrders:"New orders",activations:"Profile activations",expirations:"Expiring profiles",actionNeeded:"Action needed",support:"Support",checkouts:"Checkouts",deployments:"Deployments"};
async function pushSettings(){const c=$("push-settings");if(!c)return;try{const d=await get("/api/admin/push/settings");c.innerHTML='<button class="action" id="enable-push">ENABLE PUSH NOTIFICATIONS</button>'+Object.entries(pushLabels).map(([k,v])=>'<label style="display:flex;align-items:center;justify-content:space-between">'+esc(v)+'<input style="width:26px;min-height:26px" type="checkbox" data-push="'+k+'" '+(d.preferences?.[k]?'checked':'')+'></label>').join('');c.querySelectorAll("[data-push]").forEach(el=>el.onchange=async()=>{await fetch("/api/admin/push/settings",{method:"PUT",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({[el.dataset.push]:el.checked})});});$("enable-push").onclick=async()=>{try{if(!("PushManager" in window)||!("Notification" in window))throw Error("Install the app to enable iPhone push.");if(await Notification.requestPermission()!=="granted")throw Error("Notification permission not granted.");if(!d.publicKey)throw Error("Push server key unavailable.");const reg=await navigator.serviceWorker.ready;const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decode64(d.publicKey)});await post("/api/admin/push/subscribe",sub.toJSON());alert("Notifications enabled.");}catch(e){alert(e.message);}};}catch(e){c.textContent=e.message;}}
function metric(label,value){return '<div class="metric"><small>'+esc(label)+'</small><strong>'+esc(value??"—")+'</strong></div>';}
function panel(title,body){return '<section class="panel"><h2>'+esc(title)+'</h2>'+body+'</section>';}
function customerName(x){const p=x.profile||{};return [p.firstName,p.lastName].filter(Boolean).join(" ")||p.profileName||"Customer";}
function customers(){return Array.isArray(data.customers)?data.customers:data.customers.submissions||[];}
function activationCount(a,status){if(!Array.isArray(a?.customers))return "—";const profiles=a.customers.flatMap(c=>Array.isArray(c.profiles)?c.profiles:[]).filter(p=>p.type==="paid");return profiles.filter(p=>p.status===status).length;}
function render(){
$("heading").textContent=({overview:"Overview",success:"Success",customers:"Customers",profiles:"Profiles",usage:"App Usage",more:"More"})[tab];
document.querySelectorAll("[data-tab]").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
const list=customers(),a=data.activation||{},v=data.availability||{},u=data.usage||{},c=$("content");
if(tab==="overview"){c.innerHTML='<div class="metrics">'+metric("Customer orders",list.length)+metric("Awaiting activation",activationCount(a,"awaiting_activation"))+metric("App users · 7 days",u.activeUsers7d??"—")+metric("Installed devices",u.installedDevices??"—")+'</div>'+panel("Quick actions",'<div class="links"><a class="action" href="/admin.html">OPEN FULL ADMIN DASHBOARD ↗</a><a class="action" href="/admin.html#profileActivationTracker">PROFILE ACTIVATION TOOLS ↗</a></div>')+panel("Status","<p>Data refreshes automatically while this app is open. Sensitive changes use the full secure admin interface.</p>");}
if(tab==="success"){
  const days=successDays, now=new Date();
  const cutoff=days==="all"?0:days==="mtd"?new Date(now.getFullYear(),now.getMonth(),1).getTime():days==="ytd"?new Date(now.getFullYear(),0,1).getTime():Date.now()-days*86400000;
  const records=(data.success?.records||[]).filter(x=>{
    const time=new Date(x.checkoutAt).getTime();
    return Number.isFinite(time) && time>=cutoff && time<=Date.now()+60000;
  });
  const dollars=n=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(n)||0);
  const spent=records.reduce((sum,x)=>sum+Math.max(0,Number(x.orderTotal)||0),0);
  const retailers=new Map(),products=new Map();
  records.forEach(order=>{
    const retailer=String(order.retailer||"Other");
    retailers.set(retailer,(retailers.get(retailer)||0)+1);
    (order.items||[]).forEach(item=>{
      const name=String(item.name||"Product");
      const key=retailer.toLowerCase()+"|"+name.toLowerCase();
      const entry=products.get(key)||{name,retailer,quantity:0,imageUrl:item.imageUrl||""};
      entry.quantity+=Math.max(0,Number(item.quantity)||0);
      if(!entry.imageUrl)entry.imageUrl=item.imageUrl||"";
      products.set(key,entry);
    });
  });
  const palette=["#32d9f9","#a48dff","#ffcf68","#5be1a4","#fe8bae","#ff9b66"];
  const n=records.length;
  const chart=Array.from(retailers.entries()).sort((a,b)=>b[1]-a[1]);
  let offset=0;
  const parts=chart.map(([,count],i)=>{const start=offset;offset+=n?count/n*100:0;return palette[i%palette.length]+" "+start+"% "+offset+"%";});
  const donut='<div style="width:165px;height:165px;border-radius:50%;margin:16px auto;display:grid;place-items:center;background:conic-gradient('+(parts.join(",")||"#264458 0% 100%")+')"><div style="background:#071826;border-radius:50%;width:113px;height:113px;display:grid;place-items:center;text-align:center;font-size:24px;font-weight:900">'+n+'<small style="display:block;font-size:10px;color:#a2bed0">ORDERS</small></div></div>';
  const legend=chart.map(([name,count],i)=>'<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid #22445a"><span><i style="display:inline-block;background:'+palette[i%palette.length]+';width:10px;height:10px;border-radius:50%;margin-right:9px"></i>'+esc(name)+'</span><strong>'+count+' · '+(n?(100*count/n).toFixed(1):"0")+'%</strong></div>').join("");
  const validImage=url=>typeof url==="string" && /^(https:\/\/|\/(?!\/))/.test(url);
  const productList=Array.from(products.values()).sort((a,b)=>b.quantity-a.quantity).map(p=>'<div class="item" style="display:flex;align-items:center;gap:12px"><img alt="" loading="lazy" src="'+esc(validImage(p.imageUrl)?p.imageUrl:"/slabsngrabs-aco-logo-transparent.png")+'" style="width:58px;height:58px;object-fit:contain;border-radius:9px;background:#102638"><div style="flex:1;min-width:0"><strong>'+esc(p.name)+'</strong><small>'+esc(p.retailer)+'</small></div><strong style="color:#6be8ff;white-space:nowrap">×'+p.quantity+'</strong></div>').join("")||'<p>No matching purchases in this period.</p>';
  const avg=n?spent/n:0;
  const rangeLabels={1:"TODAY",7:"LAST 7 DAYS",30:"LAST 30 DAYS",90:"LAST 90 DAYS",mtd:"THIS MONTH",ytd:"YEAR TO DATE",all:"ALL TIME"};
  const ranges=[[1,"Today"],[7,"7D"],[30,"30D"],[90,"90D"],["mtd","MTD"],["ytd","YTD"],["all","All"]];
  const ticks=days===1?8:days===7?7:12;
  const min=cutoff||Math.min(Date.now(),...records.map(x=>Date.parse(x.checkoutAt)).filter(Number.isFinite));
  const span=Math.max(1,Date.now()-min),buckets=Array(ticks).fill(0);
  records.forEach(order=>{const t=Date.parse(order.checkoutAt);if(Number.isFinite(t)){const i=Math.min(ticks-1,Math.max(0,Math.floor((t-min)/span*ticks)));buckets[i]+=Math.max(0,Number(order.orderTotal)||0);}});
  const max=Math.max(1,...buckets);
  const line=buckets.map((value,i)=>(i?'L':'M')+(16+i*(288/(ticks-1))).toFixed(1)+' '+(76-value/max*56).toFixed(1)).join(' ');
  const trend='<svg class="admin-spend-trend" viewBox="0 0 320 100" preserveAspectRatio="none" role="img" aria-label="Checkout spending trend for selected period"><path d="'+line+'" fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const rangeButtons='<div class="admin-spend-ranges" role="group" aria-label="Total spent period">'+ranges.map(([value,label])=>'<button type="button" data-success-days="'+value+'" aria-pressed="'+(String(value)===String(days))+'">'+label+'</button>').join('')+'</div>';
  const hero='<section class="admin-spend-hero"><span class="admin-spend-kicker">TOTAL SPENT · '+rangeLabels[days]+'</span><strong>'+dollars(spent)+'</strong><p>'+n+' orders · '+retailers.size+' retailers · avg '+dollars(avg)+'</p>'+trend+'</section>';
  c.innerHTML=rangeButtons+hero+'<div class="metrics admin-success-metrics">'+metric("Total orders",n)+metric("Retailers",retailers.size)+'</div>'+panel("Orders by retailer",donut+legend)+panel("Products purchased",productList);
  c.querySelectorAll("[data-success-days]").forEach(b=>b.addEventListener("click",()=>{successDays=/^(mtd|ytd|all)$/.test(b.dataset.successDays)?b.dataset.successDays:Number(b.dataset.successDays);render();}));
}
if(tab==="customers"){c.innerHTML='<input class="search" id="customer-search" type="search" placeholder="Search name or email">'+ '<div id="customer-results"></div>';$("customer-search").value=customerSearchText;const show=()=>{customerSearchText=$("customer-search").value;const q=customerSearchText.toLowerCase();$("customer-results").innerHTML=list.filter(x=>(customerName(x)+" "+(x.profile?.email||"")).toLowerCase().includes(q)).slice(0,150).map(x=>'<article class="item"><strong>'+esc(customerName(x))+'</strong><small>'+esc(x.profile?.email||"")+' · '+esc(x.plan?.name||"Membership")+'</small><button data-view="'+esc(x.customerAccountId||x.id)+'">VIEW CUSTOMER PAGE ↗</button></article>').join("")||"<p>No matching customers.</p>";};$("customer-search").addEventListener("input",show);show();}
if(tab==="profiles"){c.innerHTML='<div class="metrics">'+metric("Awaiting activation",activationCount(a,"awaiting_activation"))+metric("Activated",activationCount(a,"activated"))+metric("Expired",activationCount(a,"expired"))+metric("Customer orders",list.length)+'</div>'+panel("Profile workflow",'<p>Open the full tracker to activate, extend, or return profiles using the existing verified controls.</p><a href="/admin.html#profileActivationTracker">OPEN PROFILE WORKFLOW ↗</a>')+panel("Inventory",'<p>Target, Walmart, and Pokémon Center inventory remains managed in the full Admin dashboard.</p><a href="/admin.html">OPEN INVENTORY MANAGER ↗</a>');}
if(tab==="usage"){c.innerHTML='<div class="metrics">'+metric("Installed users",u.installedUsers??"—")+metric("Installed devices",u.installedDevices??"—")+metric("Active users · 7D",u.activeUsers7d??"—")+metric("Active users · 30D",u.activeUsers30d??"—")+'</div>'+panel("Tracking information","<p>Counts begin when updated customer apps report activity. PWA installs are confirmed by app mode or an installation event; they are not App Store downloads.</p>")+panel("Recent activity",(u.recent||[]).slice(0,50).map(x=>'<article class="item"><strong>'+esc(x.name||"Customer")+'</strong><small>'+esc(x.email||"")+' · '+esc(x.platform||"Other")+' · '+(x.installedConfirmed?"Installed":"Web activity")+'</small><small>Last active: '+esc(x.lastSeenAt?new Date(x.lastSeenAt).toLocaleString():"—")+'</small></article>').join("")||"<p>No app activity has been recorded yet.</p>");}
if(tab==="more"){c.innerHTML=panel("Push notifications",`<div id="push-settings">Loading…</div>`)+panel("Admin tools",'<div class="links"><button class="action" id="register-face-id">SET UP FACE ID ON THIS IPHONE</button><a class="action" href="/admin.html">FULL ADMIN DASHBOARD ↗</a><a class="action" href="/admin.html">DISCOUNTS AND MEMBERSHIPS ↗</a><a class="action" href="/admin.html">DISCORD AND NOTIFICATIONS ↗</a><button class="action" id="signout">SIGN OUT</button></div>');void pushSettings();$("register-face-id").onclick=async()=>{try{await passkeyRegister();}catch(e){alert(e.message);}};$("signout").onclick=async()=>{await fetch("/api/admin/logout",{method:"POST",credentials:"same-origin"}).catch(()=>{});auth(false);};}
}
async function refresh(force=false){
  if(mobileRefreshRunning){mobileRefreshPending=true;return;}
  // Don't overwrite live search text or form controls in the mobile Admin app.
  if(!force && authenticated && (document.hidden || mobileControlFocused())){
    mobileRefreshPending=true;
    return;
  }
  mobileRefreshPending=false;
  mobileRefreshRunning=true;
  try{
    const results=await Promise.allSettled([
      get("/api/admin/submissions"),
      get("/api/admin/profile-activation-tracker"),
      get("/api/managed-availability"),
      get("/api/admin/app-usage"),
      get("/api/admin/success-overview")
    ]);
    const keys=["customers","activation","availability","usage","success"];
    results.forEach((r,i)=>{if(r.status==="fulfilled")data[keys[i]]=r.value;});
    if(results.some(r=>r.status==="rejected"&&r.reason.message==="SESSION_EXPIRED")){
      auth(false);return;
    }
    if(results[0].status==="rejected")throw results[0].reason;
    if(results[1].status==="rejected")data.activation=null;
    // A field may gain focus while the network request is in flight.
    if(!force && authenticated && (document.hidden || mobileControlFocused())){
      mobileRefreshPending=true;
      return;
    }
    auth(true);
    $("updated").textContent="Updated "+new Date().toLocaleTimeString();
    const x=window.scrollX,y=window.scrollY;
    render();
    requestAnimationFrame(()=>window.scrollTo(x,y));
    if(!stream){
      stream=new EventSource("/api/admin/live/events");
      stream.addEventListener("data-change",scheduleMobileRefresh);
      // Catch any edits made while the app was sleeping or disconnected.
      stream.addEventListener("open",scheduleMobileRefresh);
    }
  }catch(e){
    if(e.message==="SESSION_EXPIRED"){auth(false);return;}
    $("content").innerHTML='<p class="error">'+esc(e.message)+'</p>';
  }finally{
    mobileRefreshRunning=false;
    // Never lose an update that arrived while another refresh was running.
    if(mobileRefreshPending && !document.hidden) scheduleMobileRefresh();
  }
}
const faceButton=document.getElementById("face-id-login");if(faceButton){faceButton.onclick=async()=>{faceButton.disabled=true;try{await passkeyLogin();}catch(e){$("login-message").textContent=e.message;}finally{faceButton.disabled=false;}};}
$("login").addEventListener("submit",async ev=>{ev.preventDefault();const f=new FormData(ev.currentTarget);const r=await fetch("/api/admin/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:f.get("password"),code:f.get("code")})});if(!r.ok){$("login-message").textContent="Sign in failed. Check your password and authenticator code.";return;}ev.currentTarget.reset();$("login-message").textContent="";await refresh(true);});
$("refresh").onclick=()=>void refresh(true);
$("tabs").addEventListener("click",e=>{const b=e.target.closest("[data-tab]");if(!b)return;tab=b.dataset.tab;render();window.scrollTo(0,0);});
$("content").addEventListener("click",async e=>{const b=e.target.closest("[data-view]");if(!b)return;b.disabled=true;try{const r=await fetch("/api/admin/customers/"+encodeURIComponent(b.dataset.view)+"/view-as-user",{method:"POST",credentials:"same-origin"});const j=await r.json();if(!r.ok)throw Error(j.error||"Unable to open customer");location.assign(j.url||"/admin.html");}catch(err){alert(err.message);b.disabled=false;}});
document.addEventListener("focusout",()=>{if(mobileRefreshPending)scheduleMobileRefresh();},true);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&authenticated)scheduleMobileRefresh();});
window.addEventListener("pageshow",()=>{if(authenticated)scheduleMobileRefresh();});
window.addEventListener("pagehide",()=>{stream?.close();stream=null;});
setInterval(()=>{if(authenticated&&!document.hidden)scheduleMobileRefresh();},60000);
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js",{scope:"/"}).catch(()=>{});
void refresh(true);
})();