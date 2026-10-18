/* ACO Studio native Admin. The UI is installed with Electron and uses the
   authenticated website bridge, never an iframe or a second customer database. */
(()=>{'use strict';
const api=window.desktopAPI?.site;
const root=document.getElementById('sitePage');if(!root||!api?.adminRead)return;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=id=>document.getElementById(id);
const arr=v=>Array.isArray(v)?v:[];
const short=(v,n=120)=>String(v??'').slice(0,n);
const amount=v=>'$'+(Number(v)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const centsAmount=v=>amount((Number(v)||0)/100);
const when=v=>{const d=new Date(v||'');return Number.isFinite(d.getTime())?d.toLocaleString():'—';};
const flatten=(v,prefix='',out=[],depth=0)=>{
 if(depth>2||!v||typeof v!=='object')return out;
 for(const [key,value] of Object.entries(v)){
  if(['ok','records','communityRecords','memberships','codes','customers','profiles','items','notification','addresses','paymentMethods','unmatchedRecent','recurringCalculation','calculatedAt'].includes(key))continue;
  const label=(prefix?prefix+' · ':'')+key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ');
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')out.push([label,value]);
  else if(value&&typeof value==='object'&&!Array.isArray(value))flatten(value,label,out,depth+1);
  if(out.length>20)break;
 }
 return out;
};
const readKey=(data,key)=>data?.items?.find(item=>item.key===key);
const dataKey=(data,key)=>readKey(data,key)?.data;
const errKey=(data,key)=>readKey(data,key)?.error;
const sectionInfo=[
 ['home','Home','Revenue, activity and recent checkouts'],
 ['customers','Customers','Customer details, profiles, saved information'],
 ['orders','Orders','Verified checkouts and shipping status'],
 ['memberships','Memberships','Recurring revenue, discounts and gifted plans'],
 ['accounts','Retailer accounts','Available, linked and held inventory'],
 ['operations','Operations','Notifications, success channels and consent records']
];
const bar=document.createElement('nav');bar.className='aco-native-nav';bar.id='acoNativeSections';bar.setAttribute('aria-label','Admin sections');
for(const [id,title] of sectionInfo){const button=document.createElement('button');button.type='button';button.dataset.native=id;button.textContent=title;button.setAttribute('aria-controls','acoNative'+id);button.setAttribute('aria-current','false');bar.append(button);}
const panes=new Map();for(const [id,,desc] of sectionInfo){const section=document.createElement('section');section.id='acoNative'+id;section.className='aco-native-pane';section.hidden=id!=='home';section.innerHTML=id==='customers'?'':`<div class="aco-native-title"><div><div class="eyebrow">ADMIN / ${esc(id.toUpperCase())}</div><h2>${esc(sectionInfo.find(x=>x[0]===id)[1])}</h2><p>${esc(desc)}</p></div><button type="button" class="btn slim secondary" data-refresh="${esc(id)}">↻ Refresh</button></div><div class="aco-native-result" role="status">Connect Admin to load this section.</div>`;panes.set(id,section);}
const legacy=document.createElement('div');legacy.id='acoNativeCustomerWorkspace';legacy.append($('siteRosterView'),$('siteCustomerView'));panes.get('customers').append(legacy);
const anchor=$('siteNotice');anchor.before(bar,...panes.values());
let active='home',filterPeriod='7',ordersSnapshot=null,memberSnapshot=null,operationsSnapshot=null,poolSnapshot=null,dashboardSnapshot=null;
let connected=false,loading=new Set(),refreshTimer=null,editing=false;
const dirtySections=new Set(),pendingSections=new Set(),renderedFingerprints=new Map();
const editable='input,textarea,select,[contenteditable="true"]';
const formSection={acoDiscountForm:'memberships',acoGiftForm:'memberships',acoBroadcastForm:'operations'};
function focusedEditor(section){const focused=document.activeElement;return Boolean(focused&&panes.get(section)?.contains(focused)&&focused.matches?.(editable));}
function markPending(section){
 pendingSections.add(section);
 const pane=panes.get(section);if(!pane)return;
 let hint=pane.querySelector(':scope > .aco-native-live-pending');
 if(!hint){hint=document.createElement('div');hint.className='aco-native-live-pending';hint.setAttribute('role','status');
  hint.textContent='New website changes available — save or finish editing to refresh.';pane.querySelector('.aco-native-title')?.after(hint);}
 hint.hidden=false;
}
function clearPending(section){pendingSections.delete(section);const hint=panes.get(section)?.querySelector(':scope > .aco-native-live-pending');if(hint)hint.hidden=true;}
function deferLive(section){return dirtySections.has(section)||focusedEditor(section)||editing;}

function resultBox(section){return panes.get(section).querySelector('.aco-native-result');}
function itemMap(response){return new Map(arr(response?.items).map(item=>[item?.key,item]).filter(([key])=>key));}
function mergeSnapshot(previous,response){
 if(!previous)return response;
 const old=itemMap(previous),next=itemMap(response),keys=new Set([...old.keys(),...next.keys()]),items=[];
 for(const key of keys){
  const fresh=next.get(key),prior=old.get(key);
  // Live reads are independent requests. A transient failure for one endpoint
  // must never erase a previously verified panel while the other endpoints load.
  const freshEmptyOverview=key==='success-overview'&&fresh?.data&&prior?.data&&
   Number(fresh.data?.communityTotals?.checkouts||0)===0&&Number(fresh.data?.communityTotals?.spent||0)===0&&
   arr(fresh.data?.records).length===0&&
   (Number(prior.data?.communityTotals?.checkouts||0)>0||Number(prior.data?.communityTotals?.spent||0)>0||arr(prior.data?.records).length>0);
  items.push(freshEmptyOverview?prior:(fresh&&fresh.data!=null?fresh:(prior?.data!=null?prior:fresh||prior)));
 }
 return {...previous,...response,items};
}
function sectionStatus(section,message,error=false){const p=resultBox(section);if(!p)return;p.textContent=message;p.classList.toggle('is-error',error);}
function groupData(item,field){return arr(item?.[field]);}
function panel(title,content='',extra=''){return `<section class="aco-native-card"><header><h3>${esc(title)}</h3>${extra}</header>${content}</section>`;}
function empty(text){return `<p class="aco-native-empty">${esc(text)}</p>`;}
function stats(data){return `<div class="aco-native-stats">${flatten(data).filter(([k,v])=>typeof v==='number'||typeof v==='string'&&v.length<70).slice(0,8).map(([key,value])=>{const isCents=/\bcents$/i.test(key.trim()),label=isCents?key.replace(/\s*cents$/i,''):key;const shown=isCents?centsAmount(value):/^currency$/i.test(label)?String(value).toUpperCase():value;return `<div class="aco-native-stat"><small>${esc(label)}</small><b>${esc(shown)}</b></div>`;}).join('')}</div>`;}
async function load(section,silent=false){
 if(!api?.adminRead||loading.has(section))return;
 if(silent&&deferLive(section)){markPending(section);return;}
 if(!silent&&dirtySections.has(section)&&!confirm('Discard unsaved Admin form changes and refresh?'))return;
 if(!silent)dirtySections.delete(section);
 loading.add(section);if(!silent)sectionStatus(section,'Loading current website data…');
 try{
  const view=section==='home'?'dashboard':section==='accounts'?'pool':section;
  const opts=view==='pool'?{status:$('acoPoolStatus')?.value||'all',retailer:$('acoPoolRetailer')?.value||'all',query:$('acoPoolQuery')?.value||'',page:Number($('acoPoolPage')?.dataset.page||1)}:{};
  const response=await api.adminRead(view,opts);
  const fingerprint=JSON.stringify(response.items);
  if(silent&&renderedFingerprints.get(section)===fingerprint){clearPending(section);connected=true;return;}
  // The network may finish after the owner has started typing. Never destroy a live form.
  if(silent&&deferLive(section)){markPending(section);connected=true;return;}
  if(section==='home'){dashboardSnapshot=mergeSnapshot(dashboardSnapshot,response);renderHome(dashboardSnapshot);}
  if(section==='orders'){ordersSnapshot=mergeSnapshot(ordersSnapshot,response);renderOrders(ordersSnapshot);}
  if(section==='memberships'){memberSnapshot=mergeSnapshot(memberSnapshot,response);renderMemberships(memberSnapshot);}
  if(section==='accounts'){poolSnapshot=mergeSnapshot(poolSnapshot,response);renderAccounts(poolSnapshot);}
  if(section==='operations'){operationsSnapshot=mergeSnapshot(operationsSnapshot,response);renderOperations(operationsSnapshot);}
  const rendered={home:dashboardSnapshot,orders:ordersSnapshot,memberships:memberSnapshot,accounts:poolSnapshot,operations:operationsSnapshot}[section]||response;
  renderedFingerprints.set(section,JSON.stringify(rendered?.items||[]));clearPending(section);connected=true;
 }catch(e){
  const prior={home:dashboardSnapshot,orders:ordersSnapshot,memberships:memberSnapshot,accounts:poolSnapshot,operations:operationsSnapshot}[section];
  if(prior?.items?.some(item=>item?.data!=null)){connected=true;markPending(section);}
  else {sectionStatus(section,e.message||'Unable to load Admin.',true);connected=false;}
 }
 finally{loading.delete(section);}
}
function selectTab(id){
 if(!panes.has(id))id='home';active=id;
 for(const [key,node] of panes)node.hidden=key!==id;
 for(const button of bar.querySelectorAll('button'))button.setAttribute('aria-current',String(button.dataset.native===id));
 const headline=root.querySelector('.siteHeadline h1');if(headline)headline.textContent='Admin · '+sectionInfo.find(x=>x[0]===id)[1];
 if(id!=='customers')void load(id,true);
}
bar.addEventListener('click',e=>{const b=e.target.closest('[data-native]');if(b)selectTab(b.dataset.native);});
root.addEventListener('click',e=>{const b=e.target.closest('[data-refresh]');if(b)void load(b.dataset.refresh);});
function renderHome(response){
 const rev=dataKey(response,'membership-revenue'),orders=dataKey(response,'success-overview'),usage=dataKey(response,'app-usage'),notification=dataKey(response,'site-notification');
 const rows=arr(orders?.records).slice(0,8);
 const total=orders?.communityTotals||{};
 resultBox('home').innerHTML=`<div class="aco-native-stats"><div class="aco-native-stat"><small>Confirmed checkouts</small><b>${esc(total.checkouts??rows.length)}</b></div><div class="aco-native-stat"><small>Community spend</small><b>${amount(total.spent)}</b></div><div class="aco-native-stat"><small>Unmatched orders</small><b>${esc(orders?.unmatchedCount??'—')}</b></div><div class="aco-native-stat"><small>Membership billing</small><b>${esc(rev?.monthlyRevenueFormatted||rev?.totalMonthlyRevenueFormatted||rev?.monthlyTotalFormatted||(rev?.monthlyRecurringCents!=null?centsAmount(rev.monthlyRecurringCents):'Open breakdown'))}</b></div></div>
 <div class="aco-native-columns">${panel('Membership revenue',rev?stats(rev):empty(errKey(response,'membership-revenue')||'Revenue unavailable'))}
 ${panel('App usage',usage?stats(usage):empty(errKey(response,'app-usage')||'App usage unavailable'))}</div>
 ${panel('Recent checkouts',rows.length?ordersTable(rows):empty('No attributed orders loaded.'),'<button type="button" class="btn slim plain" data-go="orders">See all →</button>')}
 ${panel('Current website notification',notification?.notification?.active?`<strong>${esc(notification.notification.title)}</strong><p>${esc(notification.notification.message)}</p>`:empty('No active broadcast.'))}`;
}
function orderRows(){
 const all=arr(dataKey(ordersSnapshot,'success-overview')?.records);
 const keyword=String($('acoOrderSearch')?.value||'').trim().toLowerCase();
 const retailer=$('acoOrderRetailer')?.value||'all';
 const within=filterPeriod==='all'?0:Date.now()-Number(filterPeriod)*86400000;
 return all.filter(item=>(retailer==='all'||item.retailer===retailer)&&(!within||Date.parse(item.checkoutAt||'')>=within)&&(!keyword||[item.customerName,item.customerAccountId,item.retailer,...arr(item.items).map(x=>x.name)].join(' ').toLowerCase().includes(keyword)));
}
function ordersTable(items){
 return `<div class="aco-native-table-scroll"><table class="aco-native-table"><thead><tr><th>Checkout date</th><th>Customer · Profile</th><th>Retailer</th><th>Products in checkout</th><th>Total charged</th></tr></thead><tbody>${items.map(r=>`<tr><td>${esc(when(r.checkoutAt))}</td><td><strong>${esc(r.customerName||'Unmatched')}</strong><small>${esc(r.profileName||r.accountLabel||r.customerProfileName||'')}</small></td><td>${esc(r.retailer||'—')}</td><td>${arr(r.items).map(x=>`${esc(short(x.name,90))} ×${Number(x.quantity)||0}`).join('<span class="aco-native-sep"> · </span>')||'—'}</td><td>${r.orderTotalKnown===true?amount(r.orderTotal):amount(r.orderTotal)}${r.orderTotalKnown===false?'<small>Not yet verified</small>':''}</td></tr>`).join('')}</tbody></table></div>`;
}
function drawOrderList(){const box=$('acoOrderList');if(!box)return;const rows=orderRows();$('acoOrderCount').textContent=rows.length+' checkouts';box.innerHTML=rows.length?ordersTable(rows):empty('No verified checkouts match these filters.');}
function renderOrders(response){
 const savedFilters={period:$('acoOrderPeriod')?.value||filterPeriod,retailer:$('acoOrderRetailer')?.value||'all',query:$('acoOrderSearch')?.value||''};
 const overview=dataKey(response,'success-overview'),verify=dataKey(response,'checkout-paid-verification');
 if(!overview){sectionStatus('orders',errKey(response,'success-overview')||'Unable to load checkouts.',true);return;}
 resultBox('orders').innerHTML=`<div class="aco-native-stats"><div class="aco-native-stat"><small>Confirmed community checkouts</small><b>${esc(overview.communityTotals?.checkouts??0)}</b></div><div class="aco-native-stat"><small>Community spend</small><b>${amount(overview.communityTotals?.spent)}</b></div><div class="aco-native-stat"><small>Unmatched checkouts</small><b>${esc(overview.unmatchedCount??0)}</b></div></div>
 <div class="aco-native-filters"><label>Period<select id="acoOrderPeriod"><option value="1">24 hours</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="all">All time</option></select></label><label>Retailer<select id="acoOrderRetailer"><option value="all">All retailers</option><option value="target">Target</option><option value="walmart">Walmart</option><option value="pokemoncenter">Pokémon Center</option></select></label><label>Search<input type="search" id="acoOrderSearch" placeholder="Customer or product" autocomplete="off"></label><span id="acoOrderCount"></span></div>
 ${panel('Attributed checkouts',`<div id="acoOrderList"></div><p class="siteMuted">Order totals follow the website’s verified Discord checkout records. Unknown charges are not invented.</p>`)}
 ${panel('Price verification',verify?stats(verify):empty(errKey(response,'checkout-paid-verification')||'No verification data.'))}`;
 for(const [id,key] of [['acoOrderPeriod','period'],['acoOrderRetailer','retailer'],['acoOrderSearch','query']]){
  const el=$(id);if(el)el.value=savedFilters[key];
 }
 filterPeriod=savedFilters.period;drawOrderList();
}
function discountLine(d){return `<div class="aco-native-line"><div><strong>${esc(d.code||'Discount')}</strong><small>${esc(d.discountType==='fixed-price'?amount(d.fixedPrice):d.percent+'%')} · ${esc(d.tier==='all'?'All tiers':d.tier+' accounts')} · ${esc(d.recipientEmail|| (d.ogOnly?'OG customers':d.sitewide?'Site-wide':'Selected customers'))}</small><small>${esc(d.duration==='repeating'?'Repeats '+d.durationMonths+' months':d.duration||'')}</small></div><div class="aco-native-actions"><span class="aco-native-state">${d.active?'Active':'Inactive'}</span><button type="button" class="btn slim secondary" data-discount-edit="${esc(d.id)}">Edit</button><button type="button" class="btn slim plain" data-discount-toggle="${esc(d.id)}">${d.active?'Disable':'Enable'}</button><button type="button" class="btn slim plain" data-discount-remove="${esc(d.id)}">Delete</button></div></div>`;}
function renderMemberships(response){
 const liveTiers=arr(dataKey(response,'membership-prices')?.tiers);const tierOptions=(liveTiers.length?liveTiers:[{tier:1,profiles:1},{tier:2,profiles:2},{tier:3,profiles:3},{tier:4,profiles:5},{tier:5,profiles:10},{tier:6,profiles:20},{tier:7,profiles:50},{tier:8,profiles:100}]).map(p=>`<option value="${esc(p.tier)}">${esc(p.profiles)} profiles${p.amount?' · '+esc(amount(p.amount))+'/month':''}</option>`).join('');
 const codes=dataKey(response,'discount-codes'),gifted=dataKey(response,'gifted-memberships'),giftable=dataKey(response,'giftable-customers'),revenue=dataKey(response,'membership-revenue');
 const discounts=arr(codes?.codes),gifts=arr(gifted?.memberships),customers=arr(giftable?.customers);
 const discountFields=`<form id="acoDiscountForm" class="aco-native-form"><input type="hidden" name="id" value=""><label>Coupon code<input name="code" maxlength="40" required placeholder="WELCOME20"></label><label>Discount type<select name="discountType"><option value="percent">Percentage</option><option value="fixed-price">Fixed membership price</option></select></label><label>Percent<input name="percent" type="number" min="1" max="100" value="10"></label><label>Fixed price ($)<input name="fixedPrice" type="number" min="0.01" step="0.01"></label><label>Tier<select name="tier"><option value="all">All tiers</option>${tierOptions}</select></label><label>Audience<select name="audience"><option value="sitewide">Site-wide</option><option value="private">Specific customer</option><option value="og">OG members</option></select></label><label>Customer email (private)<input name="recipientEmail" type="email" autocomplete="off"></label><label>Duration<select name="duration"><option value="once">Once</option><option value="forever">Forever</option><option value="repeating">Months</option></select></label><label>Months<input name="durationMonths" type="number" min="1" max="36" value="1"></label><label>Max uses<input name="maxUses" type="number" min="1"></label><label>Expires at<input name="expiresAt" type="date"></label><label class="aco-native-check"><input name="appliesToRentals" type="checkbox"> Includes rentals</label><div class="aco-native-form-actions"><button class="btn primary" type="submit">Save discount</button><button class="btn plain" type="reset">Cancel / clear</button></div></form>`;
 const giftForm=`<form id="acoGiftForm" class="aco-native-form"><label>Customer<select name="customerId" required><option value="">Select a customer</option>${customers.map(c=>`<option value="${esc(c.id)}">${esc(c.email)}</option>`).join('')}</select></label><label>Tier<select name="tier">${tierOptions}</select></label><label>Duration<select name="unit"><option value="months">Months</option><option value="weeks">Weeks</option></select></label><label>Length<input name="quantity" type="number" min="1" max="12" value="1" required></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Grant membership</button></div></form>`;
 resultBox('memberships').innerHTML=`${panel('Monthly membership revenue',revenue?stats(revenue):empty(errKey(response,'membership-revenue')||'Unavailable'))}
 <div class="aco-native-columns">${panel('Discount codes',discounts.length?discounts.map(discountLine).join(''):empty('No discount codes yet.'),'<span class="aco-native-count">'+discounts.length+' codes</span>')}
 ${panel('Create / edit discount',discountFields)}</div>
 <div class="aco-native-columns">${panel('Gifted memberships',gifts.length?gifts.map(g=>`<div class="aco-native-line"><div><strong>${esc(g.customerEmail||g.customerAccountId)}</strong><small>${esc(g.tierName||g.tier+' profiles')} · Until ${esc(when(g.expiresAt))}</small></div><button type="button" class="btn slim plain" data-gift-remove="${esc(g.id)}">Revoke</button></div>`).join(''):empty('No gifted memberships.'),'<span class="aco-native-count">'+gifts.length+' gifts</span>')}
 ${panel('Grant free membership',giftForm)}</div>`;
}
function renderAccounts(response){
 const oldFilters={retailer:$('acoPoolRetailer')?.value||'all',status:$('acoPoolStatus')?.value||'all',query:$('acoPoolQuery')?.value||''};
 const p=dataKey(response,'managed-pool/search'),rows=arr(p?.profiles);
 resultBox('accounts').innerHTML=`<div class="aco-native-filters"><label>Retailer<select id="acoPoolRetailer"><option value="all">All retailers</option><option value="target">Target</option><option value="walmart">Walmart</option><option value="pokemoncenter">Pokémon Center</option></select></label><label>Status<select id="acoPoolStatus"><option value="all">All accounts</option><option value="available">Available</option><option value="linked">Linked</option><option value="held">Held</option><option value="needs_repair">Needs repair</option><option value="duplicate">Duplicates</option></select></label><label>Search<input id="acoPoolQuery" type="search" placeholder="Email, profile or ID" value=""></label><button class="btn secondary" type="button" id="acoPoolSearch">Find accounts</button></div>
 <div class="aco-native-stat-row"><strong>${esc(p?.total??0)} accounts found</strong><div><button type="button" class="btn slim plain" id="acoPoolPrevious" ${p?.page<=1?'disabled':''}>← Previous</button><span id="acoPoolPage" data-page="${esc(p?.page||1)}">${esc(p?.page||1)} / ${esc(p?.pageCount||1)}</span><button type="button" class="btn slim plain" id="acoPoolNext" ${p?.page>=p?.pageCount?'disabled':''}>Next →</button></div></div>
 ${panel('Retailer account inventory',rows.length?rows.map(x=>`<div class="aco-native-line"><div><strong>${esc(x.profileName||x.loginEmail||x.id)}</strong><small>${esc(x.retailer)} · ${esc(x.status||'unknown')} · ${esc(x.loginEmail)}</small><small>${x.assignedTo?'Assigned to '+esc(x.assignedTo.name):'Available in shared pool'}</small></div><div class="aco-native-actions">${x.status==='needs_repair'?`<button class="btn slim secondary" data-pool-repair="${esc(x.id)}">Mark repaired</button>`:''}${x.status==='held'?`<button class="btn slim secondary" data-pool-override="${esc(x.id)}">Override hold</button>`:''}</div></div>`).join(''):empty(errKey(response,'managed-pool/search')||'No matching accounts.'))}
 <p class="siteMuted">Select a customer under Customers to assign, edit or return accounts. The same website inventory and authorization rules apply.</p>`;
 for(const [id,key] of [['acoPoolRetailer','retailer'],['acoPoolStatus','status'],['acoPoolQuery','query']]){
  const el=$(id);if(el)el.value=oldFilters[key];
 }
}

function renderOperations(response){
 const notification=dataKey(response,'site-notification')?.notification;
 const discord=dataKey(response,'discord-success-status'),mailbox=dataKey(response,'managed-success-mailbox-status'),consent=dataKey(response,'signup-consent-log');
 const consentRecords=arr(consent?.records).length?consent.records:arr(consent?.entries);
 resultBox('operations').innerHTML=`<div class="aco-native-columns">${panel('Website broadcast',notification?.active?`<div class="aco-native-line"><div><strong>${esc(notification.title)}</strong><p>${esc(notification.message)}</p><small>${when(notification.createdAt)}</small></div><button class="btn slim plain" type="button" data-retract="${esc(notification.id)}">Retract</button></div>`:empty('No active broadcast.'),`<span class="aco-native-state">${notification?.active?'Active':'Off'}</span>`)}
 ${panel('Post a customer notification',`<form id="acoBroadcastForm" class="aco-native-form"><label>Title<input name="title" maxlength="80" required></label><label>Message<textarea name="message" rows="3" maxlength="400" required></textarea></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Publish to website</button></div></form>`)}</div>
 <div class="aco-native-columns">${panel('Discord success channel',discord?stats(discord):empty(errKey(response,'discord-success-status')||'Status not available'),'<button type="button" class="btn slim secondary" data-scan="discord">Scan now</button>')}
 ${panel('Success mailbox',mailbox?stats(mailbox):empty(errKey(response,'managed-success-mailbox-status')||'Unavailable'))}</div>
 ${panel('Signup and purchase consent log',`<strong>${esc(consentRecords.length)} recent records loaded</strong><p class="siteMuted">Consent records remain stored permanently on the website. This panel is read-only and does not alter your original audit log.</p>`)} `;
}
async function act(action,payload,{message='Confirm this change?'}={}){
 if(!confirm(message))return null;
 const result=await api.adminAction(action,payload);
 const p=$('siteNotice');if(p){p.textContent=result.message||'Changes saved to website.';p.dataset.error='false';}
 return result;
}
function formFields(form){return Object.fromEntries(new FormData(form).entries());}
root.addEventListener('click',async e=>{
 const go=e.target.closest('[data-go]');if(go){selectTab(go.dataset.go);return;}
 const discountEdit=e.target.closest('[data-discount-edit]');if(discountEdit){dirtySections.add('memberships');const d=arr(dataKey(memberSnapshot,'discount-codes')?.codes).find(c=>c.id===discountEdit.dataset.discountEdit);if(!d)return;selectTab('memberships');const form=$('acoDiscountForm');if(!form)return;for(const [key,value] of Object.entries({...d,id:d.id,audience:d.recipientEmail?'private':d.ogOnly?'og':'sitewide'})){const input=form.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value===true;else input.value=value??'';}}form.querySelector('[type=submit]').textContent='Update discount';form.scrollIntoView({block:'nearest'});return;}
 const toggle=e.target.closest('[data-discount-toggle]');if(toggle){const d=arr(dataKey(memberSnapshot,'discount-codes')?.codes).find(c=>c.id===toggle.dataset.discountToggle);if(!d)return;try{if(await act('discount-toggle',{id:d.id,active:!d.active},{message:`${d.active?'Disable':'Enable'} ${d.code}?`}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const remove=e.target.closest('[data-discount-remove]');if(remove){try{if(await act('discount-delete',{id:remove.dataset.discountRemove},{message:'Permanently delete this discount code from Stripe and the website?'}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const gift=e.target.closest('[data-gift-remove]');if(gift){try{if(await act('gift-remove',{id:gift.dataset.giftRemove},{message:'Revoke this gifted membership? If billing was deferred, confirm the Stripe schedule separately.'}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const retract=e.target.closest('[data-retract]');if(retract){try{if(await act('site-notification-retract',{id:retract.dataset.retract},{message:'Retract this website notification?'}))await load('operations',true);}catch(err){alert(err.message);}return;}
 const scan=e.target.closest('[data-scan]');if(scan){try{if(await act('discord-success-scan',{},{message:'Request a fresh Discord success scan?'}))await load('operations',true);}catch(err){alert(err.message);}return;}
 const repair=e.target.closest('[data-pool-repair]');if(repair){try{if(await act('account-mark-repaired',{id:repair.dataset.poolRepair},{message:'Mark this retailer account repaired?'}))await load('accounts',true);}catch(err){alert(err.message);}return;}
 const override=e.target.closest('[data-pool-override]');if(override){try{if(await act('account-override-hold',{id:override.dataset.poolOverride},{message:'Override this account hold? This could make it available for assignment.'}))await load('accounts',true);}catch(err){alert(err.message);}return;}
 if(e.target.closest('#acoPoolSearch')){$('acoPoolPage').dataset.page='1';await load('accounts');return;}
 if(e.target.closest('#acoPoolNext')){$('acoPoolPage').dataset.page=String(Number($('acoPoolPage').dataset.page)+1);await load('accounts');return;}
 if(e.target.closest('#acoPoolPrevious')){$('acoPoolPage').dataset.page=String(Math.max(1,Number($('acoPoolPage').dataset.page)-1));await load('accounts');return;}
});
root.addEventListener('input',e=>{
 if(e.target.matches('#acoOrderSearch'))drawOrderList();
 const section=formSection[e.target.closest('form')?.id];if(section)dirtySections.add(section);
});
root.addEventListener('change',e=>{const section=formSection[e.target.closest('form')?.id];if(section)dirtySections.add(section);});
root.addEventListener('focusout',()=>setTimeout(()=>{
 if(pendingSections.has(active)&&!deferLive(active))void load(active,true);
},50));
root.addEventListener('change',e=>{if(e.target.matches('#acoOrderRetailer,#acoOrderPeriod')){filterPeriod=$('acoOrderPeriod').value;drawOrderList();}});
root.addEventListener('reset',e=>{
 const section=formSection[e.target.id];if(section){dirtySections.delete(section);setTimeout(()=>{if(pendingSections.has(section))void load(section,true);},80);}
 if(e.target.id==='acoDiscountForm')setTimeout(()=>{const f=$('acoDiscountForm');if(f){f.elements.namedItem('id').value='';f.querySelector('[type=submit]').textContent='Save discount';}},0);
});
root.addEventListener('submit',async e=>{
 if(!['acoDiscountForm','acoGiftForm','acoBroadcastForm'].includes(e.target.id))return;
 e.preventDefault();if(editing)return;editing=true;
 const form=e.target,save=form.querySelector('button[type=submit]'),data=formFields(form);save.disabled=true;
 try{
  const action=form.id==='acoDiscountForm'?'discount-save':form.id==='acoGiftForm'?'gift-create':'site-notification';
  if(action==='discount-save')data.appliesToRentals=form.elements.namedItem('appliesToRentals').checked;
  const options={message:action==='gift-create'?'Grant this customer a free membership? This can affect the Stripe renewal date.':action==='discount-save'?'Save this discount in Stripe and website Admin?':'Publish this notification to all website customers?'};
  const result=await act(action,data,options);
  if(result){const section=formSection[form.id];dirtySections.delete(section);form.reset();await load(section,true);}
 }catch(err){alert(err.message||'Website did not save this change.');}
 finally{save.disabled=false;editing=false;const section=formSection[form.id];if(pendingSections.has(section))void load(section,true);}
});
// Avoid reloading while a user is editing a form, opening a disclosure or navigating.
function refreshLive(){if(refreshTimer)clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{refreshTimer=null;if(active==='customers')return;void load(active,true);},1250);}
api.onChange?.(refreshLive);
document.addEventListener('jigstudio:customers-updated',event=>{if(event.detail?.connected&&!connected){connected=true;void load(active,true);}if(!event.detail?.connected)connected=false;});
// Customer edits are sent to the same website Admin route, not a second local copy.
const mainForm=document.createElement('form');mainForm.className='aco-native-profile-form aco-native-card';mainForm.id='acoMainCustomerProfile';mainForm.hidden=true;
mainForm.innerHTML=`<header><h3>Edit main customer details</h3><small>Saved directly to the existing website Admin customer record</small></header><div class="aco-native-form"><label>First name<input name="firstName" maxlength="80" required></label><label>Last name<input name="lastName" maxlength="80" required></label><label>Phone<input name="phone" maxlength="35"></label><label>Address<input name="address" maxlength="180" required></label><label>Address line 2<input name="address2" maxlength="180"></label><label>City<input name="city" maxlength="150" required></label><label>State<input name="state" maxlength="20" required></label><label>ZIP / ZIP+4<input name="zip" maxlength="10" required></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Save to website</button><span id="acoProfileFeedback" role="status"></span></div></div>`;
const customerActions=document.createElement('section');customerActions.className='aco-native-card aco-native-customer-actions';customerActions.id='acoCustomerActions';customerActions.hidden=true;
customerActions.innerHTML=`<header><h3>Customer actions</h3><small>Confirmed website actions, synchronized live</small></header>
<div class="aco-native-actions"><button type="button" class="btn slim secondary" id="acoNotifyMissingCustomer">Notify missing information</button><button type="button" class="btn slim plain" id="acoGrantOgCustomer">Grant OG status</button></div>
<form class="aco-native-form" id="acoCustomerMessage"><label class="aco-native-message-field">Send a message to this customer<textarea name="message" maxlength="1200" rows="2" placeholder="Type the customer notification" required></textarea></label><div class="aco-native-form-actions"><button class="btn primary" type="submit">Send customer message</button><span id="acoCustomerActionFeedback" role="status"></span></div></form>`;
const target=root.querySelector('#siteCustomerView .siteDetailGrid');if(target)target.before(mainForm,customerActions);
let activeOrderId='',activeCustomerId='',customerDraftDirty=false;
mainForm.addEventListener('input',()=>{customerDraftDirty=true;});
document.addEventListener('jigstudio:customer-opened',event=>{
 const {customer}=event.detail||{};
 const different=activeOrderId!==String(customer?.orderId||'');
 activeOrderId=String(customer?.orderId||'');activeCustomerId=String(customer?.id||'');
 mainForm.hidden=!activeOrderId;customerActions.hidden=!activeOrderId;
 if(different)customerDraftDirty=false;
 if(!activeOrderId||customerDraftDirty)return;const a=customer?.shipping||{};
 for(const field of ['firstName','lastName','phone','address','address2','city','state','zip']){const i=mainForm.elements.namedItem(field);if(i&&document.activeElement!==i)i.value=String(a[field]||'');}
});
mainForm.addEventListener('submit',async e=>{
 e.preventDefault();if(!activeOrderId||editing)return;const f=formFields(mainForm),button=mainForm.querySelector('[type=submit]');editing=true;button.disabled=true;
 try{const result=await act('customer-profile',{orderId:activeOrderId,profile:f},{message:'Save these customer details to the live website?'});
  if(result){customerDraftDirty=false;$('acoProfileFeedback').textContent='Saved to website.';await window.JigWebsiteCustomers?.refresh?.();}
 }catch(err){$('acoProfileFeedback').textContent=err.message||'Save failed.';}
 finally{editing=false;button.disabled=false;}
});
$('acoNotifyMissingCustomer')?.addEventListener('click',async()=>{
 if(!activeOrderId)return;
 try{if(await act('customer-missing-info',{orderId:activeOrderId},{message:'Send the current missing-information checklist to this customer?'})){
  $('acoCustomerActionFeedback').textContent='Website notification sent.';await window.JigWebsiteCustomers?.refresh?.();
 }}catch(error){$('acoCustomerActionFeedback').textContent=error.message||'Notification failed.';}
});
$('acoGrantOgCustomer')?.addEventListener('click',async()=>{
 if(!activeCustomerId)return;
 try{if(await act('customer-og',{customerId:activeCustomerId},{message:'Grant permanent OG status to this paid customer?'})){
  $('acoCustomerActionFeedback').textContent='OG status granted by website.';await window.JigWebsiteCustomers?.refresh?.();
 }}catch(error){$('acoCustomerActionFeedback').textContent=error.message||'OG update failed.';}
});
$('acoCustomerMessage')?.addEventListener('submit',async e=>{
 e.preventDefault();if(!activeOrderId||editing)return;
 const form=e.currentTarget,button=form.querySelector('[type=submit]');editing=true;button.disabled=true;
 try{const message=String(form.elements.namedItem('message')?.value||'').trim();
  if(await act('customer-message',{orderId:activeOrderId,message},{message:'Send this message to the selected customer?'})){
   form.reset();$('acoCustomerActionFeedback').textContent='Message sent by website.';
  }
 }catch(error){$('acoCustomerActionFeedback').textContent=error.message||'Unable to send message.';}
 finally{editing=false;button.disabled=false;}
});
selectTab('home');
})();
+(Number(v)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const centsAmount=v=>amount((Number(v)||0)/100);
const when=v=>{const d=new Date(v||'');return Number.isFinite(d.getTime())?d.toLocaleString():'—';};
const flatten=(v,prefix='',out=[],depth=0)=>{
 if(depth>2||!v||typeof v!=='object')return out;
 for(const [key,value] of Object.entries(v)){
  if(['ok','records','communityRecords','memberships','codes','customers','profiles','items','notification','addresses','paymentMethods','unmatchedRecent'].includes(key))continue;
  const label=(prefix?prefix+' · ':'')+key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ');
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')out.push([label,value]);
  else if(value&&typeof value==='object'&&!Array.isArray(value))flatten(value,label,out,depth+1);
  if(out.length>20)break;
 }
 return out;
};
const readKey=(data,key)=>data?.items?.find(item=>item.key===key);
const dataKey=(data,key)=>readKey(data,key)?.data;
const errKey=(data,key)=>readKey(data,key)?.error;
const sectionInfo=[
 ['home','Home','Revenue, activity and recent checkouts'],
 ['customers','Customers','Customer details, profiles, saved information'],
 ['orders','Orders','Verified checkouts and shipping status'],
 ['memberships','Memberships','Recurring revenue, discounts and gifted plans'],
 ['accounts','Retailer accounts','Available, linked and held inventory'],
 ['operations','Operations','Notifications, success channels and consent records']
];
const bar=document.createElement('nav');bar.className='aco-native-nav';bar.id='acoNativeSections';bar.setAttribute('aria-label','Admin sections');
for(const [id,title] of sectionInfo){const button=document.createElement('button');button.type='button';button.dataset.native=id;button.textContent=title;button.setAttribute('aria-controls','acoNative'+id);button.setAttribute('aria-current','false');bar.append(button);}
const panes=new Map();for(const [id,,desc] of sectionInfo){const section=document.createElement('section');section.id='acoNative'+id;section.className='aco-native-pane';section.hidden=id!=='home';section.innerHTML=id==='customers'?'':`<div class="aco-native-title"><div><div class="eyebrow">ADMIN / ${esc(id.toUpperCase())}</div><h2>${esc(sectionInfo.find(x=>x[0]===id)[1])}</h2><p>${esc(desc)}</p></div><button type="button" class="btn slim secondary" data-refresh="${esc(id)}">↻ Refresh</button></div><div class="aco-native-result" role="status">Connect Admin to load this section.</div>`;panes.set(id,section);}
const legacy=document.createElement('div');legacy.id='acoNativeCustomerWorkspace';legacy.append($('siteRosterView'),$('siteCustomerView'));panes.get('customers').append(legacy);
const anchor=$('siteNotice');anchor.before(bar,...panes.values());
let active='home',filterPeriod='7',ordersSnapshot=null,memberSnapshot=null,operationsSnapshot=null,poolSnapshot=null,dashboardSnapshot=null;
let connected=false,loading=new Set(),refreshTimer=null,editing=false;
const dirtySections=new Set(),pendingSections=new Set(),renderedFingerprints=new Map();
const editable='input,textarea,select,[contenteditable="true"]';
const formSection={acoDiscountForm:'memberships',acoGiftForm:'memberships',acoBroadcastForm:'operations'};
function focusedEditor(section){const focused=document.activeElement;return Boolean(focused&&panes.get(section)?.contains(focused)&&focused.matches?.(editable));}
function markPending(section){
 pendingSections.add(section);
 const pane=panes.get(section);if(!pane)return;
 let hint=pane.querySelector(':scope > .aco-native-live-pending');
 if(!hint){hint=document.createElement('div');hint.className='aco-native-live-pending';hint.setAttribute('role','status');
  hint.textContent='New website changes available — save or finish editing to refresh.';pane.querySelector('.aco-native-title')?.after(hint);}
 hint.hidden=false;
}
function clearPending(section){pendingSections.delete(section);const hint=panes.get(section)?.querySelector(':scope > .aco-native-live-pending');if(hint)hint.hidden=true;}
function deferLive(section){return dirtySections.has(section)||focusedEditor(section)||editing;}

function resultBox(section){return panes.get(section).querySelector('.aco-native-result');}
function sectionStatus(section,message,error=false){const p=resultBox(section);if(!p)return;p.textContent=message;p.classList.toggle('is-error',error);}
function groupData(item,field){return arr(item?.[field]);}
function panel(title,content='',extra=''){return `<section class="aco-native-card"><header><h3>${esc(title)}</h3>${extra}</header>${content}</section>`;}
function empty(text){return `<p class="aco-native-empty">${esc(text)}</p>`;}
function stats(data){return `<div class="aco-native-stats">${flatten(data).filter(([k,v])=>typeof v==='number'||typeof v==='string'&&v.length<70).slice(0,8).map(([key,value])=>`<div class="aco-native-stat"><small>${esc(key)}</small><b>${esc(value)}</b></div>`).join('')}</div>`;}
async function load(section,silent=false){
 if(!api?.adminRead||loading.has(section))return;
 if(silent&&deferLive(section)){markPending(section);return;}
 if(!silent&&dirtySections.has(section)&&!confirm('Discard unsaved Admin form changes and refresh?'))return;
 if(!silent)dirtySections.delete(section);
 loading.add(section);if(!silent)sectionStatus(section,'Loading current website data…');
 try{
  const view=section==='home'?'dashboard':section==='accounts'?'pool':section;
  const opts=view==='pool'?{status:$('acoPoolStatus')?.value||'all',retailer:$('acoPoolRetailer')?.value||'all',query:$('acoPoolQuery')?.value||'',page:Number($('acoPoolPage')?.dataset.page||1)}:{};
  const response=await api.adminRead(view,opts);
  const fingerprint=JSON.stringify(response.items);
  if(silent&&renderedFingerprints.get(section)===fingerprint){clearPending(section);connected=true;return;}
  // The network may finish after the owner has started typing. Never destroy a live form.
  if(silent&&deferLive(section)){markPending(section);connected=true;return;}
  if(section==='home'){dashboardSnapshot=response;renderHome(response);}
  if(section==='orders'){ordersSnapshot=response;renderOrders(response);}
  if(section==='memberships'){memberSnapshot=response;renderMemberships(response);}
  if(section==='accounts'){poolSnapshot=response;renderAccounts(response);}
  if(section==='operations'){operationsSnapshot=response;renderOperations(response);}
  renderedFingerprints.set(section,fingerprint);clearPending(section);connected=true;
 }catch(e){sectionStatus(section,e.message||'Unable to load Admin.',true);connected=false;}
 finally{loading.delete(section);}
}
function selectTab(id){
 if(!panes.has(id))id='home';active=id;
 for(const [key,node] of panes)node.hidden=key!==id;
 for(const button of bar.querySelectorAll('button'))button.setAttribute('aria-current',String(button.dataset.native===id));
 const headline=root.querySelector('.siteHeadline h1');if(headline)headline.textContent='Admin · '+sectionInfo.find(x=>x[0]===id)[1];
 if(id!=='customers')void load(id,true);
}
bar.addEventListener('click',e=>{const b=e.target.closest('[data-native]');if(b)selectTab(b.dataset.native);});
root.addEventListener('click',e=>{const b=e.target.closest('[data-refresh]');if(b)void load(b.dataset.refresh);});
function renderHome(response){
 const rev=dataKey(response,'membership-revenue'),orders=dataKey(response,'success-overview'),usage=dataKey(response,'app-usage'),notification=dataKey(response,'site-notification');
 const rows=arr(orders?.records).slice(0,8);
 const total=orders?.communityTotals||{};
 resultBox('home').innerHTML=`<div class="aco-native-stats"><div class="aco-native-stat"><small>Confirmed checkouts</small><b>${esc(total.checkouts??rows.length)}</b></div><div class="aco-native-stat"><small>Community spend</small><b>${amount(total.spent)}</b></div><div class="aco-native-stat"><small>Unmatched orders</small><b>${esc(orders?.unmatchedCount??'—')}</b></div><div class="aco-native-stat"><small>Membership billing</small><b>${esc(rev?.monthlyRevenueFormatted||rev?.totalMonthlyRevenueFormatted||rev?.monthlyTotalFormatted||'Open breakdown')}</b></div></div>
 <div class="aco-native-columns">${panel('Membership revenue',rev?stats(rev):empty(errKey(response,'membership-revenue')||'Revenue unavailable'))}
 ${panel('App usage',usage?stats(usage):empty(errKey(response,'app-usage')||'App usage unavailable'))}</div>
 ${panel('Recent checkouts',rows.length?ordersTable(rows):empty('No attributed orders loaded.'),'<button type="button" class="btn slim plain" data-go="orders">See all →</button>')}
 ${panel('Current website notification',notification?.notification?.active?`<strong>${esc(notification.notification.title)}</strong><p>${esc(notification.notification.message)}</p>`:empty('No active broadcast.'))}`;
}
function orderRows(){
 const all=arr(dataKey(ordersSnapshot,'success-overview')?.records);
 const keyword=String($('acoOrderSearch')?.value||'').trim().toLowerCase();
 const retailer=$('acoOrderRetailer')?.value||'all';
 const within=filterPeriod==='all'?0:Date.now()-Number(filterPeriod)*86400000;
 return all.filter(item=>(retailer==='all'||item.retailer===retailer)&&(!within||Date.parse(item.checkoutAt||'')>=within)&&(!keyword||[item.customerName,item.customerAccountId,item.retailer,...arr(item.items).map(x=>x.name)].join(' ').toLowerCase().includes(keyword)));
}
function ordersTable(items){
 return `<div class="aco-native-table-scroll"><table class="aco-native-table"><thead><tr><th>Checkout date</th><th>Customer · Profile</th><th>Retailer</th><th>Products in checkout</th><th>Total charged</th></tr></thead><tbody>${items.map(r=>`<tr><td>${esc(when(r.checkoutAt))}</td><td><strong>${esc(r.customerName||'Unmatched')}</strong><small>${esc(r.profileName||r.accountLabel||r.customerProfileName||'')}</small></td><td>${esc(r.retailer||'—')}</td><td>${arr(r.items).map(x=>`${esc(short(x.name,90))} ×${Number(x.quantity)||0}`).join('<span class="aco-native-sep"> · </span>')||'—'}</td><td>${r.orderTotalKnown===true?amount(r.orderTotal):amount(r.orderTotal)}${r.orderTotalKnown===false?'<small>Not yet verified</small>':''}</td></tr>`).join('')}</tbody></table></div>`;
}
function drawOrderList(){const box=$('acoOrderList');if(!box)return;const rows=orderRows();$('acoOrderCount').textContent=rows.length+' checkouts';box.innerHTML=rows.length?ordersTable(rows):empty('No verified checkouts match these filters.');}
function renderOrders(response){
 const savedFilters={period:$('acoOrderPeriod')?.value||filterPeriod,retailer:$('acoOrderRetailer')?.value||'all',query:$('acoOrderSearch')?.value||''};
 const overview=dataKey(response,'success-overview'),verify=dataKey(response,'checkout-paid-verification');
 if(!overview){sectionStatus('orders',errKey(response,'success-overview')||'Unable to load checkouts.',true);return;}
 resultBox('orders').innerHTML=`<div class="aco-native-stats"><div class="aco-native-stat"><small>Confirmed community checkouts</small><b>${esc(overview.communityTotals?.checkouts??0)}</b></div><div class="aco-native-stat"><small>Community spend</small><b>${amount(overview.communityTotals?.spent)}</b></div><div class="aco-native-stat"><small>Unmatched checkouts</small><b>${esc(overview.unmatchedCount??0)}</b></div></div>
 <div class="aco-native-filters"><label>Period<select id="acoOrderPeriod"><option value="1">24 hours</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="all">All time</option></select></label><label>Retailer<select id="acoOrderRetailer"><option value="all">All retailers</option><option value="target">Target</option><option value="walmart">Walmart</option><option value="pokemoncenter">Pokémon Center</option></select></label><label>Search<input type="search" id="acoOrderSearch" placeholder="Customer or product" autocomplete="off"></label><span id="acoOrderCount"></span></div>
 ${panel('Attributed checkouts',`<div id="acoOrderList"></div><p class="siteMuted">Order totals follow the website’s verified Discord checkout records. Unknown charges are not invented.</p>`)}
 ${panel('Price verification',verify?stats(verify):empty(errKey(response,'checkout-paid-verification')||'No verification data.'))}`;
 for(const [id,key] of [['acoOrderPeriod','period'],['acoOrderRetailer','retailer'],['acoOrderSearch','query']]){
  const el=$(id);if(el)el.value=savedFilters[key];
 }
 filterPeriod=savedFilters.period;drawOrderList();
}
function discountLine(d){return `<div class="aco-native-line"><div><strong>${esc(d.code||'Discount')}</strong><small>${esc(d.discountType==='fixed-price'?amount(d.fixedPrice):d.percent+'%')} · ${esc(d.tier==='all'?'All tiers':d.tier+' accounts')} · ${esc(d.recipientEmail|| (d.ogOnly?'OG customers':d.sitewide?'Site-wide':'Selected customers'))}</small><small>${esc(d.duration==='repeating'?'Repeats '+d.durationMonths+' months':d.duration||'')}</small></div><div class="aco-native-actions"><span class="aco-native-state">${d.active?'Active':'Inactive'}</span><button type="button" class="btn slim secondary" data-discount-edit="${esc(d.id)}">Edit</button><button type="button" class="btn slim plain" data-discount-toggle="${esc(d.id)}">${d.active?'Disable':'Enable'}</button><button type="button" class="btn slim plain" data-discount-remove="${esc(d.id)}">Delete</button></div></div>`;}
function renderMemberships(response){
 const liveTiers=arr(dataKey(response,'membership-prices')?.tiers);const tierOptions=(liveTiers.length?liveTiers:[{tier:1,profiles:1},{tier:2,profiles:2},{tier:3,profiles:3},{tier:4,profiles:5},{tier:5,profiles:10},{tier:6,profiles:20},{tier:7,profiles:50},{tier:8,profiles:100}]).map(p=>`<option value="${esc(p.tier)}">${esc(p.profiles)} profiles${p.amount?' · '+esc(amount(p.amount))+'/month':''}</option>`).join('');
 const codes=dataKey(response,'discount-codes'),gifted=dataKey(response,'gifted-memberships'),giftable=dataKey(response,'giftable-customers'),revenue=dataKey(response,'membership-revenue');
 const discounts=arr(codes?.codes),gifts=arr(gifted?.memberships),customers=arr(giftable?.customers);
 const discountFields=`<form id="acoDiscountForm" class="aco-native-form"><input type="hidden" name="id" value=""><label>Coupon code<input name="code" maxlength="40" required placeholder="WELCOME20"></label><label>Discount type<select name="discountType"><option value="percent">Percentage</option><option value="fixed-price">Fixed membership price</option></select></label><label>Percent<input name="percent" type="number" min="1" max="100" value="10"></label><label>Fixed price ($)<input name="fixedPrice" type="number" min="0.01" step="0.01"></label><label>Tier<select name="tier"><option value="all">All tiers</option>${tierOptions}</select></label><label>Audience<select name="audience"><option value="sitewide">Site-wide</option><option value="private">Specific customer</option><option value="og">OG members</option></select></label><label>Customer email (private)<input name="recipientEmail" type="email" autocomplete="off"></label><label>Duration<select name="duration"><option value="once">Once</option><option value="forever">Forever</option><option value="repeating">Months</option></select></label><label>Months<input name="durationMonths" type="number" min="1" max="36" value="1"></label><label>Max uses<input name="maxUses" type="number" min="1"></label><label>Expires at<input name="expiresAt" type="date"></label><label class="aco-native-check"><input name="appliesToRentals" type="checkbox"> Includes rentals</label><div class="aco-native-form-actions"><button class="btn primary" type="submit">Save discount</button><button class="btn plain" type="reset">Cancel / clear</button></div></form>`;
 const giftForm=`<form id="acoGiftForm" class="aco-native-form"><label>Customer<select name="customerId" required><option value="">Select a customer</option>${customers.map(c=>`<option value="${esc(c.id)}">${esc(c.email)}</option>`).join('')}</select></label><label>Tier<select name="tier">${tierOptions}</select></label><label>Duration<select name="unit"><option value="months">Months</option><option value="weeks">Weeks</option></select></label><label>Length<input name="quantity" type="number" min="1" max="12" value="1" required></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Grant membership</button></div></form>`;
 resultBox('memberships').innerHTML=`${panel('Monthly membership revenue',revenue?stats(revenue):empty(errKey(response,'membership-revenue')||'Unavailable'))}
 <div class="aco-native-columns">${panel('Discount codes',discounts.length?discounts.map(discountLine).join(''):empty('No discount codes yet.'),'<span class="aco-native-count">'+discounts.length+' codes</span>')}
 ${panel('Create / edit discount',discountFields)}</div>
 <div class="aco-native-columns">${panel('Gifted memberships',gifts.length?gifts.map(g=>`<div class="aco-native-line"><div><strong>${esc(g.customerEmail||g.customerAccountId)}</strong><small>${esc(g.tierName||g.tier+' profiles')} · Until ${esc(when(g.expiresAt))}</small></div><button type="button" class="btn slim plain" data-gift-remove="${esc(g.id)}">Revoke</button></div>`).join(''):empty('No gifted memberships.'),'<span class="aco-native-count">'+gifts.length+' gifts</span>')}
 ${panel('Grant free membership',giftForm)}</div>`;
}
function renderAccounts(response){
 const oldFilters={retailer:$('acoPoolRetailer')?.value||'all',status:$('acoPoolStatus')?.value||'all',query:$('acoPoolQuery')?.value||''};
 const p=dataKey(response,'managed-pool/search'),rows=arr(p?.profiles);
 resultBox('accounts').innerHTML=`<div class="aco-native-filters"><label>Retailer<select id="acoPoolRetailer"><option value="all">All retailers</option><option value="target">Target</option><option value="walmart">Walmart</option><option value="pokemoncenter">Pokémon Center</option></select></label><label>Status<select id="acoPoolStatus"><option value="all">All accounts</option><option value="available">Available</option><option value="linked">Linked</option><option value="held">Held</option><option value="needs_repair">Needs repair</option><option value="duplicate">Duplicates</option></select></label><label>Search<input id="acoPoolQuery" type="search" placeholder="Email, profile or ID" value=""></label><button class="btn secondary" type="button" id="acoPoolSearch">Find accounts</button></div>
 <div class="aco-native-stat-row"><strong>${esc(p?.total??0)} accounts found</strong><div><button type="button" class="btn slim plain" id="acoPoolPrevious" ${p?.page<=1?'disabled':''}>← Previous</button><span id="acoPoolPage" data-page="${esc(p?.page||1)}">${esc(p?.page||1)} / ${esc(p?.pageCount||1)}</span><button type="button" class="btn slim plain" id="acoPoolNext" ${p?.page>=p?.pageCount?'disabled':''}>Next →</button></div></div>
 ${panel('Retailer account inventory',rows.length?rows.map(x=>`<div class="aco-native-line"><div><strong>${esc(x.profileName||x.loginEmail||x.id)}</strong><small>${esc(x.retailer)} · ${esc(x.status||'unknown')} · ${esc(x.loginEmail)}</small><small>${x.assignedTo?'Assigned to '+esc(x.assignedTo.name):'Available in shared pool'}</small></div><div class="aco-native-actions">${x.status==='needs_repair'?`<button class="btn slim secondary" data-pool-repair="${esc(x.id)}">Mark repaired</button>`:''}${x.status==='held'?`<button class="btn slim secondary" data-pool-override="${esc(x.id)}">Override hold</button>`:''}</div></div>`).join(''):empty(errKey(response,'managed-pool/search')||'No matching accounts.'))}
 <p class="siteMuted">Select a customer under Customers to assign, edit or return accounts. The same website inventory and authorization rules apply.</p>`;
 for(const [id,key] of [['acoPoolRetailer','retailer'],['acoPoolStatus','status'],['acoPoolQuery','query']]){
  const el=$(id);if(el)el.value=oldFilters[key];
 }
}

function renderOperations(response){
 const notification=dataKey(response,'site-notification')?.notification;
 const discord=dataKey(response,'discord-success-status'),mailbox=dataKey(response,'managed-success-mailbox-status'),consent=dataKey(response,'signup-consent-log');
 const consentRecords=arr(consent?.records).length?consent.records:arr(consent?.entries);
 resultBox('operations').innerHTML=`<div class="aco-native-columns">${panel('Website broadcast',notification?.active?`<div class="aco-native-line"><div><strong>${esc(notification.title)}</strong><p>${esc(notification.message)}</p><small>${when(notification.createdAt)}</small></div><button class="btn slim plain" type="button" data-retract="${esc(notification.id)}">Retract</button></div>`:empty('No active broadcast.'),`<span class="aco-native-state">${notification?.active?'Active':'Off'}</span>`)}
 ${panel('Post a customer notification',`<form id="acoBroadcastForm" class="aco-native-form"><label>Title<input name="title" maxlength="80" required></label><label>Message<textarea name="message" rows="3" maxlength="400" required></textarea></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Publish to website</button></div></form>`)}</div>
 <div class="aco-native-columns">${panel('Discord success channel',discord?stats(discord):empty(errKey(response,'discord-success-status')||'Status not available'),'<button type="button" class="btn slim secondary" data-scan="discord">Scan now</button>')}
 ${panel('Success mailbox',mailbox?stats(mailbox):empty(errKey(response,'managed-success-mailbox-status')||'Unavailable'))}</div>
 ${panel('Signup and purchase consent log',`<strong>${esc(consentRecords.length)} recent records loaded</strong><p class="siteMuted">Consent records remain stored permanently on the website. This panel is read-only and does not alter your original audit log.</p>`)} `;
}
async function act(action,payload,{message='Confirm this change?'}={}){
 if(!confirm(message))return null;
 const result=await api.adminAction(action,payload);
 const p=$('siteNotice');if(p){p.textContent=result.message||'Changes saved to website.';p.dataset.error='false';}
 return result;
}
function formFields(form){return Object.fromEntries(new FormData(form).entries());}
root.addEventListener('click',async e=>{
 const go=e.target.closest('[data-go]');if(go){selectTab(go.dataset.go);return;}
 const discountEdit=e.target.closest('[data-discount-edit]');if(discountEdit){dirtySections.add('memberships');const d=arr(dataKey(memberSnapshot,'discount-codes')?.codes).find(c=>c.id===discountEdit.dataset.discountEdit);if(!d)return;selectTab('memberships');const form=$('acoDiscountForm');if(!form)return;for(const [key,value] of Object.entries({...d,id:d.id,audience:d.recipientEmail?'private':d.ogOnly?'og':'sitewide'})){const input=form.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value===true;else input.value=value??'';}}form.querySelector('[type=submit]').textContent='Update discount';form.scrollIntoView({block:'nearest'});return;}
 const toggle=e.target.closest('[data-discount-toggle]');if(toggle){const d=arr(dataKey(memberSnapshot,'discount-codes')?.codes).find(c=>c.id===toggle.dataset.discountToggle);if(!d)return;try{if(await act('discount-toggle',{id:d.id,active:!d.active},{message:`${d.active?'Disable':'Enable'} ${d.code}?`}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const remove=e.target.closest('[data-discount-remove]');if(remove){try{if(await act('discount-delete',{id:remove.dataset.discountRemove},{message:'Permanently delete this discount code from Stripe and the website?'}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const gift=e.target.closest('[data-gift-remove]');if(gift){try{if(await act('gift-remove',{id:gift.dataset.giftRemove},{message:'Revoke this gifted membership? If billing was deferred, confirm the Stripe schedule separately.'}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const retract=e.target.closest('[data-retract]');if(retract){try{if(await act('site-notification-retract',{id:retract.dataset.retract},{message:'Retract this website notification?'}))await load('operations',true);}catch(err){alert(err.message);}return;}
 const scan=e.target.closest('[data-scan]');if(scan){try{if(await act('discord-success-scan',{},{message:'Request a fresh Discord success scan?'}))await load('operations',true);}catch(err){alert(err.message);}return;}
 const repair=e.target.closest('[data-pool-repair]');if(repair){try{if(await act('account-mark-repaired',{id:repair.dataset.poolRepair},{message:'Mark this retailer account repaired?'}))await load('accounts',true);}catch(err){alert(err.message);}return;}
 const override=e.target.closest('[data-pool-override]');if(override){try{if(await act('account-override-hold',{id:override.dataset.poolOverride},{message:'Override this account hold? This could make it available for assignment.'}))await load('accounts',true);}catch(err){alert(err.message);}return;}
 if(e.target.closest('#acoPoolSearch')){$('acoPoolPage').dataset.page='1';await load('accounts');return;}
 if(e.target.closest('#acoPoolNext')){$('acoPoolPage').dataset.page=String(Number($('acoPoolPage').dataset.page)+1);await load('accounts');return;}
 if(e.target.closest('#acoPoolPrevious')){$('acoPoolPage').dataset.page=String(Math.max(1,Number($('acoPoolPage').dataset.page)-1));await load('accounts');return;}
});
root.addEventListener('input',e=>{
 if(e.target.matches('#acoOrderSearch'))drawOrderList();
 const section=formSection[e.target.closest('form')?.id];if(section)dirtySections.add(section);
});
root.addEventListener('change',e=>{const section=formSection[e.target.closest('form')?.id];if(section)dirtySections.add(section);});
root.addEventListener('focusout',()=>setTimeout(()=>{
 if(pendingSections.has(active)&&!deferLive(active))void load(active,true);
},50));
root.addEventListener('change',e=>{if(e.target.matches('#acoOrderRetailer,#acoOrderPeriod')){filterPeriod=$('acoOrderPeriod').value;drawOrderList();}});
root.addEventListener('reset',e=>{
 const section=formSection[e.target.id];if(section){dirtySections.delete(section);setTimeout(()=>{if(pendingSections.has(section))void load(section,true);},80);}
 if(e.target.id==='acoDiscountForm')setTimeout(()=>{const f=$('acoDiscountForm');if(f){f.elements.namedItem('id').value='';f.querySelector('[type=submit]').textContent='Save discount';}},0);
});
root.addEventListener('submit',async e=>{
 if(!['acoDiscountForm','acoGiftForm','acoBroadcastForm'].includes(e.target.id))return;
 e.preventDefault();if(editing)return;editing=true;
 const form=e.target,save=form.querySelector('button[type=submit]'),data=formFields(form);save.disabled=true;
 try{
  const action=form.id==='acoDiscountForm'?'discount-save':form.id==='acoGiftForm'?'gift-create':'site-notification';
  if(action==='discount-save')data.appliesToRentals=form.elements.namedItem('appliesToRentals').checked;
  const options={message:action==='gift-create'?'Grant this customer a free membership? This can affect the Stripe renewal date.':action==='discount-save'?'Save this discount in Stripe and website Admin?':'Publish this notification to all website customers?'};
  const result=await act(action,data,options);
  if(result){const section=formSection[form.id];dirtySections.delete(section);form.reset();await load(section,true);}
 }catch(err){alert(err.message||'Website did not save this change.');}
 finally{save.disabled=false;editing=false;const section=formSection[form.id];if(pendingSections.has(section))void load(section,true);}
});
// Avoid reloading while a user is editing a form, opening a disclosure or navigating.
function refreshLive(){if(refreshTimer)clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{refreshTimer=null;if(active==='customers')return;void load(active,true);},1250);}
api.onChange?.(refreshLive);
document.addEventListener('jigstudio:customers-updated',event=>{if(event.detail?.connected&&!connected){connected=true;void load(active,true);}if(!event.detail?.connected)connected=false;});
// Customer edits are sent to the same website Admin route, not a second local copy.
const mainForm=document.createElement('form');mainForm.className='aco-native-profile-form aco-native-card';mainForm.id='acoMainCustomerProfile';mainForm.hidden=true;
mainForm.innerHTML=`<header><h3>Edit main customer details</h3><small>Saved directly to the existing website Admin customer record</small></header><div class="aco-native-form"><label>First name<input name="firstName" maxlength="80" required></label><label>Last name<input name="lastName" maxlength="80" required></label><label>Phone<input name="phone" maxlength="35"></label><label>Address<input name="address" maxlength="180" required></label><label>Address line 2<input name="address2" maxlength="180"></label><label>City<input name="city" maxlength="150" required></label><label>State<input name="state" maxlength="20" required></label><label>ZIP / ZIP+4<input name="zip" maxlength="10" required></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Save to website</button><span id="acoProfileFeedback" role="status"></span></div></div>`;
const customerActions=document.createElement('section');customerActions.className='aco-native-card aco-native-customer-actions';customerActions.id='acoCustomerActions';customerActions.hidden=true;
customerActions.innerHTML=`<header><h3>Customer actions</h3><small>Confirmed website actions, synchronized live</small></header>
<div class="aco-native-actions"><button type="button" class="btn slim secondary" id="acoNotifyMissingCustomer">Notify missing information</button><button type="button" class="btn slim plain" id="acoGrantOgCustomer">Grant OG status</button></div>
<form class="aco-native-form" id="acoCustomerMessage"><label class="aco-native-message-field">Send a message to this customer<textarea name="message" maxlength="1200" rows="2" placeholder="Type the customer notification" required></textarea></label><div class="aco-native-form-actions"><button class="btn primary" type="submit">Send customer message</button><span id="acoCustomerActionFeedback" role="status"></span></div></form>`;
const target=root.querySelector('#siteCustomerView .siteDetailGrid');if(target)target.before(mainForm,customerActions);
let activeOrderId='',activeCustomerId='',customerDraftDirty=false;
mainForm.addEventListener('input',()=>{customerDraftDirty=true;});
document.addEventListener('jigstudio:customer-opened',event=>{
 const {customer}=event.detail||{};
 const different=activeOrderId!==String(customer?.orderId||'');
 activeOrderId=String(customer?.orderId||'');activeCustomerId=String(customer?.id||'');
 mainForm.hidden=!activeOrderId;customerActions.hidden=!activeOrderId;
 if(different)customerDraftDirty=false;
 if(!activeOrderId||customerDraftDirty)return;const a=customer?.shipping||{};
 for(const field of ['firstName','lastName','phone','address','address2','city','state','zip']){const i=mainForm.elements.namedItem(field);if(i&&document.activeElement!==i)i.value=String(a[field]||'');}
});
mainForm.addEventListener('submit',async e=>{
 e.preventDefault();if(!activeOrderId||editing)return;const f=formFields(mainForm),button=mainForm.querySelector('[type=submit]');editing=true;button.disabled=true;
 try{const result=await act('customer-profile',{orderId:activeOrderId,profile:f},{message:'Save these customer details to the live website?'});
  if(result){customerDraftDirty=false;$('acoProfileFeedback').textContent='Saved to website.';await window.JigWebsiteCustomers?.refresh?.();}
 }catch(err){$('acoProfileFeedback').textContent=err.message||'Save failed.';}
 finally{editing=false;button.disabled=false;}
});
$('acoNotifyMissingCustomer')?.addEventListener('click',async()=>{
 if(!activeOrderId)return;
 try{if(await act('customer-missing-info',{orderId:activeOrderId},{message:'Send the current missing-information checklist to this customer?'})){
  $('acoCustomerActionFeedback').textContent='Website notification sent.';await window.JigWebsiteCustomers?.refresh?.();
 }}catch(error){$('acoCustomerActionFeedback').textContent=error.message||'Notification failed.';}
});
$('acoGrantOgCustomer')?.addEventListener('click',async()=>{
 if(!activeCustomerId)return;
 try{if(await act('customer-og',{customerId:activeCustomerId},{message:'Grant permanent OG status to this paid customer?'})){
  $('acoCustomerActionFeedback').textContent='OG status granted by website.';await window.JigWebsiteCustomers?.refresh?.();
 }}catch(error){$('acoCustomerActionFeedback').textContent=error.message||'OG update failed.';}
});
$('acoCustomerMessage')?.addEventListener('submit',async e=>{
 e.preventDefault();if(!activeOrderId||editing)return;
 const form=e.currentTarget,button=form.querySelector('[type=submit]');editing=true;button.disabled=true;
 try{const message=String(form.elements.namedItem('message')?.value||'').trim();
  if(await act('customer-message',{orderId:activeOrderId,message},{message:'Send this message to the selected customer?'})){
   form.reset();$('acoCustomerActionFeedback').textContent='Message sent by website.';
  }
 }catch(error){$('acoCustomerActionFeedback').textContent=error.message||'Unable to send message.';}
 finally{editing=false;button.disabled=false;}
});
selectTab('home');
})();
+(Number(v)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const centsAmount=v=>amount((Number(v)||0)/100);
const when=v=>{const d=new Date(v||'');return Number.isFinite(d.getTime())?d.toLocaleString():'—';};
const flatten=(v,prefix='',out=[],depth=0)=>{
 if(depth>2||!v||typeof v!=='object')return out;
 for(const [key,value] of Object.entries(v)){
  if(['ok','records','communityRecords','memberships','codes','customers','profiles','items','notification','addresses','paymentMethods','unmatchedRecent','recurringCalculation','calculatedAt'].includes(key))continue;
  const label=(prefix?prefix+' · ':'')+key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ');
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')out.push([label,value]);
  else if(value&&typeof value==='object'&&!Array.isArray(value))flatten(value,label,out,depth+1);
  if(out.length>20)break;
 }
 return out;
};
const readKey=(data,key)=>data?.items?.find(item=>item.key===key);
const dataKey=(data,key)=>readKey(data,key)?.data;
const errKey=(data,key)=>readKey(data,key)?.error;
const sectionInfo=[
 ['home','Home','Revenue, activity and recent checkouts'],
 ['customers','Customers','Customer details, profiles, saved information'],
 ['orders','Orders','Verified checkouts and shipping status'],
 ['memberships','Memberships','Recurring revenue, discounts and gifted plans'],
 ['accounts','Retailer accounts','Available, linked and held inventory'],
 ['operations','Operations','Notifications, success channels and consent records']
];
const bar=document.createElement('nav');bar.className='aco-native-nav';bar.id='acoNativeSections';bar.setAttribute('aria-label','Admin sections');
for(const [id,title] of sectionInfo){const button=document.createElement('button');button.type='button';button.dataset.native=id;button.textContent=title;button.setAttribute('aria-controls','acoNative'+id);button.setAttribute('aria-current','false');bar.append(button);}
const panes=new Map();for(const [id,,desc] of sectionInfo){const section=document.createElement('section');section.id='acoNative'+id;section.className='aco-native-pane';section.hidden=id!=='home';section.innerHTML=id==='customers'?'':`<div class="aco-native-title"><div><div class="eyebrow">ADMIN / ${esc(id.toUpperCase())}</div><h2>${esc(sectionInfo.find(x=>x[0]===id)[1])}</h2><p>${esc(desc)}</p></div><button type="button" class="btn slim secondary" data-refresh="${esc(id)}">↻ Refresh</button></div><div class="aco-native-result" role="status">Connect Admin to load this section.</div>`;panes.set(id,section);}
const legacy=document.createElement('div');legacy.id='acoNativeCustomerWorkspace';legacy.append($('siteRosterView'),$('siteCustomerView'));panes.get('customers').append(legacy);
const anchor=$('siteNotice');anchor.before(bar,...panes.values());
let active='home',filterPeriod='7',ordersSnapshot=null,memberSnapshot=null,operationsSnapshot=null,poolSnapshot=null,dashboardSnapshot=null;
let connected=false,loading=new Set(),refreshTimer=null,editing=false;
const dirtySections=new Set(),pendingSections=new Set(),renderedFingerprints=new Map();
const editable='input,textarea,select,[contenteditable="true"]';
const formSection={acoDiscountForm:'memberships',acoGiftForm:'memberships',acoBroadcastForm:'operations'};
function focusedEditor(section){const focused=document.activeElement;return Boolean(focused&&panes.get(section)?.contains(focused)&&focused.matches?.(editable));}
function markPending(section){
 pendingSections.add(section);
 const pane=panes.get(section);if(!pane)return;
 let hint=pane.querySelector(':scope > .aco-native-live-pending');
 if(!hint){hint=document.createElement('div');hint.className='aco-native-live-pending';hint.setAttribute('role','status');
  hint.textContent='New website changes available — save or finish editing to refresh.';pane.querySelector('.aco-native-title')?.after(hint);}
 hint.hidden=false;
}
function clearPending(section){pendingSections.delete(section);const hint=panes.get(section)?.querySelector(':scope > .aco-native-live-pending');if(hint)hint.hidden=true;}
function deferLive(section){return dirtySections.has(section)||focusedEditor(section)||editing;}

function resultBox(section){return panes.get(section).querySelector('.aco-native-result');}
function itemMap(response){return new Map(arr(response?.items).map(item=>[item?.key,item]).filter(([key])=>key));}
function mergeSnapshot(previous,response){
 if(!previous)return response;
 const old=itemMap(previous),next=itemMap(response),keys=new Set([...old.keys(),...next.keys()]),items=[];
 for(const key of keys){
  const fresh=next.get(key),prior=old.get(key);
  // Live reads are independent requests. A transient failure for one endpoint
  // must never erase a previously verified panel while the other endpoints load.
  const freshEmptyOverview=key==='success-overview'&&fresh?.data&&prior?.data&&
   Number(fresh.data?.communityTotals?.checkouts||0)===0&&Number(fresh.data?.communityTotals?.spent||0)===0&&
   arr(fresh.data?.records).length===0&&
   (Number(prior.data?.communityTotals?.checkouts||0)>0||Number(prior.data?.communityTotals?.spent||0)>0||arr(prior.data?.records).length>0);
  items.push(freshEmptyOverview?prior:(fresh&&fresh.data!=null?fresh:(prior?.data!=null?prior:fresh||prior)));
 }
 return {...previous,...response,items};
}
function sectionStatus(section,message,error=false){const p=resultBox(section);if(!p)return;p.textContent=message;p.classList.toggle('is-error',error);}
function groupData(item,field){return arr(item?.[field]);}
function panel(title,content='',extra=''){return `<section class="aco-native-card"><header><h3>${esc(title)}</h3>${extra}</header>${content}</section>`;}
function empty(text){return `<p class="aco-native-empty">${esc(text)}</p>`;}
function stats(data){return `<div class="aco-native-stats">${flatten(data).filter(([k,v])=>typeof v==='number'||typeof v==='string'&&v.length<70).slice(0,8).map(([key,value])=>{const isCents=/\bcents$/i.test(key.trim()),label=isCents?key.replace(/\s*cents$/i,''):key;const shown=isCents?centsAmount(value):/^currency$/i.test(label)?String(value).toUpperCase():value;return `<div class="aco-native-stat"><small>${esc(label)}</small><b>${esc(shown)}</b></div>`;}).join('')}</div>`;}
async function load(section,silent=false){
 if(!api?.adminRead||loading.has(section))return;
 if(silent&&deferLive(section)){markPending(section);return;}
 if(!silent&&dirtySections.has(section)&&!confirm('Discard unsaved Admin form changes and refresh?'))return;
 if(!silent)dirtySections.delete(section);
 loading.add(section);if(!silent)sectionStatus(section,'Loading current website data…');
 try{
  const view=section==='home'?'dashboard':section==='accounts'?'pool':section;
  const opts=view==='pool'?{status:$('acoPoolStatus')?.value||'all',retailer:$('acoPoolRetailer')?.value||'all',query:$('acoPoolQuery')?.value||'',page:Number($('acoPoolPage')?.dataset.page||1)}:{};
  const response=await api.adminRead(view,opts);
  const fingerprint=JSON.stringify(response.items);
  if(silent&&renderedFingerprints.get(section)===fingerprint){clearPending(section);connected=true;return;}
  // The network may finish after the owner has started typing. Never destroy a live form.
  if(silent&&deferLive(section)){markPending(section);connected=true;return;}
  if(section==='home'){dashboardSnapshot=mergeSnapshot(dashboardSnapshot,response);renderHome(dashboardSnapshot);}
  if(section==='orders'){ordersSnapshot=mergeSnapshot(ordersSnapshot,response);renderOrders(ordersSnapshot);}
  if(section==='memberships'){memberSnapshot=mergeSnapshot(memberSnapshot,response);renderMemberships(memberSnapshot);}
  if(section==='accounts'){poolSnapshot=mergeSnapshot(poolSnapshot,response);renderAccounts(poolSnapshot);}
  if(section==='operations'){operationsSnapshot=mergeSnapshot(operationsSnapshot,response);renderOperations(operationsSnapshot);}
  const rendered={home:dashboardSnapshot,orders:ordersSnapshot,memberships:memberSnapshot,accounts:poolSnapshot,operations:operationsSnapshot}[section]||response;
  renderedFingerprints.set(section,JSON.stringify(rendered?.items||[]));clearPending(section);connected=true;
 }catch(e){
  const prior={home:dashboardSnapshot,orders:ordersSnapshot,memberships:memberSnapshot,accounts:poolSnapshot,operations:operationsSnapshot}[section];
  if(prior?.items?.some(item=>item?.data!=null)){connected=true;markPending(section);}
  else {sectionStatus(section,e.message||'Unable to load Admin.',true);connected=false;}
 }
 finally{loading.delete(section);}
}
function selectTab(id){
 if(!panes.has(id))id='home';active=id;
 for(const [key,node] of panes)node.hidden=key!==id;
 for(const button of bar.querySelectorAll('button'))button.setAttribute('aria-current',String(button.dataset.native===id));
 const headline=root.querySelector('.siteHeadline h1');if(headline)headline.textContent='Admin · '+sectionInfo.find(x=>x[0]===id)[1];
 if(id!=='customers')void load(id,true);
}
bar.addEventListener('click',e=>{const b=e.target.closest('[data-native]');if(b)selectTab(b.dataset.native);});
root.addEventListener('click',e=>{const b=e.target.closest('[data-refresh]');if(b)void load(b.dataset.refresh);});
function renderHome(response){
 const rev=dataKey(response,'membership-revenue'),orders=dataKey(response,'success-overview'),usage=dataKey(response,'app-usage'),notification=dataKey(response,'site-notification');
 const rows=arr(orders?.records).slice(0,8);
 const total=orders?.communityTotals||{};
 resultBox('home').innerHTML=`<div class="aco-native-stats"><div class="aco-native-stat"><small>Confirmed checkouts</small><b>${esc(total.checkouts??rows.length)}</b></div><div class="aco-native-stat"><small>Community spend</small><b>${amount(total.spent)}</b></div><div class="aco-native-stat"><small>Unmatched orders</small><b>${esc(orders?.unmatchedCount??'—')}</b></div><div class="aco-native-stat"><small>Membership billing</small><b>${esc(rev?.monthlyRevenueFormatted||rev?.totalMonthlyRevenueFormatted||rev?.monthlyTotalFormatted||(rev?.monthlyRecurringCents!=null?centsAmount(rev.monthlyRecurringCents):'Open breakdown'))}</b></div></div>
 <div class="aco-native-columns">${panel('Membership revenue',rev?stats(rev):empty(errKey(response,'membership-revenue')||'Revenue unavailable'))}
 ${panel('App usage',usage?stats(usage):empty(errKey(response,'app-usage')||'App usage unavailable'))}</div>
 ${panel('Recent checkouts',rows.length?ordersTable(rows):empty('No attributed orders loaded.'),'<button type="button" class="btn slim plain" data-go="orders">See all →</button>')}
 ${panel('Current website notification',notification?.notification?.active?`<strong>${esc(notification.notification.title)}</strong><p>${esc(notification.notification.message)}</p>`:empty('No active broadcast.'))}`;
}
function orderRows(){
 const all=arr(dataKey(ordersSnapshot,'success-overview')?.records);
 const keyword=String($('acoOrderSearch')?.value||'').trim().toLowerCase();
 const retailer=$('acoOrderRetailer')?.value||'all';
 const within=filterPeriod==='all'?0:Date.now()-Number(filterPeriod)*86400000;
 return all.filter(item=>(retailer==='all'||item.retailer===retailer)&&(!within||Date.parse(item.checkoutAt||'')>=within)&&(!keyword||[item.customerName,item.customerAccountId,item.retailer,...arr(item.items).map(x=>x.name)].join(' ').toLowerCase().includes(keyword)));
}
function ordersTable(items){
 return `<div class="aco-native-table-scroll"><table class="aco-native-table"><thead><tr><th>Checkout date</th><th>Customer · Profile</th><th>Retailer</th><th>Products in checkout</th><th>Total charged</th></tr></thead><tbody>${items.map(r=>`<tr><td>${esc(when(r.checkoutAt))}</td><td><strong>${esc(r.customerName||'Unmatched')}</strong><small>${esc(r.profileName||r.accountLabel||r.customerProfileName||'')}</small></td><td>${esc(r.retailer||'—')}</td><td>${arr(r.items).map(x=>`${esc(short(x.name,90))} ×${Number(x.quantity)||0}`).join('<span class="aco-native-sep"> · </span>')||'—'}</td><td>${r.orderTotalKnown===true?amount(r.orderTotal):amount(r.orderTotal)}${r.orderTotalKnown===false?'<small>Not yet verified</small>':''}</td></tr>`).join('')}</tbody></table></div>`;
}
function drawOrderList(){const box=$('acoOrderList');if(!box)return;const rows=orderRows();$('acoOrderCount').textContent=rows.length+' checkouts';box.innerHTML=rows.length?ordersTable(rows):empty('No verified checkouts match these filters.');}
function renderOrders(response){
 const savedFilters={period:$('acoOrderPeriod')?.value||filterPeriod,retailer:$('acoOrderRetailer')?.value||'all',query:$('acoOrderSearch')?.value||''};
 const overview=dataKey(response,'success-overview'),verify=dataKey(response,'checkout-paid-verification');
 if(!overview){sectionStatus('orders',errKey(response,'success-overview')||'Unable to load checkouts.',true);return;}
 resultBox('orders').innerHTML=`<div class="aco-native-stats"><div class="aco-native-stat"><small>Confirmed community checkouts</small><b>${esc(overview.communityTotals?.checkouts??0)}</b></div><div class="aco-native-stat"><small>Community spend</small><b>${amount(overview.communityTotals?.spent)}</b></div><div class="aco-native-stat"><small>Unmatched checkouts</small><b>${esc(overview.unmatchedCount??0)}</b></div></div>
 <div class="aco-native-filters"><label>Period<select id="acoOrderPeriod"><option value="1">24 hours</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="all">All time</option></select></label><label>Retailer<select id="acoOrderRetailer"><option value="all">All retailers</option><option value="target">Target</option><option value="walmart">Walmart</option><option value="pokemoncenter">Pokémon Center</option></select></label><label>Search<input type="search" id="acoOrderSearch" placeholder="Customer or product" autocomplete="off"></label><span id="acoOrderCount"></span></div>
 ${panel('Attributed checkouts',`<div id="acoOrderList"></div><p class="siteMuted">Order totals follow the website’s verified Discord checkout records. Unknown charges are not invented.</p>`)}
 ${panel('Price verification',verify?stats(verify):empty(errKey(response,'checkout-paid-verification')||'No verification data.'))}`;
 for(const [id,key] of [['acoOrderPeriod','period'],['acoOrderRetailer','retailer'],['acoOrderSearch','query']]){
  const el=$(id);if(el)el.value=savedFilters[key];
 }
 filterPeriod=savedFilters.period;drawOrderList();
}
function discountLine(d){return `<div class="aco-native-line"><div><strong>${esc(d.code||'Discount')}</strong><small>${esc(d.discountType==='fixed-price'?amount(d.fixedPrice):d.percent+'%')} · ${esc(d.tier==='all'?'All tiers':d.tier+' accounts')} · ${esc(d.recipientEmail|| (d.ogOnly?'OG customers':d.sitewide?'Site-wide':'Selected customers'))}</small><small>${esc(d.duration==='repeating'?'Repeats '+d.durationMonths+' months':d.duration||'')}</small></div><div class="aco-native-actions"><span class="aco-native-state">${d.active?'Active':'Inactive'}</span><button type="button" class="btn slim secondary" data-discount-edit="${esc(d.id)}">Edit</button><button type="button" class="btn slim plain" data-discount-toggle="${esc(d.id)}">${d.active?'Disable':'Enable'}</button><button type="button" class="btn slim plain" data-discount-remove="${esc(d.id)}">Delete</button></div></div>`;}
function renderMemberships(response){
 const liveTiers=arr(dataKey(response,'membership-prices')?.tiers);const tierOptions=(liveTiers.length?liveTiers:[{tier:1,profiles:1},{tier:2,profiles:2},{tier:3,profiles:3},{tier:4,profiles:5},{tier:5,profiles:10},{tier:6,profiles:20},{tier:7,profiles:50},{tier:8,profiles:100}]).map(p=>`<option value="${esc(p.tier)}">${esc(p.profiles)} profiles${p.amount?' · '+esc(amount(p.amount))+'/month':''}</option>`).join('');
 const codes=dataKey(response,'discount-codes'),gifted=dataKey(response,'gifted-memberships'),giftable=dataKey(response,'giftable-customers'),revenue=dataKey(response,'membership-revenue');
 const discounts=arr(codes?.codes),gifts=arr(gifted?.memberships),customers=arr(giftable?.customers);
 const discountFields=`<form id="acoDiscountForm" class="aco-native-form"><input type="hidden" name="id" value=""><label>Coupon code<input name="code" maxlength="40" required placeholder="WELCOME20"></label><label>Discount type<select name="discountType"><option value="percent">Percentage</option><option value="fixed-price">Fixed membership price</option></select></label><label>Percent<input name="percent" type="number" min="1" max="100" value="10"></label><label>Fixed price ($)<input name="fixedPrice" type="number" min="0.01" step="0.01"></label><label>Tier<select name="tier"><option value="all">All tiers</option>${tierOptions}</select></label><label>Audience<select name="audience"><option value="sitewide">Site-wide</option><option value="private">Specific customer</option><option value="og">OG members</option></select></label><label>Customer email (private)<input name="recipientEmail" type="email" autocomplete="off"></label><label>Duration<select name="duration"><option value="once">Once</option><option value="forever">Forever</option><option value="repeating">Months</option></select></label><label>Months<input name="durationMonths" type="number" min="1" max="36" value="1"></label><label>Max uses<input name="maxUses" type="number" min="1"></label><label>Expires at<input name="expiresAt" type="date"></label><label class="aco-native-check"><input name="appliesToRentals" type="checkbox"> Includes rentals</label><div class="aco-native-form-actions"><button class="btn primary" type="submit">Save discount</button><button class="btn plain" type="reset">Cancel / clear</button></div></form>`;
 const giftForm=`<form id="acoGiftForm" class="aco-native-form"><label>Customer<select name="customerId" required><option value="">Select a customer</option>${customers.map(c=>`<option value="${esc(c.id)}">${esc(c.email)}</option>`).join('')}</select></label><label>Tier<select name="tier">${tierOptions}</select></label><label>Duration<select name="unit"><option value="months">Months</option><option value="weeks">Weeks</option></select></label><label>Length<input name="quantity" type="number" min="1" max="12" value="1" required></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Grant membership</button></div></form>`;
 resultBox('memberships').innerHTML=`${panel('Monthly membership revenue',revenue?stats(revenue):empty(errKey(response,'membership-revenue')||'Unavailable'))}
 <div class="aco-native-columns">${panel('Discount codes',discounts.length?discounts.map(discountLine).join(''):empty('No discount codes yet.'),'<span class="aco-native-count">'+discounts.length+' codes</span>')}
 ${panel('Create / edit discount',discountFields)}</div>
 <div class="aco-native-columns">${panel('Gifted memberships',gifts.length?gifts.map(g=>`<div class="aco-native-line"><div><strong>${esc(g.customerEmail||g.customerAccountId)}</strong><small>${esc(g.tierName||g.tier+' profiles')} · Until ${esc(when(g.expiresAt))}</small></div><button type="button" class="btn slim plain" data-gift-remove="${esc(g.id)}">Revoke</button></div>`).join(''):empty('No gifted memberships.'),'<span class="aco-native-count">'+gifts.length+' gifts</span>')}
 ${panel('Grant free membership',giftForm)}</div>`;
}
function renderAccounts(response){
 const oldFilters={retailer:$('acoPoolRetailer')?.value||'all',status:$('acoPoolStatus')?.value||'all',query:$('acoPoolQuery')?.value||''};
 const p=dataKey(response,'managed-pool/search'),rows=arr(p?.profiles);
 resultBox('accounts').innerHTML=`<div class="aco-native-filters"><label>Retailer<select id="acoPoolRetailer"><option value="all">All retailers</option><option value="target">Target</option><option value="walmart">Walmart</option><option value="pokemoncenter">Pokémon Center</option></select></label><label>Status<select id="acoPoolStatus"><option value="all">All accounts</option><option value="available">Available</option><option value="linked">Linked</option><option value="held">Held</option><option value="needs_repair">Needs repair</option><option value="duplicate">Duplicates</option></select></label><label>Search<input id="acoPoolQuery" type="search" placeholder="Email, profile or ID" value=""></label><button class="btn secondary" type="button" id="acoPoolSearch">Find accounts</button></div>
 <div class="aco-native-stat-row"><strong>${esc(p?.total??0)} accounts found</strong><div><button type="button" class="btn slim plain" id="acoPoolPrevious" ${p?.page<=1?'disabled':''}>← Previous</button><span id="acoPoolPage" data-page="${esc(p?.page||1)}">${esc(p?.page||1)} / ${esc(p?.pageCount||1)}</span><button type="button" class="btn slim plain" id="acoPoolNext" ${p?.page>=p?.pageCount?'disabled':''}>Next →</button></div></div>
 ${panel('Retailer account inventory',rows.length?rows.map(x=>`<div class="aco-native-line"><div><strong>${esc(x.profileName||x.loginEmail||x.id)}</strong><small>${esc(x.retailer)} · ${esc(x.status||'unknown')} · ${esc(x.loginEmail)}</small><small>${x.assignedTo?'Assigned to '+esc(x.assignedTo.name):'Available in shared pool'}</small></div><div class="aco-native-actions">${x.status==='needs_repair'?`<button class="btn slim secondary" data-pool-repair="${esc(x.id)}">Mark repaired</button>`:''}${x.status==='held'?`<button class="btn slim secondary" data-pool-override="${esc(x.id)}">Override hold</button>`:''}</div></div>`).join(''):empty(errKey(response,'managed-pool/search')||'No matching accounts.'))}
 <p class="siteMuted">Select a customer under Customers to assign, edit or return accounts. The same website inventory and authorization rules apply.</p>`;
 for(const [id,key] of [['acoPoolRetailer','retailer'],['acoPoolStatus','status'],['acoPoolQuery','query']]){
  const el=$(id);if(el)el.value=oldFilters[key];
 }
}

function renderOperations(response){
 const notification=dataKey(response,'site-notification')?.notification;
 const discord=dataKey(response,'discord-success-status'),mailbox=dataKey(response,'managed-success-mailbox-status'),consent=dataKey(response,'signup-consent-log');
 const consentRecords=arr(consent?.records).length?consent.records:arr(consent?.entries);
 resultBox('operations').innerHTML=`<div class="aco-native-columns">${panel('Website broadcast',notification?.active?`<div class="aco-native-line"><div><strong>${esc(notification.title)}</strong><p>${esc(notification.message)}</p><small>${when(notification.createdAt)}</small></div><button class="btn slim plain" type="button" data-retract="${esc(notification.id)}">Retract</button></div>`:empty('No active broadcast.'),`<span class="aco-native-state">${notification?.active?'Active':'Off'}</span>`)}
 ${panel('Post a customer notification',`<form id="acoBroadcastForm" class="aco-native-form"><label>Title<input name="title" maxlength="80" required></label><label>Message<textarea name="message" rows="3" maxlength="400" required></textarea></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Publish to website</button></div></form>`)}</div>
 <div class="aco-native-columns">${panel('Discord success channel',discord?stats(discord):empty(errKey(response,'discord-success-status')||'Status not available'),'<button type="button" class="btn slim secondary" data-scan="discord">Scan now</button>')}
 ${panel('Success mailbox',mailbox?stats(mailbox):empty(errKey(response,'managed-success-mailbox-status')||'Unavailable'))}</div>
 ${panel('Signup and purchase consent log',`<strong>${esc(consentRecords.length)} recent records loaded</strong><p class="siteMuted">Consent records remain stored permanently on the website. This panel is read-only and does not alter your original audit log.</p>`)} `;
}
async function act(action,payload,{message='Confirm this change?'}={}){
 if(!confirm(message))return null;
 const result=await api.adminAction(action,payload);
 const p=$('siteNotice');if(p){p.textContent=result.message||'Changes saved to website.';p.dataset.error='false';}
 return result;
}
function formFields(form){return Object.fromEntries(new FormData(form).entries());}
root.addEventListener('click',async e=>{
 const go=e.target.closest('[data-go]');if(go){selectTab(go.dataset.go);return;}
 const discountEdit=e.target.closest('[data-discount-edit]');if(discountEdit){dirtySections.add('memberships');const d=arr(dataKey(memberSnapshot,'discount-codes')?.codes).find(c=>c.id===discountEdit.dataset.discountEdit);if(!d)return;selectTab('memberships');const form=$('acoDiscountForm');if(!form)return;for(const [key,value] of Object.entries({...d,id:d.id,audience:d.recipientEmail?'private':d.ogOnly?'og':'sitewide'})){const input=form.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value===true;else input.value=value??'';}}form.querySelector('[type=submit]').textContent='Update discount';form.scrollIntoView({block:'nearest'});return;}
 const toggle=e.target.closest('[data-discount-toggle]');if(toggle){const d=arr(dataKey(memberSnapshot,'discount-codes')?.codes).find(c=>c.id===toggle.dataset.discountToggle);if(!d)return;try{if(await act('discount-toggle',{id:d.id,active:!d.active},{message:`${d.active?'Disable':'Enable'} ${d.code}?`}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const remove=e.target.closest('[data-discount-remove]');if(remove){try{if(await act('discount-delete',{id:remove.dataset.discountRemove},{message:'Permanently delete this discount code from Stripe and the website?'}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const gift=e.target.closest('[data-gift-remove]');if(gift){try{if(await act('gift-remove',{id:gift.dataset.giftRemove},{message:'Revoke this gifted membership? If billing was deferred, confirm the Stripe schedule separately.'}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const retract=e.target.closest('[data-retract]');if(retract){try{if(await act('site-notification-retract',{id:retract.dataset.retract},{message:'Retract this website notification?'}))await load('operations',true);}catch(err){alert(err.message);}return;}
 const scan=e.target.closest('[data-scan]');if(scan){try{if(await act('discord-success-scan',{},{message:'Request a fresh Discord success scan?'}))await load('operations',true);}catch(err){alert(err.message);}return;}
 const repair=e.target.closest('[data-pool-repair]');if(repair){try{if(await act('account-mark-repaired',{id:repair.dataset.poolRepair},{message:'Mark this retailer account repaired?'}))await load('accounts',true);}catch(err){alert(err.message);}return;}
 const override=e.target.closest('[data-pool-override]');if(override){try{if(await act('account-override-hold',{id:override.dataset.poolOverride},{message:'Override this account hold? This could make it available for assignment.'}))await load('accounts',true);}catch(err){alert(err.message);}return;}
 if(e.target.closest('#acoPoolSearch')){$('acoPoolPage').dataset.page='1';await load('accounts');return;}
 if(e.target.closest('#acoPoolNext')){$('acoPoolPage').dataset.page=String(Number($('acoPoolPage').dataset.page)+1);await load('accounts');return;}
 if(e.target.closest('#acoPoolPrevious')){$('acoPoolPage').dataset.page=String(Math.max(1,Number($('acoPoolPage').dataset.page)-1));await load('accounts');return;}
});
root.addEventListener('input',e=>{
 if(e.target.matches('#acoOrderSearch'))drawOrderList();
 const section=formSection[e.target.closest('form')?.id];if(section)dirtySections.add(section);
});
root.addEventListener('change',e=>{const section=formSection[e.target.closest('form')?.id];if(section)dirtySections.add(section);});
root.addEventListener('focusout',()=>setTimeout(()=>{
 if(pendingSections.has(active)&&!deferLive(active))void load(active,true);
},50));
root.addEventListener('change',e=>{if(e.target.matches('#acoOrderRetailer,#acoOrderPeriod')){filterPeriod=$('acoOrderPeriod').value;drawOrderList();}});
root.addEventListener('reset',e=>{
 const section=formSection[e.target.id];if(section){dirtySections.delete(section);setTimeout(()=>{if(pendingSections.has(section))void load(section,true);},80);}
 if(e.target.id==='acoDiscountForm')setTimeout(()=>{const f=$('acoDiscountForm');if(f){f.elements.namedItem('id').value='';f.querySelector('[type=submit]').textContent='Save discount';}},0);
});
root.addEventListener('submit',async e=>{
 if(!['acoDiscountForm','acoGiftForm','acoBroadcastForm'].includes(e.target.id))return;
 e.preventDefault();if(editing)return;editing=true;
 const form=e.target,save=form.querySelector('button[type=submit]'),data=formFields(form);save.disabled=true;
 try{
  const action=form.id==='acoDiscountForm'?'discount-save':form.id==='acoGiftForm'?'gift-create':'site-notification';
  if(action==='discount-save')data.appliesToRentals=form.elements.namedItem('appliesToRentals').checked;
  const options={message:action==='gift-create'?'Grant this customer a free membership? This can affect the Stripe renewal date.':action==='discount-save'?'Save this discount in Stripe and website Admin?':'Publish this notification to all website customers?'};
  const result=await act(action,data,options);
  if(result){const section=formSection[form.id];dirtySections.delete(section);form.reset();await load(section,true);}
 }catch(err){alert(err.message||'Website did not save this change.');}
 finally{save.disabled=false;editing=false;const section=formSection[form.id];if(pendingSections.has(section))void load(section,true);}
});
// Avoid reloading while a user is editing a form, opening a disclosure or navigating.
function refreshLive(){if(refreshTimer)clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{refreshTimer=null;if(active==='customers')return;void load(active,true);},1250);}
api.onChange?.(refreshLive);
document.addEventListener('jigstudio:customers-updated',event=>{if(event.detail?.connected&&!connected){connected=true;void load(active,true);}if(!event.detail?.connected)connected=false;});
// Customer edits are sent to the same website Admin route, not a second local copy.
const mainForm=document.createElement('form');mainForm.className='aco-native-profile-form aco-native-card';mainForm.id='acoMainCustomerProfile';mainForm.hidden=true;
mainForm.innerHTML=`<header><h3>Edit main customer details</h3><small>Saved directly to the existing website Admin customer record</small></header><div class="aco-native-form"><label>First name<input name="firstName" maxlength="80" required></label><label>Last name<input name="lastName" maxlength="80" required></label><label>Phone<input name="phone" maxlength="35"></label><label>Address<input name="address" maxlength="180" required></label><label>Address line 2<input name="address2" maxlength="180"></label><label>City<input name="city" maxlength="150" required></label><label>State<input name="state" maxlength="20" required></label><label>ZIP / ZIP+4<input name="zip" maxlength="10" required></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Save to website</button><span id="acoProfileFeedback" role="status"></span></div></div>`;
const customerActions=document.createElement('section');customerActions.className='aco-native-card aco-native-customer-actions';customerActions.id='acoCustomerActions';customerActions.hidden=true;
customerActions.innerHTML=`<header><h3>Customer actions</h3><small>Confirmed website actions, synchronized live</small></header>
<div class="aco-native-actions"><button type="button" class="btn slim secondary" id="acoNotifyMissingCustomer">Notify missing information</button><button type="button" class="btn slim plain" id="acoGrantOgCustomer">Grant OG status</button></div>
<form class="aco-native-form" id="acoCustomerMessage"><label class="aco-native-message-field">Send a message to this customer<textarea name="message" maxlength="1200" rows="2" placeholder="Type the customer notification" required></textarea></label><div class="aco-native-form-actions"><button class="btn primary" type="submit">Send customer message</button><span id="acoCustomerActionFeedback" role="status"></span></div></form>`;
const target=root.querySelector('#siteCustomerView .siteDetailGrid');if(target)target.before(mainForm,customerActions);
let activeOrderId='',activeCustomerId='',customerDraftDirty=false;
mainForm.addEventListener('input',()=>{customerDraftDirty=true;});
document.addEventListener('jigstudio:customer-opened',event=>{
 const {customer}=event.detail||{};
 const different=activeOrderId!==String(customer?.orderId||'');
 activeOrderId=String(customer?.orderId||'');activeCustomerId=String(customer?.id||'');
 mainForm.hidden=!activeOrderId;customerActions.hidden=!activeOrderId;
 if(different)customerDraftDirty=false;
 if(!activeOrderId||customerDraftDirty)return;const a=customer?.shipping||{};
 for(const field of ['firstName','lastName','phone','address','address2','city','state','zip']){const i=mainForm.elements.namedItem(field);if(i&&document.activeElement!==i)i.value=String(a[field]||'');}
});
mainForm.addEventListener('submit',async e=>{
 e.preventDefault();if(!activeOrderId||editing)return;const f=formFields(mainForm),button=mainForm.querySelector('[type=submit]');editing=true;button.disabled=true;
 try{const result=await act('customer-profile',{orderId:activeOrderId,profile:f},{message:'Save these customer details to the live website?'});
  if(result){customerDraftDirty=false;$('acoProfileFeedback').textContent='Saved to website.';await window.JigWebsiteCustomers?.refresh?.();}
 }catch(err){$('acoProfileFeedback').textContent=err.message||'Save failed.';}
 finally{editing=false;button.disabled=false;}
});
$('acoNotifyMissingCustomer')?.addEventListener('click',async()=>{
 if(!activeOrderId)return;
 try{if(await act('customer-missing-info',{orderId:activeOrderId},{message:'Send the current missing-information checklist to this customer?'})){
  $('acoCustomerActionFeedback').textContent='Website notification sent.';await window.JigWebsiteCustomers?.refresh?.();
 }}catch(error){$('acoCustomerActionFeedback').textContent=error.message||'Notification failed.';}
});
$('acoGrantOgCustomer')?.addEventListener('click',async()=>{
 if(!activeCustomerId)return;
 try{if(await act('customer-og',{customerId:activeCustomerId},{message:'Grant permanent OG status to this paid customer?'})){
  $('acoCustomerActionFeedback').textContent='OG status granted by website.';await window.JigWebsiteCustomers?.refresh?.();
 }}catch(error){$('acoCustomerActionFeedback').textContent=error.message||'OG update failed.';}
});
$('acoCustomerMessage')?.addEventListener('submit',async e=>{
 e.preventDefault();if(!activeOrderId||editing)return;
 const form=e.currentTarget,button=form.querySelector('[type=submit]');editing=true;button.disabled=true;
 try{const message=String(form.elements.namedItem('message')?.value||'').trim();
  if(await act('customer-message',{orderId:activeOrderId,message},{message:'Send this message to the selected customer?'})){
   form.reset();$('acoCustomerActionFeedback').textContent='Message sent by website.';
  }
 }catch(error){$('acoCustomerActionFeedback').textContent=error.message||'Unable to send message.';}
 finally{editing=false;button.disabled=false;}
});
selectTab('home');
})();
+(Number(v)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const centsAmount=v=>amount((Number(v)||0)/100);
const when=v=>{const d=new Date(v||'');return Number.isFinite(d.getTime())?d.toLocaleString():'—';};
const flatten=(v,prefix='',out=[],depth=0)=>{
 if(depth>2||!v||typeof v!=='object')return out;
 for(const [key,value] of Object.entries(v)){
  if(['ok','records','communityRecords','memberships','codes','customers','profiles','items','notification','addresses','paymentMethods','unmatchedRecent'].includes(key))continue;
  const label=(prefix?prefix+' · ':'')+key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ');
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')out.push([label,value]);
  else if(value&&typeof value==='object'&&!Array.isArray(value))flatten(value,label,out,depth+1);
  if(out.length>20)break;
 }
 return out;
};
const readKey=(data,key)=>data?.items?.find(item=>item.key===key);
const dataKey=(data,key)=>readKey(data,key)?.data;
const errKey=(data,key)=>readKey(data,key)?.error;
const sectionInfo=[
 ['home','Home','Revenue, activity and recent checkouts'],
 ['customers','Customers','Customer details, profiles, saved information'],
 ['orders','Orders','Verified checkouts and shipping status'],
 ['memberships','Memberships','Recurring revenue, discounts and gifted plans'],
 ['accounts','Retailer accounts','Available, linked and held inventory'],
 ['operations','Operations','Notifications, success channels and consent records']
];
const bar=document.createElement('nav');bar.className='aco-native-nav';bar.id='acoNativeSections';bar.setAttribute('aria-label','Admin sections');
for(const [id,title] of sectionInfo){const button=document.createElement('button');button.type='button';button.dataset.native=id;button.textContent=title;button.setAttribute('aria-controls','acoNative'+id);button.setAttribute('aria-current','false');bar.append(button);}
const panes=new Map();for(const [id,,desc] of sectionInfo){const section=document.createElement('section');section.id='acoNative'+id;section.className='aco-native-pane';section.hidden=id!=='home';section.innerHTML=id==='customers'?'':`<div class="aco-native-title"><div><div class="eyebrow">ADMIN / ${esc(id.toUpperCase())}</div><h2>${esc(sectionInfo.find(x=>x[0]===id)[1])}</h2><p>${esc(desc)}</p></div><button type="button" class="btn slim secondary" data-refresh="${esc(id)}">↻ Refresh</button></div><div class="aco-native-result" role="status">Connect Admin to load this section.</div>`;panes.set(id,section);}
const legacy=document.createElement('div');legacy.id='acoNativeCustomerWorkspace';legacy.append($('siteRosterView'),$('siteCustomerView'));panes.get('customers').append(legacy);
const anchor=$('siteNotice');anchor.before(bar,...panes.values());
let active='home',filterPeriod='7',ordersSnapshot=null,memberSnapshot=null,operationsSnapshot=null,poolSnapshot=null,dashboardSnapshot=null;
let connected=false,loading=new Set(),refreshTimer=null,editing=false;
const dirtySections=new Set(),pendingSections=new Set(),renderedFingerprints=new Map();
const editable='input,textarea,select,[contenteditable="true"]';
const formSection={acoDiscountForm:'memberships',acoGiftForm:'memberships',acoBroadcastForm:'operations'};
function focusedEditor(section){const focused=document.activeElement;return Boolean(focused&&panes.get(section)?.contains(focused)&&focused.matches?.(editable));}
function markPending(section){
 pendingSections.add(section);
 const pane=panes.get(section);if(!pane)return;
 let hint=pane.querySelector(':scope > .aco-native-live-pending');
 if(!hint){hint=document.createElement('div');hint.className='aco-native-live-pending';hint.setAttribute('role','status');
  hint.textContent='New website changes available — save or finish editing to refresh.';pane.querySelector('.aco-native-title')?.after(hint);}
 hint.hidden=false;
}
function clearPending(section){pendingSections.delete(section);const hint=panes.get(section)?.querySelector(':scope > .aco-native-live-pending');if(hint)hint.hidden=true;}
function deferLive(section){return dirtySections.has(section)||focusedEditor(section)||editing;}

function resultBox(section){return panes.get(section).querySelector('.aco-native-result');}
function sectionStatus(section,message,error=false){const p=resultBox(section);if(!p)return;p.textContent=message;p.classList.toggle('is-error',error);}
function groupData(item,field){return arr(item?.[field]);}
function panel(title,content='',extra=''){return `<section class="aco-native-card"><header><h3>${esc(title)}</h3>${extra}</header>${content}</section>`;}
function empty(text){return `<p class="aco-native-empty">${esc(text)}</p>`;}
function stats(data){return `<div class="aco-native-stats">${flatten(data).filter(([k,v])=>typeof v==='number'||typeof v==='string'&&v.length<70).slice(0,8).map(([key,value])=>`<div class="aco-native-stat"><small>${esc(key)}</small><b>${esc(value)}</b></div>`).join('')}</div>`;}
async function load(section,silent=false){
 if(!api?.adminRead||loading.has(section))return;
 if(silent&&deferLive(section)){markPending(section);return;}
 if(!silent&&dirtySections.has(section)&&!confirm('Discard unsaved Admin form changes and refresh?'))return;
 if(!silent)dirtySections.delete(section);
 loading.add(section);if(!silent)sectionStatus(section,'Loading current website data…');
 try{
  const view=section==='home'?'dashboard':section==='accounts'?'pool':section;
  const opts=view==='pool'?{status:$('acoPoolStatus')?.value||'all',retailer:$('acoPoolRetailer')?.value||'all',query:$('acoPoolQuery')?.value||'',page:Number($('acoPoolPage')?.dataset.page||1)}:{};
  const response=await api.adminRead(view,opts);
  const fingerprint=JSON.stringify(response.items);
  if(silent&&renderedFingerprints.get(section)===fingerprint){clearPending(section);connected=true;return;}
  // The network may finish after the owner has started typing. Never destroy a live form.
  if(silent&&deferLive(section)){markPending(section);connected=true;return;}
  if(section==='home'){dashboardSnapshot=response;renderHome(response);}
  if(section==='orders'){ordersSnapshot=response;renderOrders(response);}
  if(section==='memberships'){memberSnapshot=response;renderMemberships(response);}
  if(section==='accounts'){poolSnapshot=response;renderAccounts(response);}
  if(section==='operations'){operationsSnapshot=response;renderOperations(response);}
  renderedFingerprints.set(section,fingerprint);clearPending(section);connected=true;
 }catch(e){sectionStatus(section,e.message||'Unable to load Admin.',true);connected=false;}
 finally{loading.delete(section);}
}
function selectTab(id){
 if(!panes.has(id))id='home';active=id;
 for(const [key,node] of panes)node.hidden=key!==id;
 for(const button of bar.querySelectorAll('button'))button.setAttribute('aria-current',String(button.dataset.native===id));
 const headline=root.querySelector('.siteHeadline h1');if(headline)headline.textContent='Admin · '+sectionInfo.find(x=>x[0]===id)[1];
 if(id!=='customers')void load(id,true);
}
bar.addEventListener('click',e=>{const b=e.target.closest('[data-native]');if(b)selectTab(b.dataset.native);});
root.addEventListener('click',e=>{const b=e.target.closest('[data-refresh]');if(b)void load(b.dataset.refresh);});
function renderHome(response){
 const rev=dataKey(response,'membership-revenue'),orders=dataKey(response,'success-overview'),usage=dataKey(response,'app-usage'),notification=dataKey(response,'site-notification');
 const rows=arr(orders?.records).slice(0,8);
 const total=orders?.communityTotals||{};
 resultBox('home').innerHTML=`<div class="aco-native-stats"><div class="aco-native-stat"><small>Confirmed checkouts</small><b>${esc(total.checkouts??rows.length)}</b></div><div class="aco-native-stat"><small>Community spend</small><b>${amount(total.spent)}</b></div><div class="aco-native-stat"><small>Unmatched orders</small><b>${esc(orders?.unmatchedCount??'—')}</b></div><div class="aco-native-stat"><small>Membership billing</small><b>${esc(rev?.monthlyRevenueFormatted||rev?.totalMonthlyRevenueFormatted||rev?.monthlyTotalFormatted||'Open breakdown')}</b></div></div>
 <div class="aco-native-columns">${panel('Membership revenue',rev?stats(rev):empty(errKey(response,'membership-revenue')||'Revenue unavailable'))}
 ${panel('App usage',usage?stats(usage):empty(errKey(response,'app-usage')||'App usage unavailable'))}</div>
 ${panel('Recent checkouts',rows.length?ordersTable(rows):empty('No attributed orders loaded.'),'<button type="button" class="btn slim plain" data-go="orders">See all →</button>')}
 ${panel('Current website notification',notification?.notification?.active?`<strong>${esc(notification.notification.title)}</strong><p>${esc(notification.notification.message)}</p>`:empty('No active broadcast.'))}`;
}
function orderRows(){
 const all=arr(dataKey(ordersSnapshot,'success-overview')?.records);
 const keyword=String($('acoOrderSearch')?.value||'').trim().toLowerCase();
 const retailer=$('acoOrderRetailer')?.value||'all';
 const within=filterPeriod==='all'?0:Date.now()-Number(filterPeriod)*86400000;
 return all.filter(item=>(retailer==='all'||item.retailer===retailer)&&(!within||Date.parse(item.checkoutAt||'')>=within)&&(!keyword||[item.customerName,item.customerAccountId,item.retailer,...arr(item.items).map(x=>x.name)].join(' ').toLowerCase().includes(keyword)));
}
function ordersTable(items){
 return `<div class="aco-native-table-scroll"><table class="aco-native-table"><thead><tr><th>Checkout date</th><th>Customer · Profile</th><th>Retailer</th><th>Products in checkout</th><th>Total charged</th></tr></thead><tbody>${items.map(r=>`<tr><td>${esc(when(r.checkoutAt))}</td><td><strong>${esc(r.customerName||'Unmatched')}</strong><small>${esc(r.profileName||r.accountLabel||r.customerProfileName||'')}</small></td><td>${esc(r.retailer||'—')}</td><td>${arr(r.items).map(x=>`${esc(short(x.name,90))} ×${Number(x.quantity)||0}`).join('<span class="aco-native-sep"> · </span>')||'—'}</td><td>${r.orderTotalKnown===true?amount(r.orderTotal):amount(r.orderTotal)}${r.orderTotalKnown===false?'<small>Not yet verified</small>':''}</td></tr>`).join('')}</tbody></table></div>`;
}
function drawOrderList(){const box=$('acoOrderList');if(!box)return;const rows=orderRows();$('acoOrderCount').textContent=rows.length+' checkouts';box.innerHTML=rows.length?ordersTable(rows):empty('No verified checkouts match these filters.');}
function renderOrders(response){
 const savedFilters={period:$('acoOrderPeriod')?.value||filterPeriod,retailer:$('acoOrderRetailer')?.value||'all',query:$('acoOrderSearch')?.value||''};
 const overview=dataKey(response,'success-overview'),verify=dataKey(response,'checkout-paid-verification');
 if(!overview){sectionStatus('orders',errKey(response,'success-overview')||'Unable to load checkouts.',true);return;}
 resultBox('orders').innerHTML=`<div class="aco-native-stats"><div class="aco-native-stat"><small>Confirmed community checkouts</small><b>${esc(overview.communityTotals?.checkouts??0)}</b></div><div class="aco-native-stat"><small>Community spend</small><b>${amount(overview.communityTotals?.spent)}</b></div><div class="aco-native-stat"><small>Unmatched checkouts</small><b>${esc(overview.unmatchedCount??0)}</b></div></div>
 <div class="aco-native-filters"><label>Period<select id="acoOrderPeriod"><option value="1">24 hours</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="all">All time</option></select></label><label>Retailer<select id="acoOrderRetailer"><option value="all">All retailers</option><option value="target">Target</option><option value="walmart">Walmart</option><option value="pokemoncenter">Pokémon Center</option></select></label><label>Search<input type="search" id="acoOrderSearch" placeholder="Customer or product" autocomplete="off"></label><span id="acoOrderCount"></span></div>
 ${panel('Attributed checkouts',`<div id="acoOrderList"></div><p class="siteMuted">Order totals follow the website’s verified Discord checkout records. Unknown charges are not invented.</p>`)}
 ${panel('Price verification',verify?stats(verify):empty(errKey(response,'checkout-paid-verification')||'No verification data.'))}`;
 for(const [id,key] of [['acoOrderPeriod','period'],['acoOrderRetailer','retailer'],['acoOrderSearch','query']]){
  const el=$(id);if(el)el.value=savedFilters[key];
 }
 filterPeriod=savedFilters.period;drawOrderList();
}
function discountLine(d){return `<div class="aco-native-line"><div><strong>${esc(d.code||'Discount')}</strong><small>${esc(d.discountType==='fixed-price'?amount(d.fixedPrice):d.percent+'%')} · ${esc(d.tier==='all'?'All tiers':d.tier+' accounts')} · ${esc(d.recipientEmail|| (d.ogOnly?'OG customers':d.sitewide?'Site-wide':'Selected customers'))}</small><small>${esc(d.duration==='repeating'?'Repeats '+d.durationMonths+' months':d.duration||'')}</small></div><div class="aco-native-actions"><span class="aco-native-state">${d.active?'Active':'Inactive'}</span><button type="button" class="btn slim secondary" data-discount-edit="${esc(d.id)}">Edit</button><button type="button" class="btn slim plain" data-discount-toggle="${esc(d.id)}">${d.active?'Disable':'Enable'}</button><button type="button" class="btn slim plain" data-discount-remove="${esc(d.id)}">Delete</button></div></div>`;}
function renderMemberships(response){
 const liveTiers=arr(dataKey(response,'membership-prices')?.tiers);const tierOptions=(liveTiers.length?liveTiers:[{tier:1,profiles:1},{tier:2,profiles:2},{tier:3,profiles:3},{tier:4,profiles:5},{tier:5,profiles:10},{tier:6,profiles:20},{tier:7,profiles:50},{tier:8,profiles:100}]).map(p=>`<option value="${esc(p.tier)}">${esc(p.profiles)} profiles${p.amount?' · '+esc(amount(p.amount))+'/month':''}</option>`).join('');
 const codes=dataKey(response,'discount-codes'),gifted=dataKey(response,'gifted-memberships'),giftable=dataKey(response,'giftable-customers'),revenue=dataKey(response,'membership-revenue');
 const discounts=arr(codes?.codes),gifts=arr(gifted?.memberships),customers=arr(giftable?.customers);
 const discountFields=`<form id="acoDiscountForm" class="aco-native-form"><input type="hidden" name="id" value=""><label>Coupon code<input name="code" maxlength="40" required placeholder="WELCOME20"></label><label>Discount type<select name="discountType"><option value="percent">Percentage</option><option value="fixed-price">Fixed membership price</option></select></label><label>Percent<input name="percent" type="number" min="1" max="100" value="10"></label><label>Fixed price ($)<input name="fixedPrice" type="number" min="0.01" step="0.01"></label><label>Tier<select name="tier"><option value="all">All tiers</option>${tierOptions}</select></label><label>Audience<select name="audience"><option value="sitewide">Site-wide</option><option value="private">Specific customer</option><option value="og">OG members</option></select></label><label>Customer email (private)<input name="recipientEmail" type="email" autocomplete="off"></label><label>Duration<select name="duration"><option value="once">Once</option><option value="forever">Forever</option><option value="repeating">Months</option></select></label><label>Months<input name="durationMonths" type="number" min="1" max="36" value="1"></label><label>Max uses<input name="maxUses" type="number" min="1"></label><label>Expires at<input name="expiresAt" type="date"></label><label class="aco-native-check"><input name="appliesToRentals" type="checkbox"> Includes rentals</label><div class="aco-native-form-actions"><button class="btn primary" type="submit">Save discount</button><button class="btn plain" type="reset">Cancel / clear</button></div></form>`;
 const giftForm=`<form id="acoGiftForm" class="aco-native-form"><label>Customer<select name="customerId" required><option value="">Select a customer</option>${customers.map(c=>`<option value="${esc(c.id)}">${esc(c.email)}</option>`).join('')}</select></label><label>Tier<select name="tier">${tierOptions}</select></label><label>Duration<select name="unit"><option value="months">Months</option><option value="weeks">Weeks</option></select></label><label>Length<input name="quantity" type="number" min="1" max="12" value="1" required></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Grant membership</button></div></form>`;
 resultBox('memberships').innerHTML=`${panel('Monthly membership revenue',revenue?stats(revenue):empty(errKey(response,'membership-revenue')||'Unavailable'))}
 <div class="aco-native-columns">${panel('Discount codes',discounts.length?discounts.map(discountLine).join(''):empty('No discount codes yet.'),'<span class="aco-native-count">'+discounts.length+' codes</span>')}
 ${panel('Create / edit discount',discountFields)}</div>
 <div class="aco-native-columns">${panel('Gifted memberships',gifts.length?gifts.map(g=>`<div class="aco-native-line"><div><strong>${esc(g.customerEmail||g.customerAccountId)}</strong><small>${esc(g.tierName||g.tier+' profiles')} · Until ${esc(when(g.expiresAt))}</small></div><button type="button" class="btn slim plain" data-gift-remove="${esc(g.id)}">Revoke</button></div>`).join(''):empty('No gifted memberships.'),'<span class="aco-native-count">'+gifts.length+' gifts</span>')}
 ${panel('Grant free membership',giftForm)}</div>`;
}
function renderAccounts(response){
 const oldFilters={retailer:$('acoPoolRetailer')?.value||'all',status:$('acoPoolStatus')?.value||'all',query:$('acoPoolQuery')?.value||''};
 const p=dataKey(response,'managed-pool/search'),rows=arr(p?.profiles);
 resultBox('accounts').innerHTML=`<div class="aco-native-filters"><label>Retailer<select id="acoPoolRetailer"><option value="all">All retailers</option><option value="target">Target</option><option value="walmart">Walmart</option><option value="pokemoncenter">Pokémon Center</option></select></label><label>Status<select id="acoPoolStatus"><option value="all">All accounts</option><option value="available">Available</option><option value="linked">Linked</option><option value="held">Held</option><option value="needs_repair">Needs repair</option><option value="duplicate">Duplicates</option></select></label><label>Search<input id="acoPoolQuery" type="search" placeholder="Email, profile or ID" value=""></label><button class="btn secondary" type="button" id="acoPoolSearch">Find accounts</button></div>
 <div class="aco-native-stat-row"><strong>${esc(p?.total??0)} accounts found</strong><div><button type="button" class="btn slim plain" id="acoPoolPrevious" ${p?.page<=1?'disabled':''}>← Previous</button><span id="acoPoolPage" data-page="${esc(p?.page||1)}">${esc(p?.page||1)} / ${esc(p?.pageCount||1)}</span><button type="button" class="btn slim plain" id="acoPoolNext" ${p?.page>=p?.pageCount?'disabled':''}>Next →</button></div></div>
 ${panel('Retailer account inventory',rows.length?rows.map(x=>`<div class="aco-native-line"><div><strong>${esc(x.profileName||x.loginEmail||x.id)}</strong><small>${esc(x.retailer)} · ${esc(x.status||'unknown')} · ${esc(x.loginEmail)}</small><small>${x.assignedTo?'Assigned to '+esc(x.assignedTo.name):'Available in shared pool'}</small></div><div class="aco-native-actions">${x.status==='needs_repair'?`<button class="btn slim secondary" data-pool-repair="${esc(x.id)}">Mark repaired</button>`:''}${x.status==='held'?`<button class="btn slim secondary" data-pool-override="${esc(x.id)}">Override hold</button>`:''}</div></div>`).join(''):empty(errKey(response,'managed-pool/search')||'No matching accounts.'))}
 <p class="siteMuted">Select a customer under Customers to assign, edit or return accounts. The same website inventory and authorization rules apply.</p>`;
 for(const [id,key] of [['acoPoolRetailer','retailer'],['acoPoolStatus','status'],['acoPoolQuery','query']]){
  const el=$(id);if(el)el.value=oldFilters[key];
 }
}

function renderOperations(response){
 const notification=dataKey(response,'site-notification')?.notification;
 const discord=dataKey(response,'discord-success-status'),mailbox=dataKey(response,'managed-success-mailbox-status'),consent=dataKey(response,'signup-consent-log');
 const consentRecords=arr(consent?.records).length?consent.records:arr(consent?.entries);
 resultBox('operations').innerHTML=`<div class="aco-native-columns">${panel('Website broadcast',notification?.active?`<div class="aco-native-line"><div><strong>${esc(notification.title)}</strong><p>${esc(notification.message)}</p><small>${when(notification.createdAt)}</small></div><button class="btn slim plain" type="button" data-retract="${esc(notification.id)}">Retract</button></div>`:empty('No active broadcast.'),`<span class="aco-native-state">${notification?.active?'Active':'Off'}</span>`)}
 ${panel('Post a customer notification',`<form id="acoBroadcastForm" class="aco-native-form"><label>Title<input name="title" maxlength="80" required></label><label>Message<textarea name="message" rows="3" maxlength="400" required></textarea></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Publish to website</button></div></form>`)}</div>
 <div class="aco-native-columns">${panel('Discord success channel',discord?stats(discord):empty(errKey(response,'discord-success-status')||'Status not available'),'<button type="button" class="btn slim secondary" data-scan="discord">Scan now</button>')}
 ${panel('Success mailbox',mailbox?stats(mailbox):empty(errKey(response,'managed-success-mailbox-status')||'Unavailable'))}</div>
 ${panel('Signup and purchase consent log',`<strong>${esc(consentRecords.length)} recent records loaded</strong><p class="siteMuted">Consent records remain stored permanently on the website. This panel is read-only and does not alter your original audit log.</p>`)} `;
}
async function act(action,payload,{message='Confirm this change?'}={}){
 if(!confirm(message))return null;
 const result=await api.adminAction(action,payload);
 const p=$('siteNotice');if(p){p.textContent=result.message||'Changes saved to website.';p.dataset.error='false';}
 return result;
}
function formFields(form){return Object.fromEntries(new FormData(form).entries());}
root.addEventListener('click',async e=>{
 const go=e.target.closest('[data-go]');if(go){selectTab(go.dataset.go);return;}
 const discountEdit=e.target.closest('[data-discount-edit]');if(discountEdit){dirtySections.add('memberships');const d=arr(dataKey(memberSnapshot,'discount-codes')?.codes).find(c=>c.id===discountEdit.dataset.discountEdit);if(!d)return;selectTab('memberships');const form=$('acoDiscountForm');if(!form)return;for(const [key,value] of Object.entries({...d,id:d.id,audience:d.recipientEmail?'private':d.ogOnly?'og':'sitewide'})){const input=form.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value===true;else input.value=value??'';}}form.querySelector('[type=submit]').textContent='Update discount';form.scrollIntoView({block:'nearest'});return;}
 const toggle=e.target.closest('[data-discount-toggle]');if(toggle){const d=arr(dataKey(memberSnapshot,'discount-codes')?.codes).find(c=>c.id===toggle.dataset.discountToggle);if(!d)return;try{if(await act('discount-toggle',{id:d.id,active:!d.active},{message:`${d.active?'Disable':'Enable'} ${d.code}?`}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const remove=e.target.closest('[data-discount-remove]');if(remove){try{if(await act('discount-delete',{id:remove.dataset.discountRemove},{message:'Permanently delete this discount code from Stripe and the website?'}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const gift=e.target.closest('[data-gift-remove]');if(gift){try{if(await act('gift-remove',{id:gift.dataset.giftRemove},{message:'Revoke this gifted membership? If billing was deferred, confirm the Stripe schedule separately.'}))await load('memberships',true);}catch(err){alert(err.message);}return;}
 const retract=e.target.closest('[data-retract]');if(retract){try{if(await act('site-notification-retract',{id:retract.dataset.retract},{message:'Retract this website notification?'}))await load('operations',true);}catch(err){alert(err.message);}return;}
 const scan=e.target.closest('[data-scan]');if(scan){try{if(await act('discord-success-scan',{},{message:'Request a fresh Discord success scan?'}))await load('operations',true);}catch(err){alert(err.message);}return;}
 const repair=e.target.closest('[data-pool-repair]');if(repair){try{if(await act('account-mark-repaired',{id:repair.dataset.poolRepair},{message:'Mark this retailer account repaired?'}))await load('accounts',true);}catch(err){alert(err.message);}return;}
 const override=e.target.closest('[data-pool-override]');if(override){try{if(await act('account-override-hold',{id:override.dataset.poolOverride},{message:'Override this account hold? This could make it available for assignment.'}))await load('accounts',true);}catch(err){alert(err.message);}return;}
 if(e.target.closest('#acoPoolSearch')){$('acoPoolPage').dataset.page='1';await load('accounts');return;}
 if(e.target.closest('#acoPoolNext')){$('acoPoolPage').dataset.page=String(Number($('acoPoolPage').dataset.page)+1);await load('accounts');return;}
 if(e.target.closest('#acoPoolPrevious')){$('acoPoolPage').dataset.page=String(Math.max(1,Number($('acoPoolPage').dataset.page)-1));await load('accounts');return;}
});
root.addEventListener('input',e=>{
 if(e.target.matches('#acoOrderSearch'))drawOrderList();
 const section=formSection[e.target.closest('form')?.id];if(section)dirtySections.add(section);
});
root.addEventListener('change',e=>{const section=formSection[e.target.closest('form')?.id];if(section)dirtySections.add(section);});
root.addEventListener('focusout',()=>setTimeout(()=>{
 if(pendingSections.has(active)&&!deferLive(active))void load(active,true);
},50));
root.addEventListener('change',e=>{if(e.target.matches('#acoOrderRetailer,#acoOrderPeriod')){filterPeriod=$('acoOrderPeriod').value;drawOrderList();}});
root.addEventListener('reset',e=>{
 const section=formSection[e.target.id];if(section){dirtySections.delete(section);setTimeout(()=>{if(pendingSections.has(section))void load(section,true);},80);}
 if(e.target.id==='acoDiscountForm')setTimeout(()=>{const f=$('acoDiscountForm');if(f){f.elements.namedItem('id').value='';f.querySelector('[type=submit]').textContent='Save discount';}},0);
});
root.addEventListener('submit',async e=>{
 if(!['acoDiscountForm','acoGiftForm','acoBroadcastForm'].includes(e.target.id))return;
 e.preventDefault();if(editing)return;editing=true;
 const form=e.target,save=form.querySelector('button[type=submit]'),data=formFields(form);save.disabled=true;
 try{
  const action=form.id==='acoDiscountForm'?'discount-save':form.id==='acoGiftForm'?'gift-create':'site-notification';
  if(action==='discount-save')data.appliesToRentals=form.elements.namedItem('appliesToRentals').checked;
  const options={message:action==='gift-create'?'Grant this customer a free membership? This can affect the Stripe renewal date.':action==='discount-save'?'Save this discount in Stripe and website Admin?':'Publish this notification to all website customers?'};
  const result=await act(action,data,options);
  if(result){const section=formSection[form.id];dirtySections.delete(section);form.reset();await load(section,true);}
 }catch(err){alert(err.message||'Website did not save this change.');}
 finally{save.disabled=false;editing=false;const section=formSection[form.id];if(pendingSections.has(section))void load(section,true);}
});
// Avoid reloading while a user is editing a form, opening a disclosure or navigating.
function refreshLive(){if(refreshTimer)clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{refreshTimer=null;if(active==='customers')return;void load(active,true);},1250);}
api.onChange?.(refreshLive);
document.addEventListener('jigstudio:customers-updated',event=>{if(event.detail?.connected&&!connected){connected=true;void load(active,true);}if(!event.detail?.connected)connected=false;});
// Customer edits are sent to the same website Admin route, not a second local copy.
const mainForm=document.createElement('form');mainForm.className='aco-native-profile-form aco-native-card';mainForm.id='acoMainCustomerProfile';mainForm.hidden=true;
mainForm.innerHTML=`<header><h3>Edit main customer details</h3><small>Saved directly to the existing website Admin customer record</small></header><div class="aco-native-form"><label>First name<input name="firstName" maxlength="80" required></label><label>Last name<input name="lastName" maxlength="80" required></label><label>Phone<input name="phone" maxlength="35"></label><label>Address<input name="address" maxlength="180" required></label><label>Address line 2<input name="address2" maxlength="180"></label><label>City<input name="city" maxlength="150" required></label><label>State<input name="state" maxlength="20" required></label><label>ZIP / ZIP+4<input name="zip" maxlength="10" required></label><div class="aco-native-form-actions"><button type="submit" class="btn primary">Save to website</button><span id="acoProfileFeedback" role="status"></span></div></div>`;
const customerActions=document.createElement('section');customerActions.className='aco-native-card aco-native-customer-actions';customerActions.id='acoCustomerActions';customerActions.hidden=true;
customerActions.innerHTML=`<header><h3>Customer actions</h3><small>Confirmed website actions, synchronized live</small></header>
<div class="aco-native-actions"><button type="button" class="btn slim secondary" id="acoNotifyMissingCustomer">Notify missing information</button><button type="button" class="btn slim plain" id="acoGrantOgCustomer">Grant OG status</button></div>
<form class="aco-native-form" id="acoCustomerMessage"><label class="aco-native-message-field">Send a message to this customer<textarea name="message" maxlength="1200" rows="2" placeholder="Type the customer notification" required></textarea></label><div class="aco-native-form-actions"><button class="btn primary" type="submit">Send customer message</button><span id="acoCustomerActionFeedback" role="status"></span></div></form>`;
const target=root.querySelector('#siteCustomerView .siteDetailGrid');if(target)target.before(mainForm,customerActions);
let activeOrderId='',activeCustomerId='',customerDraftDirty=false;
mainForm.addEventListener('input',()=>{customerDraftDirty=true;});
document.addEventListener('jigstudio:customer-opened',event=>{
 const {customer}=event.detail||{};
 const different=activeOrderId!==String(customer?.orderId||'');
 activeOrderId=String(customer?.orderId||'');activeCustomerId=String(customer?.id||'');
 mainForm.hidden=!activeOrderId;customerActions.hidden=!activeOrderId;
 if(different)customerDraftDirty=false;
 if(!activeOrderId||customerDraftDirty)return;const a=customer?.shipping||{};
 for(const field of ['firstName','lastName','phone','address','address2','city','state','zip']){const i=mainForm.elements.namedItem(field);if(i&&document.activeElement!==i)i.value=String(a[field]||'');}
});
mainForm.addEventListener('submit',async e=>{
 e.preventDefault();if(!activeOrderId||editing)return;const f=formFields(mainForm),button=mainForm.querySelector('[type=submit]');editing=true;button.disabled=true;
 try{const result=await act('customer-profile',{orderId:activeOrderId,profile:f},{message:'Save these customer details to the live website?'});
  if(result){customerDraftDirty=false;$('acoProfileFeedback').textContent='Saved to website.';await window.JigWebsiteCustomers?.refresh?.();}
 }catch(err){$('acoProfileFeedback').textContent=err.message||'Save failed.';}
 finally{editing=false;button.disabled=false;}
});
$('acoNotifyMissingCustomer')?.addEventListener('click',async()=>{
 if(!activeOrderId)return;
 try{if(await act('customer-missing-info',{orderId:activeOrderId},{message:'Send the current missing-information checklist to this customer?'})){
  $('acoCustomerActionFeedback').textContent='Website notification sent.';await window.JigWebsiteCustomers?.refresh?.();
 }}catch(error){$('acoCustomerActionFeedback').textContent=error.message||'Notification failed.';}
});
$('acoGrantOgCustomer')?.addEventListener('click',async()=>{
 if(!activeCustomerId)return;
 try{if(await act('customer-og',{customerId:activeCustomerId},{message:'Grant permanent OG status to this paid customer?'})){
  $('acoCustomerActionFeedback').textContent='OG status granted by website.';await window.JigWebsiteCustomers?.refresh?.();
 }}catch(error){$('acoCustomerActionFeedback').textContent=error.message||'OG update failed.';}
});
$('acoCustomerMessage')?.addEventListener('submit',async e=>{
 e.preventDefault();if(!activeOrderId||editing)return;
 const form=e.currentTarget,button=form.querySelector('[type=submit]');editing=true;button.disabled=true;
 try{const message=String(form.elements.namedItem('message')?.value||'').trim();
  if(await act('customer-message',{orderId:activeOrderId,message},{message:'Send this message to the selected customer?'})){
   form.reset();$('acoCustomerActionFeedback').textContent='Message sent by website.';
  }
 }catch(error){$('acoCustomerActionFeedback').textContent=error.message||'Unable to send message.';}
 finally{editing=false;button.disabled=false;}
});
selectTab('home');
})();
