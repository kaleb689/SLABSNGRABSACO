(() => {
const $=id=>document.getElementById(id),esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let tab="overview",data={customers:[],registered:[],activation:null,availability:null,usage:null,success:{records:[]}},authenticated=false,stream=null;
let successDays=30,successCustomerId="all",successAccountKey="all";
let successCustomRange=null,successCalendarOpen=false,successCalendarError="";
let successCalendarDraft={from:"",to:""};
const successUserCustomRanges=new Map(),successUserCalendarOpen=new Set(),successUserCalendarDraft=new Map(),successUserCalendarErrors=new Map();
function mobileDayKey(date) {
  return [date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),String(date.getDate()).padStart(2,"0")].join("-");
}
function mobileDefaultDates() {
  const now=new Date(),from=new Date(now.getFullYear(),now.getMonth(),now.getDate()-29);
  return {from:mobileDayKey(from),to:mobileDayKey(now)};
}
function mobileCustomWindow(range,now=new Date()) {
  const parseDay=value=>{
    if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
    const [y,m,d]=value.split("-").map(Number);
    const at=new Date(y,m-1,d);
    return at.getFullYear()===y&&at.getMonth()===m-1&&at.getDate()===d?at:null;
  };
  const start=parseDay(range?.from),last=parseDay(range?.to);
  if(!start||!last||start>last||range.to>mobileDayKey(now))return null;
  return {start:start.getTime(),end:Math.min(new Date(last.getFullYear(),last.getMonth(),last.getDate()+1).getTime(),now.getTime()+60000)};
}
function mobilePeriodWindow(period,range,now=new Date()) {
  if(period==="custom")return mobileCustomWindow(range,now)||{start:Infinity,end:-Infinity};
  return {start:successPeriodStart(period,now),end:now.getTime()+60000};
}
function mobileCustomLabel(range) {
  if(!range)return "Custom dates";
  const format=value=>new Date(value+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
  return format(range.from)+" – "+format(range.to);
}
const mobileCalendarIcon='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/></svg>';
function mobileCalendarMarkup(scope,id,range,draft,open,error) {
  const today=mobileDayKey(new Date());
  const parent=scope==="user"?' data-success-user-date-form="'+esc(id)+'"':' data-success-date-form';
  const from=draft?.from||range?.from||mobileDefaultDates().from;
  const to=draft?.to||range?.to||mobileDefaultDates().to;
  return open?'<form class="sng-custom-calendar"'+parent+'>'+
    '<div class="sng-date-fields"><label>From<input name="from" type="date" value="'+esc(from)+'" max="'+today+'" required></label>'+
    '<label>To<input name="to" type="date" value="'+esc(to)+'" max="'+today+'" required></label></div>'+
    (error?'<p class="sng-calendar-error" role="alert">'+esc(error)+'</p>':"")+
    '<div class="sng-date-actions"><button type="submit">Apply range</button>'+
    (scope==="user"?'<button type="button" data-success-user-cancel="'+esc(id)+'">Cancel</button>':'<button type="button" data-success-date-cancel>Cancel</button>')+
    '</div></form>':"";
}
const successExpandedUsers=new Set();
const successUserDays=new Map();
const successOpenPanels=new Set();
const successOpenCustomerCards=new Set();
const successOpenOrderCards=new Set();
function successPeriodStart(period,now=new Date()){
  if(period==="all")return 0;
  if(period==="mtd")return new Date(now.getFullYear(),now.getMonth(),1,0,0,0,0).getTime();
  if(period==="ytd")return new Date(now.getFullYear(),0,1,0,0,0,0).getTime();
  const days=Number(period);
  return Number.isFinite(days)&&days>0?now.getTime()-days*86400000:now.getTime()-30*86400000;
}
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
function customerName(x){const p=x.profile||{};return [p.firstName,p.lastName].filter(Boolean).join(" ")||p.profileName||p.email||"Customer";}
function customerTier(person) {
  const plan=person?.plan || person?.membership || {};
  const raw=String(plan.name || person?.planName || person?.membershipName || '').trim();
  const assigned=Number(plan.profiles ?? plan.profileCount ?? plan.accounts ?? person?.paidProfileCount ?? person?.profileAllowance ?? 0);
  const named=/(^|[^0-9])(10|20|50)(?![0-9])/.exec(raw);
  const planTier=Number(plan.tier ?? person?.tier ?? 0);
  const allowedByTier=({5:10,6:20,7:50})[planTier] || 0;
  const count=assigned > 0 ? assigned : Number(named?.[2]) || allowedByTier;
  const unpaid=person?.accountOnly===true;
  const label=unpaid ? 'No paid membership' : (raw || (count ? count + ' profiles' : 'Membership'));
  const expires=plan.currentPeriodEnd || plan.subscriptionEndDate || plan.periodEnd || person?.currentPeriodEnd || person?.subscriptionEndDate || person?.periodEnd || null;
  const endTimestamp=expires ? Date.parse(expires) : NaN;
  const daysRemaining=Number.isFinite(endTimestamp) ? Math.max(0,Math.ceil((endTimestamp-Date.now()) / 86400000)) : null;
  const status=unpaid ? 'Awaiting membership' : String(plan.status || person?.membershipStatus || '');
  return {
    color:unpaid ? 'free' : ([10,20,50].includes(count) ? 'tier-' + count : 'standard'),
    label, count:unpaid ? 0 : count, status, daysRemaining
  };
}
function customers(){
  // Newly registered accounts live in free-submissions until a membership
  // checkout succeeds. Paid submissions alone hide those new signups.
  const paid=Array.isArray(data.customers)?data.customers:
    Array.isArray(data.customers?.submissions)?data.customers.submissions:[];
  const registered=Array.isArray(data.registered)?data.registered:[];
  const people=new Map();
  const key=row=>{
    const id=String(row.customerAccountId||row.id||"").trim();
    const email=String(row.profile?.email||row.email||"").trim().toLowerCase();
    return id?"id:"+id:email?"email:"+email:null;
  };
  // Paid memberships win if older/free snapshots overlap. The free route
  // already excludes paid customers; dedup also prevents duplicate UI cards.
  [...registered,...paid].forEach(row=>{
    if(!row||typeof row!=="object")return;
    const id=key(row);if(!id)return;
    people.set(id,row);
  });
  return [...people.values()].sort((a,b)=>
    (Date.parse(b.accountCreatedAt||b.createdAt||b.paidAt||0)||0)-
    (Date.parse(a.accountCreatedAt||a.createdAt||a.paidAt||0)||0));
}
function activationCount(a,status){if(!Array.isArray(a?.customers))return "—";const profiles=a.customers.flatMap(c=>Array.isArray(c.profiles)?c.profiles:[]).filter(p=>p.type==="paid");return profiles.filter(p=>p.status===status).length;}
function render(){
$("heading").textContent=({overview:"Overview",success:"Success",customers:"Customers",profiles:"Profiles",usage:"App Usage",more:"More"})[tab];
document.querySelectorAll("[data-tab]").forEach(b=>b.classList.toggle("active",b.dataset.tab===(tab==="usage"?"more":tab)));
const list=customers(),freeCount=list.filter(person=>person.accountOnly===true).length,
  paidCount=list.length-freeCount,
  a=data.activation||{},v=data.availability||{},u=data.usage||{},c=$("content");
if(tab==="overview"){
  // Keep the existing all-time community totals (including the historical
  // archive) distinct from customer-specific verified receipt spending.
  const community=data.success?.communityTotals||{};
  const dollars=n=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(n)||0);
  const allTimeSpent=community.totalSpent==null?"—":dollars(community.totalSpent);
  const allTimeOrders=community.totalCheckouts??"—";
  const recent=Array.isArray(data.success?.communityRecords)
    ? [...data.success.communityRecords].sort((a,b)=>(Date.parse(b.checkoutAt)||0)-(Date.parse(a.checkoutAt)||0)).slice(0,5)
    : [];
  const recentSignups=list.filter(x=>x.accountOnly===true)
    .sort((a,b)=>(Date.parse(b.accountCreatedAt||b.createdAt)||0)-(Date.parse(a.accountCreatedAt||a.createdAt)||0))
    .slice(0,5);
  const recentSignupRows=recentSignups.map(person=>
    '<article class="item admin-new-signup"><strong>'+esc(customerName(person))+'</strong>'+
    '<small>'+esc(person.profile?.email||"")+' · Registered · No paid membership</small>'+
    '<button type="button" data-view="'+esc(person.customerAccountId||person.id)+'">VIEW CUSTOMER PAGE ↗</button></article>'
  ).join("")||'<p>New accounts without a membership will appear here.</p>';
  const recentRows=recent.map(order=>{
    const items=Array.isArray(order.items)?order.items:[];
    const first=items[0]||{};
    const name=String(first.name||order.productName||"Confirmed checkout");
    const more=items.length>1?" + "+(items.length-1)+" more product"+(items.length===2?"":"s"):"";
    const qty=items.reduce((sum,item)=>sum+Math.max(0,Math.floor(Number(item.quantity)||0)),0);
    const when=Date.parse(order.checkoutAt);
    const date=Number.isFinite(when)?new Date(when).toLocaleDateString("en-US",{month:"short",day:"numeric"}):"Date pending";
    return '<article class="item admin-recent-checkout"><strong>'+esc(name+more)+'</strong>'+
      '<small>'+esc(order.retailer||"Retailer")+' · '+esc(date)+' · '+qty+' item'+(qty===1?"":"s")+'</small></article>';
  }).join("")||'<p>Recent itemized orders will appear as their confirmed webhook records arrive.</p>';
  c.innerHTML=
    '<section class="admin-overview-hero" aria-label="All-time community checkout overview">'+
      '<span class="admin-overview-hero-label">ALL-TIME COMMUNITY CHECKOUT VALUE</span>'+
      '<strong>'+esc(allTimeSpent)+'</strong>'+
      '<p>Reported total · includes historical checkout records</p>'+
      '<div class="admin-overview-hero-stats">'+
        '<span><small>CONFIRMED CHECKOUTS</small><b>'+esc(allTimeOrders)+'</b></span>'+
        '<span><small>CUSTOMERS</small><b>'+list.length+'</b></span>'+
      '</div></section>'+
    '<div class="metrics admin-overview-grid">'+
      metric("Registered customers",list.length)+
      metric("Paid customers",paidCount)+
      metric("New signups · no plan",freeCount)+
      metric("Awaiting activation",activationCount(a,"awaiting_activation"))+
      metric("App users · 7 days",u.activeUsers7d??"—")+
      metric("Installed devices",u.installedDevices??"—")+'</div>'+
    panel("Latest website signups",recentSignupRows)+
    panel("Recent confirmed checkouts",recentRows+
      '<a href="/admin-success.html" class="action">VIEW ALL CHECKOUTS ↗</a>')+
    panel("Quick actions",'<div class="links">'+
      '<a class="action" href="/admin-success.html">CHECKOUT SPENDING & INSIGHTS ↗</a>'+
      '<a class="action" href="/admin.html">OPEN FULL ADMIN DASHBOARD ↗</a>'+
      '<a class="action" href="/admin.html#profileActivationTracker">PROFILE ACTIVATION TOOLS ↗</a></div>')+
    panel("Live updates","<p>Checkout data and customer changes refresh automatically. Customer and account totals are shown separately to prevent unassigned orders from being attributed to the wrong person.</p>");
}
if(tab==="success"){
  // Community totals include unmatched confirmed checkouts. Attribution is
  // required ONLY for individual customer and profile performance views.
  const allSuccess=Array.isArray(data.success?.records)?data.success.records.filter(x=>Boolean(x.customerAccountId)):[];
  // The global Admin Success tracker reports ALL confirmed webhooks, including
  // those whose customer cannot be identified yet. Per-customer reporting
  // intentionally continues to use only uniquely attributed records.
  const allCommunity=Array.isArray(data.success?.communityRecords)
    ? data.success.communityRecords : allSuccess;
  const now=new Date(), currentTime=Date.now(), day=86400000;
  const days=successDays;
  const {start:cutoff,end:periodEnd}=mobilePeriodWindow(days,successCustomRange,now);
  const inRange=allCommunity.filter(x=>{
    const time=Date.parse(x.checkoutAt);
    return Number.isFinite(time)&&time>=cutoff&&time<periodEnd;
  });
  const dollars=n=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(n)||0);
  const amount=x=>x?.orderTotalKnown&&Number(x.orderTotal)>0?Number(x.orderTotal):0;
  const verifiedSpent=rows=>rows.reduce((cents,x)=>cents+Math.round(amount(x)*100),0)/100;
  const missingPrices=rows=>rows.filter(x=>!x.orderTotalKnown).length;
  const safeImage=url=>typeof url==="string"&&/^https:\/\/[^ "'<>]+$/i.test(url);
  const customerList=new Map();
  allSuccess.filter(x=>x.customerAccountId).forEach(x=>{
    customerList.set(String(x.customerAccountId),String(x.customerName||"Customer"));
  });
  const customers=Array.from(customerList.entries()).sort((a,b)=>a[1].localeCompare(b[1]));
  if(!["all","linked","unmatched"].includes(successCustomerId)&&!customerList.has(successCustomerId))successCustomerId="all";
  const customerSelect='<label class="success-filter-label">VIEW CHECKOUTS FOR<select class="success-filter-select" id="success-customer-filter">'+
    '<option value="all" '+(successCustomerId==="all"?'selected':'')+'>All confirmed checkouts · linked & unmatched</option>'+
    '<option value="linked" '+(successCustomerId==="linked"?'selected':'')+'>All linked customer checkouts</option>'+
    '<option value="unmatched" '+(successCustomerId==="unmatched"?'selected':'')+'>Unmatched confirmed checkouts</option>'+
    customers.map(([id,name])=>'<option value="'+esc(id)+'" '+(successCustomerId===id?'selected':'')+'>'+esc(name)+'</option>').join("")+
    '</select></label>';
  let accountSelect="";
  const scopedRows=["all","linked","unmatched"].includes(successCustomerId) ? inRange :
    allSuccess.filter(x=>{const at=Date.parse(x.checkoutAt);return Number.isFinite(at)&&at>=cutoff&&at<periodEnd;});
  let filtered=scopedRows.filter(x=>successCustomerId==="all" ? true :
    successCustomerId==="linked" ? Boolean(x.linked ?? x.customerAccountId) :
    successCustomerId==="unmatched" ? !Boolean(x.linked ?? x.customerAccountId) :
    String(x.customerAccountId)===successCustomerId);
  if(!["all","linked","unmatched"].includes(successCustomerId)){
    const accountOptions=new Map();
    allSuccess.filter(x=>String(x.customerAccountId)===successCustomerId).forEach(x=>{
      accountOptions.set(String(x.accountKey||"unknown"),String(x.accountLabel||"Unspecified profile")+" · "+String(x.retailer||"Retailer"));
    });
    if(!accountOptions.has(successAccountKey))successAccountKey="all";
    accountSelect='<label class="success-filter-label">ACCOUNT / PROFILE<select class="success-filter-select" id="success-account-filter">'+
      '<option value="all">All of this customer&#39;s accounts</option>'+
      Array.from(accountOptions.entries()).map(([key,name])=>'<option value="'+esc(key)+'" '+(successAccountKey===key?'selected':'')+'>'+esc(name)+'</option>').join("")+
      '</select></label>';
    if(successAccountKey!=="all")filtered=filtered.filter(x=>String(x.accountKey||"unknown")===successAccountKey);
  }else successAccountKey="all";
  const groupedRetailers=new Map();
  filtered.forEach(x=>{const key=String(x.retailer||"Other");groupedRetailers.set(key,(groupedRetailers.get(key)||0)+1);});
  const total=filtered.length,spent=verifiedSpent(filtered),pending=missingPrices(filtered);
  const shownSpend=dollars(spent);
  const rangeNames={1:"LAST 24 HOURS",7:"LAST 7 DAYS",30:"LAST 30 DAYS",90:"LAST 90 DAYS",ytd:"YEAR TO DATE",all:"ALL TIME",custom:mobileCustomLabel(successCustomRange).toUpperCase()};
  const ranges=[[1,"24H"],[7,"7D"],[30,"30D"],[90,"90D"],["ytd","YTD"],["all","ALL"]];
  const buttons='<div class="admin-spend-ranges" role="group" aria-label="Total spent period">'+
    ranges.map(([value,label])=>'<button type="button" data-success-days="'+value+'" aria-pressed="'+(String(value)===String(days))+'">'+label+'</button>').join("")+
    '<button type="button" data-success-calendar aria-label="Choose custom date range" aria-expanded="'+successCalendarOpen+'" aria-pressed="'+(days==="custom")+'" class="sng-calendar-button">'+
    mobileCalendarIcon+' Custom</button></div>'+
    mobileCalendarMarkup("global","",successCustomRange,successCalendarDraft,successCalendarOpen,successCalendarError);
  const note=!total?'No confirmed checkouts in this period.':pending?pending+' of '+total+' confirmed checkouts without verified paid amounts.':'All displayed checkout amounts are verified.';
  const ticks=days===1?8:days===7?7:12;
  const min=cutoff||Math.min(currentTime,...filtered.map(x=>Date.parse(x.checkoutAt)).filter(Number.isFinite));
  const span=Math.max(1,periodEnd-min),buckets=Array(ticks).fill(0);
  filtered.forEach(x=>{const time=Date.parse(x.checkoutAt);if(Number.isFinite(time)){const pos=Math.min(ticks-1,Math.max(0,Math.floor((time-min)/span*ticks)));buckets[pos]+=amount(x);}});
  const max=Math.max(1,...buckets);
  const line=buckets.map((v,i)=>(i?"L":"M")+(16+i*(288/(ticks-1))).toFixed(1)+" "+(76-v/max*56).toFixed(1)).join(" ");
  const trend='<svg class="admin-spend-trend" viewBox="0 0 320 100" preserveAspectRatio="none" role="img" aria-label="Verified spending trend for selected period"><path d="'+line+'" fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const scopeLabel=successCustomerId==="all"?"ALL CONFIRMED ORDERS":
    successCustomerId==="linked"?"LINKED CUSTOMER ORDERS":
    successCustomerId==="unmatched"?"UNMATCHED CONFIRMED ORDERS":"SELECTED CUSTOMER";
  const hero='<section class="admin-spend-hero"><span class="admin-spend-kicker">TOTAL VERIFIED SPENT · '+rangeNames[days]+' · '+scopeLabel+'</span><strong>'+shownSpend+'</strong><p>'+total+' confirmed order'+(total===1?'':'s')+' · '+groupedRetailers.size+' retailers · '+esc(note)+'</p>'+trend+'</section>';
  function productsMarkup(rows,limit=30) {
    const goods=new Map();
    rows.forEach(order=>(order.items||[]).forEach(item=>{
      const name=String(item.name||"Product");
      const retailer=String(order.retailer||"Retailer");
      const key=retailer.toLowerCase()+"|"+name.toLowerCase();
      const entry=goods.get(key)||{name,retailer,quantity:0,imageUrl:item.imageUrl||""};
      entry.quantity+=Math.max(0,Math.floor(Number(item.quantity)||0));
      if(!entry.imageUrl)entry.imageUrl=item.imageUrl||"";
      goods.set(key,entry);
    }));
    const products=Array.from(goods.values()).sort((a,b)=>b.quantity-a.quantity||a.name.localeCompare(b.name));
    const visible=products.slice(0,limit);
    if(!visible.length)return '<p class="success-empty">No products from linked customer checkouts in this period.</p>';
    return '<div class="success-products-list">'+visible.map(x=>
      '<div class="success-product-row">'+
      '<img alt="" loading="lazy" src="'+esc(safeImage(x.imageUrl)?x.imageUrl:"/slabsngrabs-aco-logo-transparent.png")+'">'+
      '<div class="success-product-copy"><strong>'+esc(x.name)+'</strong><small>'+esc(x.retailer)+'</small></div>'+
      '<span class="success-product-quantity">×'+x.quantity+'</span></div>').join("")+'</div>'+
      (products.length>visible.length?'<p class="success-overflow">+'+(products.length-visible.length)+' more products in this period</p>':'');
  }

  // Each confirmed checkout is a single order. Keep its line items together
  // rather than flattening bundled products into one misleading purchase list.
  // Do not group by close timestamps or similar SKUs: distinct orders can
  // arrive in the same minute and must remain separate.
  function ordersMarkup(rows,limit=60) {
    const orders=[...rows].sort((a,b)=>(Date.parse(b.checkoutAt)||0)-(Date.parse(a.checkoutAt)||0));
    if(!orders.length)return '<p class="success-empty">No customer-linked orders in this period.</p>';
    return '<div class="success-order-list">'+orders.slice(0,limit).map((order,index)=>{
      const date=Date.parse(order.checkoutAt);
      const stamp=Number.isFinite(date)?new Date(date).toLocaleString():"Date unavailable";
      const products=Array.isArray(order.items)?order.items:[];
      const count=products.reduce((sum,item)=>sum+Math.max(0,Math.floor(Number(item.quantity)||0)),0);
      const key=String(order.id||order.orderId||[order.checkoutAt,order.retailer,order.accountKey,index].join("|"));
      const known=order.orderTotalKnown===true&&Number(order.orderTotal)>0;
      const paid=known?dollars(order.orderTotal):"$0.00";
      const details=products.map(item=>{
        const qty=Math.max(0,Math.floor(Number(item.quantity)||0));
        const image=safeImage(item.imageUrl)?item.imageUrl:"/slabsngrabs-aco-logo-transparent.png";
        return '<div class="success-order-item"><img src="'+esc(image)+'" loading="lazy" alt="">'+
          '<strong>'+esc(item.name||"Product")+'</strong><span class="success-qty">×'+qty+'</span></div>';
      }).join("")||'<p class="success-empty">Product details unavailable for this order.</p>';
      return '<details class="success-order-card" data-success-order="'+esc(key)+'" '+
        (successOpenOrderCards.has(key)?'open':'')+'><summary>'+
        '<span class="success-order-title"><strong>Order '+(index+1)+' · '+esc(order.retailer||"Retailer")+'</strong>'+
        '<small>'+esc(stamp)+' · '+esc(order.accountLabel||"Assigned account")+' · '+count+' item'+(count===1?'':'s')+'</small></span>'+
        '<span class="success-order-total">'+paid+'<small class="'+(known?'':'success-order-warning')+'">'+
        (known?'Final charged total':'Amount awaiting receipt verification')+'</small></span>'+
        '</summary><div class="success-order-items">'+details+'</div></details>';
    }).join("")+'</div>'+
    (orders.length>limit?'<p class="success-overflow">+'+(orders.length-limit)+' more confirmed orders in this period</p>':'');
  }
  function accountsMarkup(rows) {
    const accounts=new Map();
    rows.forEach(x=>{
      const key=String(x.accountKey||"unknown");
      if(!accounts.has(key))accounts.set(key,{name:String(x.accountLabel||"Unspecified profile"),retailer:String(x.retailer||"Retailer"),
        kind:String(x.accountKind||"unclassified"),orders:[]});
      accounts.get(key).orders.push(x);
    });
    const entries=Array.from(accounts.values()).sort((a,b)=>b.orders.length-a.orders.length);
    if(!entries.length)return '<p class="success-empty">No linked account checkouts in this period.</p>';
    return '<div class="success-account-list">'+entries.map(x=>{
      const tally=new Map();
      x.orders.forEach(order=>(order.items||[]).forEach(item=>{
        const name=String(item.name||"Product");
        tally.set(name,(tally.get(name)||0)+Math.max(0,Number(item.quantity)||0));
      }));
      const productSummary=[...tally.entries()].slice(0,5).map(([name,qty])=>
        esc(name)+' ×'+Math.floor(qty)).join(' · ');
      return '<div class="success-account-row">'+
        '<div class="success-account-title"><strong>'+esc(x.name)+'</strong><span>'+esc(x.retailer)+'</span></div>'+
        '<div class="success-account-meta"><span>'+esc(x.kind==='linked'?"Linked account":x.kind==='paid'?"Paid customer profile":"Verified assigned profile")+'</span>'+
        '<span>'+x.orders.length+' order'+(x.orders.length===1?'':'s')+'</span>'+
        '<span>'+esc(dollars(verifiedSpent(x.orders)))+'</span></div>'+
        (productSummary?'<p class="success-account-products">'+productSummary+'</p>':'')+
        '</div>';
    }).join("")+'</div>';
  }
  const palette=["#32d9f9","#a48dff","#ffcf68","#5be1a4","#fe8bae","#ff9b66"];
  const pie=Array.from(groupedRetailers.entries()).sort((a,b)=>b[1]-a[1]);
  let offset=0;
  const segments=pie.map(([,count],i)=>{const start=offset;offset+=total?count/total*100:0;return palette[i%palette.length]+" "+start+"% "+offset+"%";});
  const donut='<div style="width:165px;height:165px;border-radius:50%;margin:16px auto;display:grid;place-items:center;background:conic-gradient('+(segments.join(",")||"#264458 0% 100%")+')"><div style="background:#071826;border-radius:50%;width:113px;height:113px;display:grid;place-items:center;font-size:25px;font-weight:900">'+total+'<small style="display:block;font-size:10px;color:#a2bed0">ORDERS</small></div></div>';
  const legend=pie.map(([name,count],i)=>'<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid #22445a"><span><i style="display:inline-block;background:'+palette[i%palette.length]+';width:10px;height:10px;border-radius:50%;margin-right:9px"></i>'+esc(name)+'</span><strong>'+count+' · '+(total?(100*count/total).toFixed(1):"0")+'%</strong></div>').join("");
  const community=data.success?.communityTotals||{};
  const archive=data.success?.historicalSummary||{};
  const combinedNote='Includes '+(archive.historicalCheckouts||0)+' previously reported historical checkouts ('+dollars(archive.historicalSpent||0)+
    '); their individual receipts and dates are unavailable. '+
    'Historical receipts cannot be assigned to a customer or period. Only verified final charged amounts count as live spending.';
  const lifetime=panel("Lifetime community checkouts",'<div class="metrics">'+metric("Total confirmed checkouts",community.totalCheckouts??allSuccess.length)+
    metric("Reported total checkout spend",dollars(community.totalSpent||0))+'</div><p>'+esc(combinedNote)+'</p>');
  // A separate, audited Admin-only receipt workflow can fill genuinely
  // missing final prices without creating orders or guessing their owners.
  const priceReview=pending||Number(community.pricePendingCheckouts||0)>0
    ?'<section class="panel success-price-action"><h2>Verify missing checkout prices</h2>'+
     '<p>Confirmed checkouts without a final charged amount cannot increase verified spend. Check real retailer receipts to update totals.</p>'+
     '<a href="/admin-checkout-prices.html">REVIEW UNVERIFIED TOTALS ↗</a></section>':"";
  const unmatchedMeta=data.success?.unmatchedRecent||{};
  const unmatchedByRetailer=Array.isArray(unmatchedMeta.byRetailer)?unmatchedMeta.byRetailer:[];
  const missingPkC=unmatchedByRetailer
    .find(x=>/^(PKC|Pokemon Center)$/i.test(String(x.retailer||"")));
  const missingTarget=unmatchedByRetailer
    .find(x=>/^Target$/i.test(String(x.retailer||"")));
  const unmatchedPanel=Number(unmatchedMeta.total||0)>0
    ? '<section class="panel success-matching-panel"><div class="success-matching-head">'+
      '<div><span class="success-eyebrow">ACCOUNT MATCHING</span><h2>Unassigned confirmed checkouts</h2></div>'+
      '<span class="success-matching-count">'+Number(unmatchedMeta.total||0)+' unmatched</span></div>'+
      '<p>These confirmed orders count in community totals but cannot be credited to a customer until the retailer account is verified.</p>'+
      '<div class="success-matching-stats"><span><strong>'+Number(unmatchedMeta.last24h||0)+'</strong> 24H</span>'+
      '<span><strong>'+Number(unmatchedMeta.last7d||0)+'</strong> 7D</span>'+
      '<span><strong>'+Number(unmatchedMeta.last30d||0)+'</strong> 30D</span></div>'+
      (missingPkC?'<p class="success-pkc-note"><strong>Pokémon Center:</strong> '+Number(missingPkC.total||0)+
        ' unassigned confirmed checkout'+(Number(missingPkC.total||0)===1?'':'s')+
        ' · '+Number(missingPkC.last24h||0)+' in 24H · '+Number(missingPkC.last7d||0)+' in 7D</p>':'')+
      (missingTarget?'<p class="success-target-note"><strong>Target:</strong> '+Number(missingTarget.total||0)+
        ' unassigned confirmed checkout'+(Number(missingTarget.total||0)===1?'':'s')+
        ' · '+Number(missingTarget.last24h||0)+' in 24H · '+Number(missingTarget.last7d||0)+' in 7D</p>':'')+
      '<a class="success-match-link" href="/admin-checkout-match.html?retailer=PKC">REVIEW POKÉMON CENTER HITS ↗</a>'+
      (missingTarget?'<a class="success-match-link success-match-secondary" href="/admin-checkout-match.html?retailer=Target">REVIEW TARGET HITS ↗</a>':'')+
      '<a class="success-match-link success-match-secondary" href="/admin-checkout-match.html">REVIEW ALL UNMATCHED HITS ↗</a></section>'
    : "";
  const people=new Map();
  // Individual customer breakdowns use their OWN 24H / 7D / 30D filter, not
  // the global graph period. A 24H overview must not hide an older PKC hit.
  allSuccess.forEach(x=>{
    const id=String(x.customerAccountId);
    if(!people.has(id))people.set(id,{id,name:String(x.customerName||"Customer"),orders:[]});
    people.get(id).orders.push(x);
  });
  const displayedPeople=Array.from(people.values()).filter(x=>["all","linked"].includes(successCustomerId)||x.id===successCustomerId)
    .sort((a,b)=>Math.max(...b.orders.map(o=>Date.parse(o.checkoutAt)||0))-
      Math.max(...a.orders.map(o=>Date.parse(o.checkoutAt)||0))||a.name.localeCompare(b.name));
  const peopleHtml=displayedPeople.map(x=>{
    const userDays=[1,7,30,"custom"].includes(successUserDays.get(x.id))?successUserDays.get(x.id):30;
    const userCustomRange=successUserCustomRanges.get(x.id);
    const {start:userCutoff,end:userPeriodEnd}=mobilePeriodWindow(userDays,userCustomRange,now);
    let userRows=x.orders.filter(order=>{
      const at=Date.parse(order.checkoutAt);
      return Number.isFinite(at)&&at>=userCutoff&&at<userPeriodEnd;
    });
    if(successCustomerId===x.id&&successAccountKey!=="all")
      userRows=userRows.filter(order=>String(order.accountKey||"unknown")===successAccountKey);
    const accountCount=new Set(userRows.map(order=>order.accountKey||"unknown")).size;
    const userPending=missingPrices(userRows);
    const userSpend=dollars(verifiedSpent(userRows));
    const periodButtons='<div class="success-user-period" role="group" aria-label="'+esc(x.name)+' breakdown time range">'+
      [[1,"24H"],[7,"7D"],[30,"30D"]].map(([num,label])=>
        '<button type="button" data-success-user-days="'+num+'" data-success-user-id="'+esc(x.id)+
        '" aria-pressed="'+(num===userDays)+'">'+label+'</button>').join("")+
      '<button type="button" class="sng-calendar-button" data-success-user-calendar="'+esc(x.id)+'" aria-label="Choose custom dates for '+esc(x.name)+'" aria-expanded="'+successUserCalendarOpen.has(x.id)+'" aria-pressed="'+(userDays==="custom")+'">'+mobileCalendarIcon+' Custom</button></div>'+
      mobileCalendarMarkup("user",x.id,userCustomRange,successUserCalendarDraft.get(x.id),successUserCalendarOpen.has(x.id),successUserCalendarErrors.get(x.id));
    return '<details class="panel success-user-panel success-user-accordion" data-success-customer="'+esc(x.id)+'" '+
      (successOpenCustomerCards.has(x.id)||successCustomerId===x.id?'open':'')+'>'+
      '<summary class="success-customer-summary"><span>'+esc(x.name)+' checkout breakdown</span>'+
      '<span class="success-customer-total">'+x.orders.length+' total hit'+(x.orders.length===1?'':'s')+'</span></summary>'+
      '<div class="success-customer-body"><div class="success-user-heading"><div><span class="success-eyebrow">CUSTOMER CHECKOUTS</span>'+
      '<h2>Checkout details</h2></div><span class="success-user-range">'+
      (userDays==="custom"?esc(mobileCustomLabel(userCustomRange)):userDays===1?'24 hours':userDays+' days')+'</span></div>'+periodButtons+
      '<div class="success-user-stats">'+
      '<div><small>Confirmed orders</small><strong>'+userRows.length+'</strong></div>'+
      '<div><small>Verified spent</small><strong>'+userSpend+'</strong></div>'+
      '<div><small>Accounts with hits</small><strong>'+accountCount+'</strong></div></div>'+
      (userPending?'<p class="success-pending">'+userPending+' confirmed order'+(userPending===1?'':'s')+
        ' awaiting a verified paid total.</p>':'')+
      '<details class="success-user-details" data-success-user="'+esc(x.id)+'" '+
        (successExpandedUsers.has(x.id)||successCustomerId===x.id?'open':'')+'>'+
      '<summary>View orders, purchased products & accounts that checked out</summary>'+
      '<div class="success-user-details-body"><h3>Orders & purchased products</h3>'+
        ordersMarkup(userRows)+'<h3>Product totals across orders</h3>'+
        productsMarkup(userRows,18)+'<h3>Which accounts checked out</h3>'+
        accountsMarkup(userRows)+'</div></details></div></details>';
  }).join("")||panel("Customer checkouts",'<p>No confirmed customer-linked checkouts are available yet. Review the unmatched retailer profiles below.</p>');
  const scanAt=Date.parse(data.success?.sourceCheckedAt||"");
  const scanStatus=Number.isFinite(scanAt)?'<p class="success-scan-status">Webhook source last scanned '+
    esc(new Date(scanAt).toLocaleString())+'</p>':"";
  const productsDrop='<details class="success-overview-accordion" data-success-panel="products" '+
    (successOpenPanels.has("products")?'open':'')+'><summary><span>Products purchased</span>'+
    '<span class="success-accordion-count">'+total+' orders</span></summary>'+
    '<div class="success-overview-accordion-body">'+productsMarkup(filtered)+'</div></details>';
  const customersDrop='<details class="success-overview-accordion" data-success-panel="customers" '+
    (successOpenPanels.has("customers")?'open':'')+
    '><summary><span>Customer breakdowns</span><span class="success-accordion-count">'+
    displayedPeople.length+' users</span></summary><div class="success-overview-accordion-body">'+
    peopleHtml+'</div></details>';
  c.innerHTML=buttons+customerSelect+accountSelect+hero+
    '<div class="metrics admin-success-metrics">'+metric("Confirmed orders",total)+
      metric("Retailers",groupedRetailers.size)+'</div>'+
    priceReview+unmatchedPanel+lifetime+panel("Orders by retailer",donut+legend)+
    productsDrop+customersDrop+scanStatus;
  c.querySelectorAll("[data-success-days]").forEach(b=>b.addEventListener("click",()=>{
    successDays=/^(ytd|all)$/.test(b.dataset.successDays)?b.dataset.successDays:Number(b.dataset.successDays);
    successCalendarOpen=false;successCalendarError="";
    render();
  }));
  c.querySelectorAll("[data-success-user-days]").forEach(b=>b.addEventListener("click",()=>{
    successUserDays.set(b.dataset.successUserId,Number(b.dataset.successUserDays));
    successUserCalendarOpen.delete(b.dataset.successUserId);
    successUserCalendarErrors.delete(b.dataset.successUserId);
    render();
  }));
  c.querySelector("[data-success-calendar]")?.addEventListener("click",()=>{
    successCalendarOpen=!successCalendarOpen;successCalendarError="";
    if(successCalendarOpen)successCalendarDraft=successCustomRange?{...successCustomRange}:mobileDefaultDates();
    render();
  });
  c.querySelector("[data-success-date-cancel]")?.addEventListener("click",()=>{
    successCalendarOpen=false;successCalendarError="";render();
  });
  c.querySelector("[data-success-date-form]")?.addEventListener("input",event=>{
    if(event.target.name==="from")successCalendarDraft.from=event.target.value;
    if(event.target.name==="to")successCalendarDraft.to=event.target.value;
  });
  c.querySelectorAll("[data-success-user-date-form]").forEach(form=>form.addEventListener("input",event=>{
    const id=form.dataset.successUserDateForm;
    const draft=successUserCalendarDraft.get(id)||mobileDefaultDates();
    if(event.target.name==="from")draft.from=event.target.value;
    if(event.target.name==="to")draft.to=event.target.value;
    successUserCalendarDraft.set(id,draft);
  }));
  c.querySelector("[data-success-date-form]")?.addEventListener("submit",event=>{
    event.preventDefault();
    const form=event.currentTarget,from=form.querySelector('[name="from"]')?.value||"",to=form.querySelector('[name="to"]')?.value||"";
    successCalendarDraft={from,to};
    if(!mobileCustomWindow(successCalendarDraft)){successCalendarError="Choose a valid From and To date, ending no later than today.";render();return;}
    successCustomRange={...successCalendarDraft};successDays="custom";successCalendarOpen=false;successCalendarError="";render();
  });
  c.querySelectorAll("[data-success-user-calendar]").forEach(button=>button.addEventListener("click",()=>{
    const id=button.dataset.successUserCalendar;
    if(successUserCalendarOpen.has(id))successUserCalendarOpen.delete(id);
    else{successUserCalendarOpen.add(id);successUserCalendarDraft.set(id,successUserCustomRanges.get(id)||mobileDefaultDates());}
    successUserCalendarErrors.delete(id);successOpenPanels.add("customers");successOpenCustomerCards.add(id);render();
  }));
  c.querySelectorAll("[data-success-user-cancel]").forEach(button=>button.addEventListener("click",()=>{
    successUserCalendarOpen.delete(button.dataset.successUserCancel);successUserCalendarErrors.delete(button.dataset.successUserCancel);render();
  }));
  c.querySelectorAll("[data-success-user-date-form]").forEach(form=>form.addEventListener("submit",event=>{
    event.preventDefault();
    const id=form.dataset.successUserDateForm;
    const from=form.querySelector('[name="from"]')?.value||"",to=form.querySelector('[name="to"]')?.value||"";
    const range={from,to};successUserCalendarDraft.set(id,range);
    if(!mobileCustomWindow(range)){successUserCalendarErrors.set(id,"Choose a valid range ending no later than today.");render();return;}
    successUserCustomRanges.set(id,range);successUserDays.set(id,"custom");successUserCalendarOpen.delete(id);successUserCalendarErrors.delete(id);
    successOpenPanels.add("customers");successOpenCustomerCards.add(id);render();
  }));
  c.querySelector("#success-customer-filter")?.addEventListener("change",event=>{
    successCustomerId=event.target.value;successAccountKey="all";
    if(!["all","linked","unmatched"].includes(successCustomerId)) {
      successOpenPanels.add("customers");
      successOpenCustomerCards.add(successCustomerId);
    }
    render();
  });
  c.querySelector("#success-account-filter")?.addEventListener("change",event=>{
    successAccountKey=event.target.value;render();
  });
  c.querySelectorAll("details[data-success-panel]").forEach(el=>
    el.addEventListener("toggle",()=>{
      if(el.open)successOpenPanels.add(el.dataset.successPanel);
      else successOpenPanels.delete(el.dataset.successPanel);
    }));
  c.querySelectorAll("details[data-success-customer]").forEach(el=>
    el.addEventListener("toggle",()=>{
      if(el.open)successOpenCustomerCards.add(el.dataset.successCustomer);
      else successOpenCustomerCards.delete(el.dataset.successCustomer);
    }));
  c.querySelectorAll("details[data-success-user]").forEach(el=>el.addEventListener("toggle",()=>{
    if(el.open)successExpandedUsers.add(el.dataset.successUser);
    else successExpandedUsers.delete(el.dataset.successUser);
  }));
  c.querySelectorAll("details[data-success-order]").forEach(el=>el.addEventListener("toggle",()=>{
    if(el.open)successOpenOrderCards.add(el.dataset.successOrder);
    else successOpenOrderCards.delete(el.dataset.successOrder);
  }));
}
if(tab==="customers"){c.innerHTML='<p class="admin-customer-summary">'+list.length+' registered customer'+(list.length===1?'':'s')+' · '+freeCount+' without a paid membership</p>'+
  '<input class="search" id="customer-search" type="search" placeholder="Search name or email">'+
  '<div id="customer-results"></div>';
  $("customer-search").value=customerSearchText;
  const show=()=>{
    customerSearchText=$("customer-search").value;
    const q=customerSearchText.toLowerCase();
    $("customer-results").innerHTML=list.filter(x=>
      (customerName(x)+" "+(x.profile?.email||"")).toLowerCase().includes(q))
      .slice(0,150).map(x=>{
        const tier=customerTier(x);
        const renewal=tier.daysRemaining==null ? '' : tier.daysRemaining===0 ? 'Period ends today' : tier.daysRemaining+' day'+(tier.daysRemaining===1?'':'s')+' left';
        const status=tier.status && !/^(active|trialing)$/i.test(tier.status) ? tier.status : '';
        const count=tier.count ? tier.count+' ACO PROFILES' : 'NO ACTIVE TIER';
        return '<article class="item admin-customer-tier-row admin-customer-'+tier.color+'">'+
          '<div class="admin-customer-topline"><div class="admin-customer-identity">'+
          '<small class="admin-customer-eyebrow">CUSTOMER ACCOUNT</small>'+
          '<strong>'+esc(customerName(x))+'</strong>'+
          '<small class="admin-customer-email">'+esc(x.profile?.email||"")+'</small>'+
          (status ? '<small class="admin-customer-status">'+esc(status)+'</small>' : '')+'</div>'+
          '<div class="admin-customer-tier-badge"><small>MEMBERSHIP TIER</small>'+
          '<span class="admin-customer-tier-count">'+esc(count)+'</span>'+
          '<strong>'+esc(tier.label)+'</strong>'+
          (renewal ? '<span class="admin-customer-renewal">'+esc(renewal)+'</span>' : '')+'</div></div>'+
          '<button type="button" data-view="'+esc(x.customerAccountId||x.id)+'">VIEW PAGE <span aria-hidden="true">↗</span></button></article>';
      }).join("")||
      "<p>No matching customers.</p>";
  };
  $("customer-search").addEventListener("input",show);show();
}
if(tab==="profiles"){c.innerHTML='<div class="metrics">'+metric("Awaiting activation",activationCount(a,"awaiting_activation"))+metric("Activated",activationCount(a,"activated"))+metric("Expired",activationCount(a,"expired"))+metric("Registered customers",list.length)+'</div>'+panel("Profile workflow",'<p>Open the full tracker to activate, extend, or return profiles using the existing verified controls.</p><a href="/admin.html#profileActivationTracker">OPEN PROFILE WORKFLOW ↗</a>')+panel("Inventory",'<p>Target, Walmart, and Pokémon Center inventory remains managed in the full Admin dashboard.</p><a href="/admin.html">OPEN INVENTORY MANAGER ↗</a>');}
if(tab==="usage"){c.innerHTML='<div class="admin-usage-return"><button type="button" id="admin-more-return" class="action">← BACK TO MORE</button></div>'+'<div class="metrics">'+metric("Installed users",u.installedUsers??"—")+metric("Installed devices",u.installedDevices??"—")+metric("Active users · 7D",u.activeUsers7d??"—")+metric("Active users · 30D",u.activeUsers30d??"—")+'</div>'+panel("Tracking information","<p>Counts begin when updated customer apps report activity. PWA installs are confirmed by app mode or an installation event; they are not App Store downloads.</p>")+panel("Recent activity",(u.recent||[]).slice(0,50).map(x=>'<article class="item"><strong>'+esc(x.name||"Customer")+'</strong><small>'+esc(x.email||"")+' · '+esc(x.platform||"Other")+' · '+(x.installedConfirmed?"Installed":"Web activity")+'</small><small>Last active: '+esc(x.lastSeenAt?new Date(x.lastSeenAt).toLocaleString():"—")+'</small></article>').join("")||"<p>No app activity has been recorded yet.</p>");}
if(tab==="usage"){$("admin-more-return").onclick=()=>{tab="more";render();window.scrollTo(0,0);};}
if(tab==="more"){c.innerHTML=panel("App usage & devices",'<div class="links"><button type="button" class="action" id="open-admin-usage">VIEW APP USAGE ↗</button></div>')+panel("Push notifications",`<div id="push-settings">Loading…</div>`)+panel("Admin tools",'<div class="links"><button class="action" id="register-face-id">SET UP FACE ID ON THIS IPHONE</button><a class="action" href="/admin.html">FULL ADMIN DASHBOARD ↗</a><a class="action" href="/admin.html">DISCOUNTS AND MEMBERSHIPS ↗</a><a class="action" href="/admin.html">DISCORD AND NOTIFICATIONS ↗</a><button class="action" id="signout">SIGN OUT</button></div>');void pushSettings();$("open-admin-usage").onclick=()=>{tab="usage";render();window.scrollTo(0,0);};$("register-face-id").onclick=async()=>{try{await passkeyRegister();}catch(e){alert(e.message);}};$("signout").onclick=async()=>{await fetch("/api/admin/logout",{method:"POST",credentials:"same-origin"}).catch(()=>{});auth(false);};}
}
let successRefreshRunning=false,successRefreshQueued=false;
async function refreshSuccessTracker(){
  if(!authenticated||document.hidden||tab!=="success")return;
  if(successRefreshRunning){successRefreshQueued=true;return;}
  successRefreshRunning=true;
  try{
    const next=await get("/api/admin/success-overview");
    data.success=next;
    // Updating a live chart must not dismiss a customer's active date picker.
    if(mobileControlFocused()){mobileRefreshPending=true;return;}
    if(tab==="success"&&authenticated&&!document.hidden){
      const x=window.scrollX,y=window.scrollY;
      render();
      $("updated").textContent="Live · "+new Date().toLocaleTimeString();
      requestAnimationFrame(()=>window.scrollTo(x,y));
    }
  }catch(e){
    if(e.message==="SESSION_EXPIRED"){auth(false);return;}
  }finally{
    successRefreshRunning=false;
    if(successRefreshQueued){successRefreshQueued=false;void refreshSuccessTracker();}
  }
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
      get("/api/admin/free-submissions"),
      get("/api/admin/profile-activation-tracker"),
      get("/api/managed-availability"),
      get("/api/admin/app-usage"),
      get("/api/admin/success-overview")
    ]);
    const keys=["customers","registered","activation","availability","usage","success"];
    results.forEach((r,i)=>{if(r.status==="fulfilled")data[keys[i]]=r.value;});
    if(results.some(r=>r.status==="rejected"&&r.reason.message==="SESSION_EXPIRED")){
      auth(false);return;
    }
    if(results[0].status==="rejected")throw results[0].reason;
    if(results[1].status==="rejected")data.registered=[];
    if(results[2].status==="rejected")data.activation=null;
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
      // A signup changes the customer roster even while the Success tab is
      // selected. Refresh all dashboard sources, not just checkout totals.
      stream.addEventListener("data-change",scheduleMobileRefresh);
      stream.addEventListener("checkout",scheduleMobileRefresh);
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
$("tabs").addEventListener("click",e=>{const b=e.target.closest("[data-tab]");if(!b)return;tab=b.dataset.tab;render();window.scrollTo(0,0);if(tab==="success")void refreshSuccessTracker();});
$("content").addEventListener("click",async e=>{const b=e.target.closest("[data-view]");if(!b)return;b.disabled=true;try{const r=await fetch("/api/admin/customers/"+encodeURIComponent(b.dataset.view)+"/view-as-user",{method:"POST",credentials:"same-origin"});const j=await r.json();if(!r.ok)throw Error(j.error||"Unable to open customer");location.assign(j.url||"/admin.html");}catch(err){alert(err.message);b.disabled=false;}});
document.addEventListener("focusout",()=>{if(mobileRefreshPending)scheduleMobileRefresh();},true);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&authenticated)scheduleMobileRefresh();});
window.addEventListener("pageshow",()=>{if(authenticated)scheduleMobileRefresh();});
window.addEventListener("pagehide",()=>{stream?.close();stream=null;});
setInterval(()=>{if(authenticated&&!document.hidden)scheduleMobileRefresh();},60000);
setInterval(()=>{if(authenticated&&!document.hidden&&tab==="success")void refreshSuccessTracker();},15000);
if("serviceWorker" in navigator)navigator.serviceWorker.register("/sw.js",{scope:"/"}).catch(()=>{});
void refresh(true);
})();