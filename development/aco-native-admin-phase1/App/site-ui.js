/* Private website workspace. Production data comes only from the authorized Admin site bridge. */
(()=>{'use strict';
const api=window.desktopAPI?.site, workflow=window.JigSiteWorkflow,root=document.getElementById('sitePage');
if(!root)return;
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clean=x=>String(x??'').trim();
const list=x=>Array.isArray(x)?x:[];
const retailerLabel={target:'Target',walmart:'Walmart',pokemoncenter:'Pokémon Center'};
let roster=[],activeCustomer=null,customerDetail=null,pool=null,retailer='target',poolPage=1,poolSearch='';
let inFlight=false,queued=false,connected=false,generated=[],wizardOpen=false,baseline=false,lastSnapshot=null;
let websiteJigs=[],signInPoll=null,signInAttempts=0;
let notices=[],toastQueue=[],toastTimer=null,toastShowing=false,noticesLoaded=false;
const MAX_NOTICES=100;
function status(message,error=false){let v=$('siteNotice');v.textContent=message;v.dataset.error=String(error);v.style.borderColor=error?'#f99580':'#69d9c1';}
function setConnection(value){connected=Boolean(value);$('siteConnection').classList.toggle('ready',connected);$('siteConnection').textContent=connected?'● Live Admin connection':'Not connected';$('siteNotifications').disabled=!connected;}
function addr(a){if(!a)return 'Not provided';return [clean(a.address||a.addressLine1),clean(a.address2||a.addressLine2),[a.city,a.state,a.zip||a.zipCode].filter(Boolean).join(', ')].filter(Boolean).join(' · ')||'Not provided';}
const nameOf=a=>[clean(a.firstName),clean(a.lastName)].filter(Boolean).join(' ');
const hasAddress=a=>Boolean(clean(a?.address||a?.addressLine1)&&clean(a?.city)&&clean(a?.state)&&clean(a?.zip||a?.zipCode));
const tierCount=c=>Math.max(0,Math.min(100,Number(c?.tierCount)||0));
const linkedCount=c=>Object.values(c?.linkedCounts||{}).reduce((sum,n)=>sum+(Number(n)||0),0);
const blankCount=c=>Math.max(0,tierCount(c)-Math.max(0,...Object.values(c?.linkedCounts||{}).map(x=>Number(x)||0)));
const profileKey=c=>String(c.id||c.email);
const freezeView=()=>Boolean(document.activeElement?.closest?.('#siteWorkflow')&&wizardOpen);
function safeAnnouncement(title,detail){
 const item={id:Date.now()+'-'+Math.random().toString(36).slice(2,9),title:clean(title).slice(0,100),detail:clean(detail).slice(0,180),at:Date.now()};
 notices.unshift(item);notices=notices.slice(0,MAX_NOTICES);renderNotices();
 if(toastQueue.length<5)toastQueue.push(item);
 if(!toastShowing)showNextToast();
 persistNotices();
}
async function persistNotices(){try{await api?.saveNotices?.(notices);}catch{ /* OS secure storage may be unavailable; memory keeps current-session history. */ }}
async function loadNotices(){if(noticesLoaded)return;try{const stored=await api?.loadNotices?.();if(Array.isArray(stored)&&!notices.length){notices=stored;renderNotices();}noticesLoaded=true;}catch{}}
function renderNotices(){
 const badge=$('siteNoticeBadge');badge.textContent=String(notices.length);badge.hidden=!notices.length;
 $('siteNotificationList').innerHTML=notices.length?notices.map(x=>`<div class="siteNotificationEntry"><div><strong>${esc(x.title)}</strong><p>${esc(x.detail)}</p><time>${esc(new Date(x.at).toLocaleString())}</time></div><button type="button" data-dismiss-notice="${esc(x.id)}" class="siteDismiss" aria-label="Dismiss notification">×</button></div>`).join(''):'<p class="siteMuted">No notifications. Changes appear here while Jig Studio is connected.</p>';
}
function showNextToast(){
 if(toastShowing||!toastQueue.length)return;
 const item=toastQueue.shift(),toast=$('siteToast');toastShowing=true;
 toast.innerHTML=`<div><strong>${esc(item.title)}</strong><p>${esc(item.detail)}</p><small>Saved to Notifications</small></div><button type="button" aria-label="Dismiss popup" data-close-toast>×</button>`;
 toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(closeToast,10000);
}
function closeToast(){clearTimeout(toastTimer);$('siteToast').hidden=true;toastShowing=false;if(toastQueue.length)showNextToast();}
function describeChanges(oldRecords,nextRecords){
 if(!baseline)return;
 const oldMap=new Map(oldRecords.map(c=>[profileKey(c),c]));
 const newMap=new Map(nextRecords.map(c=>[profileKey(c),c]));
 for(const [key,c] of newMap){
  const before=oldMap.get(key);
  if(!before){safeAnnouncement('New customer registered',`${c.name} was added to the website customer directory.`);continue;}
  if(tierCount(before)!==tierCount(c))safeAnnouncement('Membership profile allowance changed',`${c.name}: ${tierCount(before)} → ${tierCount(c)} profiles per retailer.`);
  for(const r of ['target','walmart','pokemoncenter']){
   const oldNum=Number(before.linkedCounts?.[r]||0),newNum=Number(c.linkedCounts?.[r]||0);
   if(oldNum!==newNum)safeAnnouncement('Linked account pool updated',`${c.name}: ${retailerLabel[r]} linked accounts ${oldNum} → ${newNum}.`);
  }
  if(blankCount(before)!==blankCount(c)&&tierCount(before)===tierCount(c))safeAnnouncement('Blank profile count changed',`${c.name}: ${blankCount(c)} profiles waiting.`);
  if(JSON.stringify(before.shipping)!==JSON.stringify(c.shipping))safeAnnouncement('Customer information updated',`${c.name}: website shipping details changed.`);
 }
 for(const [key,c] of oldMap)if(!newMap.has(key))safeAnnouncement('Customer directory changed',`${c.name} is no longer in the active customer directory.`);
}
function drawRoster(){
 const q=$('siteSearch').value.trim().toLowerCase();const all=roster.filter(c=>(c.name+' '+(c.email||'')).toLowerCase().includes(q));
 $('siteCustomers').textContent=String(roster.length);
 $('siteLinked').textContent=String(roster.reduce((s,c)=>s+linkedCount(c),0));
 $('siteSlots').textContent=String(roster.reduce((s,c)=>s+tierCount(c),0));
 $('siteBlank').textContent=String(roster.reduce((s,c)=>s+blankCount(c),0));
 const retailerBadges=c=>['target','walmart','pokemoncenter'].filter(k=>Number(c.linkedCounts?.[k])>0)
  .map(k=>'<span class="viceRetailerBadge '+k+'" title="'+esc(retailerLabel[k])+'">'+(k==='target'?'◎':k==='walmart'?'✳':'P')+' <sup>'+esc(c.linkedCounts[k])+'</sup></span>').join('')||'<span class="viceNoRetailer">No linked accounts</span>';
 $('siteCustomerRows').innerHTML=all.length?all.map(c=>{
  const initials=(c.name||'?').split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase();
  return '<article class="siteCustomerRow"><div class="viceCustomerIdentity"><span class="viceCustomerAvatar">'+esc(initials)+'</span><span><strong>'+esc(c.name)+'</strong><small>'+esc(c.email||'Website customer')+'</small></span></div>'+ 
   '<div class="viceRetailerBadges">'+retailerBadges(c)+'</div>'+ 
   '<div class="viceProfileCount"><strong>'+esc(tierCount(c))+'</strong><small>'+esc(linkedCount(c))+' retailer links</small></div>'+ 
   '<div><span class="viceCustomerStatus '+(c.paid?'active':'inactive')+'">'+(c.paid?'● Membership':'○ Registered')+'</span></div>'+ 
   '<div class="viceCustomerActions"><button class="btn slim secondary" data-customer="'+esc(c.id)+'" type="button">Open</button><button class="btn slim plain" data-studio-customer="'+esc(c.id)+'" type="button" title="Open Profile Studio">↗</button></div></article>';
 }).join(''):'<div class="siteEmpty">'+(roster.length?'No customers match your search.':'Connect to the website Admin to load your customer directory.')+'</div>';
}

function savedAddresses(){
 let saved=list(customerDetail?.saved?.addresses).filter(hasAddress).map(x=>({...x,phone:clean(x.phone||activeCustomer?.shipping?.phone||activeCustomer?.billing?.phone),id:clean(x.id)||'saved-'+Math.random().toString(36).slice(2)}));
 if(!saved.length&&hasAddress(activeCustomer?.shipping))saved=[{...activeCustomer.shipping,id:'base-shipping',label:'Customer-supplied profile address'}];
 return saved;
}
function billingAddresses(){
 let saved=savedAddresses();const bill=activeCustomer?.billing;
 if(hasAddress(bill)&&!saved.some(a=>addr(a)===addr(bill)))saved=[...saved,{...bill,phone:clean(bill.phone||activeCustomer?.shipping?.phone),id:'base-billing',label:'Billing address'}];
 return saved;
}
function cards(){return list(customerDetail?.saved?.paymentMethods);}
function currentLinked(r=retailer){return list(customerDetail?.linked).filter(x=>x.retailer===r&&x.active===true);}
function currentSlots(r=retailer){const records=currentLinked(r);return Array.from({length:Math.max(tierCount(activeCustomer),records.length)},(_,i)=>({slot:i+1,linked:records[i]||null}));}
function drawAddresses(){
 const sources=savedAddresses();const items=sources.map((a,i)=>`<div class="siteAddrCard"><strong>${esc(a.label||'Shipping '+(i+1))}</strong><div>${esc(nameOf(a))}</div><div>${esc(addr(a))}</div></div>`);
 if(!sources.length)items.push('<div class="siteAddrCard">No complete shipping address was provided. Add one on the website before creating profiles.</div>');
 if(hasAddress(activeCustomer?.billing))items.push(`<div class="siteAddrCard"><strong>Billing details</strong>${esc(addr(activeCustomer.billing))}</div>`);
 items.push(`<div class="siteAddrCard"><strong>Saved payment references</strong>${cards().length} card${cards().length===1?'':'s'} available. Card numbers and CVVs remain in the site's protected vault.</div>`);
 for(const [index,card] of cards().entries()){
   const label=card.label||card.brand||'Payment method '+(index+1);
   const masked=card.last4?'ending '+card.last4:'number hidden';
   const expires=[card.expMonth,card.expYear].filter(Boolean).join('/');
   items.push(`<div class="siteAddrCard"><strong>${esc(label)}</strong>${esc([card.cardholder,masked,expires?'Expires '+expires:''].filter(Boolean).join(' | '))}</div>`);
 }
 $('siteAddresses').innerHTML=items.join('');
 const source=$('siteAddressSource'),prior=source.value;source.replaceChildren(...sources.map((x,i)=>new Option(x.label||'Shipping '+(i+1),x.id)));
 if(sources.some(x=>x.id===prior))source.value=prior;
}
function drawSlots(){
 const slots=currentSlots();$('siteSlotsForCustomer').innerHTML=slots.length?slots.map(slot=>{
  const m=slot.linked;return `<div class="siteSlot ${m?'':'blank'}"><div><strong>${esc(retailerLabel[retailer])} #${slot.slot}</strong><small>${m?esc((m.loginEmail||m.profileName||'Linked account')+' · '+(m.activationStatus||'linked')+(m.jiggedAddress?' · '+addr(m.jiggedAddress):'')):'(blank profiles) · awaiting linked account'}</small></div><div class="buttons">${m?`<button class="btn plain slim" type="button" data-jig="${esc(m.id)}" data-type="${esc(m.type)}">Jig address</button><button class="btn plain slim" type="button" data-unlink="${esc(m.id)}" data-type="${esc(m.type)}" data-assignment="${esc(m.assignmentId)}">Return to pool</button>`:'<span class="siteMuted">Choose an available account below</span>'}</div></div>`;
 }).join(''):'<p class="siteMuted">This customer has no confirmed paid profile allowance.</p>';
}
function drawPool(){
 $('sitePoolCount').textContent=`${pool?.total??0} available ${retailerLabel[retailer]} account${pool?.total===1?'':'s'}. Linked accounts are unavailable for reuse.`;
 $('sitePoolPage').textContent=`Page ${pool?.page||1} of ${pool?.pageCount||1}`;
 $('sitePoolPrev').disabled=poolPage<=1;$('sitePoolNext').disabled=poolPage>=(pool?.pageCount||1);
 $('sitePoolResults').innerHTML=pool?.profiles?.length?pool.profiles.map(a=>`<div class="sitePoolResult"><strong>${esc(a.loginEmail||'Retailer account')}</strong><small>${esc(a.profileName||'Profile')} · ${esc(a.id)}</small><button class="btn secondary slim" type="button" data-assign="${esc(a.id)}">Assign to selected customer</button></div>`).join(''):'<div class="siteEmpty">No accounts currently available for this retailer and filter.</div>';
}
async function loadPool(reset=true){if(!activeCustomer||!$('sitePoolDisclosure').open)return;if(reset)poolPage=1;
 try{const old=pool?.total;const next=await api.read('pool',{retailer,status:'available',query:poolSearch,page:poolPage});pool=next;drawPool();
  if(baseline&&old!=null&&old!==next.total)safeAnnouncement('Available retailer pool updated',`${retailerLabel[retailer]} available accounts ${old} → ${next.total}.`);
 }catch(error){$('sitePoolResults').textContent=error.message||'Unable to load pool.';}
}
function showHome(){if($('siteUseLocalSavedCards'))$('siteUseLocalSavedCards').checked=false;window.JigStudioCards?.site?.clear();activeCustomer=null;customerDetail=null;generated=[];wizardOpen=false;$('siteWorkflow').hidden=true;$('siteGenerate').hidden=true;$('siteRosterView').hidden=false;$('siteCustomerView').hidden=true;drawRoster();}
async function openCustomer(customerId,{silent=false,keepView=false}={}){
 const c=roster.find(x=>x.id===customerId);if(!c)return;
 const changed=activeCustomer?.id!==customerId;
 if(changed){$('sitePoolDisclosure').open=false;pool=null;if($('siteUseLocalSavedCards'))$('siteUseLocalSavedCards').checked=false;window.JigStudioCards?.site?.clear();}
 activeCustomer=c;
 $('siteRosterView').hidden=true;$('siteCustomerView').hidden=false;
 $('siteCustomerName').textContent=c.name;
 $('siteCustomerMeta').textContent=`${c.email||'Customer'} · ${tierCount(c)} profiles per retailer · ${linkedCount(c)} linked retailer accounts`;
 $('siteCustomerSource').textContent=c.orderId?'Shipping, billing and card references are read from this customer’s website profile.':'No paid website order was found for this customer.';
 try{
  const previous=customerDetail;
  customerDetail=c.orderId?await api.read('customer',{orderId:c.orderId}):{saved:{addresses:[],paymentMethods:[]},linked:[]};
  if(previous&&!changed){
   if(JSON.stringify(previous.saved)!==JSON.stringify(customerDetail.saved))safeAnnouncement('Customer saved information changed',`${c.name}: website address or payment-method references were updated.`);
   const before=list(previous.linked).map(x=>[x.id,x.retailer,x.active,x.jiggedAddress].join(':')).sort().join('|');
   const after=list(customerDetail.linked).map(x=>[x.id,x.retailer,x.active,x.jiggedAddress].join(':')).sort().join('|');
   if(before!==after)safeAnnouncement('Customer linked accounts changed',`${c.name}: retailer assignments or linked addresses were updated.`);
  }
  drawAddresses();drawSlots();
  if($('siteLocalCardInfo')&&window.desktopAPI?.localCards){
   window.desktopAPI.localCards.list(c.id).then(result=>{
    if(activeCustomer?.id===c.id)$('siteLocalCardInfo').textContent=(result.cards.length||0)+' locally saved card(s) · '+(result.assignments.length||0)+' profile assignment(s) · encrypted on this device only.';
   }).catch(e=>{if(activeCustomer?.id===c.id)$('siteLocalCardInfo').textContent=e.message||'Local card storage unavailable.';});
  }
  if(changed||!keepView){generated=[];$('siteGenerate').hidden=true;$('siteWorkflow').hidden=true;wizardOpen=false;}
  await loadPool(false);
  if(!silent)status(`Opened ${c.name}. Click Create profiles to select shipping, billing, and payment references.`);
 }catch(error){status(error.message||'Could not load customer profile information.',true);}
}
function labeledChoice(source,kind,index){
 const label=kind==='card'?(clean(source.brand)||'Saved card')+(source.last4?' •••• '+source.last4:''):
  (source.label||`${kind==='ship'?'Shipping':'Billing'} ${index+1}`)+' · '+addr(source);
 return `<label class="siteChoiceLine"><input type="checkbox" name="${kind}" value="${index}" checked><span>${esc(label)}${kind==='card'?'<small>Website-managed payment method reference only</small>':''}</span></label>`;
}
function renderSources(){
 const ships=savedAddresses(),bills=billingAddresses(),cs=cards();
 $('siteShipChoices').innerHTML=ships.map((a,i)=>labeledChoice(a,'ship',i)).join('')||'<p class="siteMuted">No complete shipping address found.</p>';
 $('siteBillChoices').innerHTML=bills.map((a,i)=>labeledChoice(a,'bill',i)).join('')||'<p class="siteMuted">No saved billing address.</p>';
 $('siteCardChoices').innerHTML=cs.map((a,i)=>labeledChoice(a,'card',i)).join('')||'<p class="siteMuted">No saved card references. You can still create incomplete export drafts.</p>';
 $('siteShipAll').checked=ships.length>0;$('siteBillAll').checked=bills.length>0;$('siteCardAll').checked=cs.length>0;
 const hideBill=$('siteBillingSame').checked;
 $('siteBillChoices').classList.toggle('siteInactive',hideBill);$('siteBillAll').disabled=hideBill;
 for(const x of $('siteBillChoices').querySelectorAll('input'))x.disabled=hideBill;
}
function renderJigGroups(){
 const defs=list(workflow?.GROUPS),sections=[['line1','Address Line 1'],['line2','Address Line 2'],['postal','ZIP and city'],['advanced','Advanced local formatting tools']];
 $('siteJigChoices').innerHTML=sections.map(([id,title])=>{
  const relevant=defs.filter(x=>x.section===id);
  if(!relevant.length)return '';
  return `<section class="siteGroupPanel"><header>${esc(title)}</header>${relevant.map(g=>{
   return `<label class="siteGroupItem" data-disabled="false"><input type="checkbox" name="jigGroup" value="${esc(g.id)}"><span><strong>${esc(g.label)}</strong><small>${esc(g.description)}</small><span class="siteJigExample"><em>EXAMPLE</em><span>${esc(g.exampleBefore)}</span><b aria-hidden="true">→</b><span>${esc(g.exampleAfter)}</span></span>${g.experimental?'<small class="siteJigUnsupported">Optional local draft formatting. Review the resulting address before export.</small>':''}</span></label>`;
  }).join('')}</section>`;
 }).join('');
}
function openWizard({keep=false}={}){
 if(!activeCustomer)return;
 if(!tierCount(activeCustomer))return status('This customer has no current membership profiles to generate.',true);
 $('siteWizardRetailer').value=retailer;
 $('siteProfileCount').max=String(tierCount(activeCustomer));
 $('siteProfileLimit').textContent=`Membership allowance: 1–${tierCount(activeCustomer)} profiles`;
 if(!keep){$('siteProfileCount').value=String(Math.min(tierCount(activeCustomer),Math.max(1,currentLinked().length)));
  $('siteBillingSame').checked=true;$('siteRecipientNames').value='';renderSources();renderJigGroups();$('siteCombine').checked=false;}
 wizardOpen=true;$('siteWorkflow').hidden=false;$('siteGenerate').hidden=true;
 $('siteWorkflowTitle').textContent=`${retailerLabel[retailer]} · Create Shikari / Valor profiles`;
 $('siteWorkflow').scrollIntoView({behavior:'smooth',block:'start'});
}
function closeWizard(){wizardOpen=false;$('siteWorkflow').hidden=true;}
const checked=(id,source)=>Array.from($(id).querySelectorAll(`input[name="${source}"]:checked`)).map(input=>Number(input.value));
function pickIndexes(values,ids){return ids.map(i=>values[i]).filter(Boolean);}
function selectedJigGroups(){return Array.from($('siteJigChoices').querySelectorAll('input[name="jigGroup"]:checked:not(:disabled)')).map(x=>x.value);}
function selectedWebJigOptions(){
 const groups=new Set(selectedJigGroups());const convert=new Map([['street','Street types'],['direction','Directions'],['ordinal','Street numbers'],['unit','Apartment / unit'],['zip','ZIP formatting'],['city','Mailing cities']]);
 return websiteJigs.filter(x=>[...groups].some(g=>convert.get(g)===x.group)&&x.risk==='standard').map(x=>x.id).filter(id=>!['zip.four','city.alternate'].includes(id));
}
function generateDraft(){
 if(!workflow||!activeCustomer)throw Error('Profile generator is unavailable.');
 const quantity=Number($('siteProfileCount').value),limit=tierCount(activeCustomer),ships=pickIndexes(savedAddresses(),checked('siteShipChoices','ship'));
 const billSame=$('siteBillingSame').checked,bills=pickIndexes(billingAddresses(),checked('siteBillChoices','bill'));
 const chosenCards=pickIndexes(cards(),checked('siteCardChoices','card'));
 const names=$('siteRecipientNames').value.split(/\r?\n/).map(x=>x.trim());
 return workflow.create({count:quantity,limit,retailer,customerName:activeCustomer.name,shipping:ships,billing:bills,cards:chosenCards,
  sameBilling:billSame,names,groups:selectedJigGroups(),combine:$('siteCombine').checked,jigPhones:$('siteJigPhone').checked,linked:currentLinked()});
}
function drawGenerated(){
 $('siteGeneratedSummary').textContent=`${generated.length} ${retailerLabel[retailer]} draft profile${generated.length===1?'':'s'} prepared for export. Review the selections before saving.`;
 $('sitePreviewRows').innerHTML=generated.map((x,i)=>`<div class="sitePreviewRow"><b>#${x.slot}</b><div><strong>${esc(x.name)}</strong><small>${esc(nameOf(x.shipping)||'No recipient name')}</small><small>${esc(window.JigStudioCards?.site?.cardForIndex(i)?('Test card: '+window.JigStudioCards.site.cardForIndex(i).label+' •••• '+window.JigStudioCards.site.cardForIndex(i).number.slice(-4)):(x.cardRef?((x.cardRef.brand||'Card')+' •••• '+x.cardRef.last4):'No card chosen'))}</small></div><div>${esc(addr(x.shipping))}<small>Billing: ${esc(addr(x.billing))}</small><small>${x.applied.length?'Format: '+esc(x.applied.join(' + ')):'Original source address retained'}</small>${x.fractionalSuggestion?'<small class="siteJigUnsupported">Fraction alternative: '+esc(x.fractionalSuggestion)+' — REVIEW</small>':''}</div><div><span class="siteProfileBadge">${x.needsReview?'Address needs review':x.linked?'Linked retailer account':'Blank retailer slot'}</span><small>${esc(x.email||'Account email is blank until a retailer login is linked')}</small><small>${x.phone?(x.phoneJigged?'Jigged phone (not verified): ':'Phone: ')+esc(x.phone):'Phone missing — add it to this customer&#39;s saved information'}</small></div></div>`).join('');
 const options=$('siteAddressSource');options.replaceChildren(...savedAddresses().map((a,i)=>new Option(a.label||'Address '+(i+1),a.id)));
 $('siteGenerate').hidden=false;
}
async function doJig(){
 try{
  generated=generateDraft();window.JigStudioCards?.site?.resetAssignment();closeWizard();drawGenerated();$('siteGenerate').scrollIntoView({behavior:'smooth',block:'start'});
  const noUnique=generated.filter(x=>x.needsReview).length;
  const fractionCount=generated.filter(x=>x.fractionalSuggestion).length;
  status(`Created ${generated.length} local draft profile${generated.length===1?'':'s'}.${noUnique?` ${noUnique} need address review.`:''}${fractionCount?` ${fractionCount} fractional alternative(s) are shown for review.`:''} Website records and cards were not modified.`,false);
 }catch(e){status(e.message,true);}
}
async function exportDraft(){
 if(!generated.length)return status('Choose Create profiles and click Jig first.',true);
 const missing=generated.filter(x=>!x.email).length;
 const missingPhone=generated.filter(x=>!clean(x.phone||x.shipping?.phone)).length;
 const warning=(missing?` ${missing} draft profile(s) have no linked retailer login email.`:'')+(missingPhone?` ${missingPhone} draft profile(s) have no saved phone number; phone will be blank until you add one to the customer's saved information.`:'');
 const testCount=generated.filter((_,i)=>window.JigStudioCards?.site?.cardForIndex(i)).length;
 const useLocal=$('siteUseLocalSavedCards')?.checked===true;
 const paymentNotice=useLocal?' Full numbers from your ENCRYPTED LOCAL card vault will be written to an UNENCRYPTED export file. Custom reference codes are NOT card CVVs and will not be exported.':testCount?` ${testCount} profiles will contain FULL synthetic test card values in the UNENCRYPTED download. Never use live CVVs.`:' Website card numbers and CVVs are NOT copied into files.';
 if(!confirm(`Export ${generated.length} ${retailerLabel[retailer]} profiles in ${retailer==='target'?'Shikari CSV':'Valor JSON'} format?${warning}${paymentNotice}`))return;
 try{
  const result=await api.export({retailer,customerName:activeCustomer.name,profiles:generated.map((x,i)=>({email:x.email,phone:x.phone,shipping:x.shipping,billing:x.billing,
   syntheticCard:useLocal?null:window.JigStudioCards?.site?.cardForIndex(i)||null})),customerId:activeCustomer.id,useLocalSavedCards:useLocal,confirmUnencryptedExport:useLocal});
  if(result?.saved)status(`Exported ${result.profileCount} profiles to ${result.name}. ${result.localCardProfiles||0} use locally saved card numbers; ${result.syntheticPaymentProfiles||0} contain synthetic test cards; website payment secrets were not copied.`);
 }catch(e){status(e.message||'Export failed.',true);}
}
async function assign(id){
 if(!activeCustomer?.id||!activeCustomer.orderId)return status('A paid website membership is required for live account assignments.',true);
 if(!currentSlots().some(s=>!s.linked))return status('No blank profile slots remain for this retailer.',true);
 const selected=pool?.profiles?.find(x=>x.id===id&&x.status==='available');if(!selected)return status('The account is no longer available. Refresh the pool.',true);
 const type=$('siteAssignmentType').value||'free',duration=$('siteDuration').value||'indefinite';
 if(!confirm(`Assign ${selected.loginEmail} (${retailerLabel[retailer]}) to ${activeCustomer.name}? The site will remove it from the available pool.`))return;
 try{await api.assign({customerAccountId:activeCustomer.id,managedAccountId:id,retailer,assignmentType:type,durationType:duration});
  status('Assignment accepted by website. Refreshing linked records.');await sync(true);
 }catch(e){status(e.message,true);}
}
async function returnToPool(id,type,assignment){
 const match=list(customerDetail?.linked).find(x=>x.id===id&&x.type===type&&x.assignmentId===assignment);
 if(!match)return status('The account assignment has changed. Refresh before returning.',true);
 if(!confirm(`Return ${match.loginEmail||id} to the available pool? This removes its customer-specific associations.`))return;
 try{await api.returnToPool({managedAccountId:id,assignmentType:type,assignmentId:assignment,customerAccountId:activeCustomer.id});status('Returned to website available pool.');await sync(true);}catch(e){status(e.message,true);}
}
async function jigLinked(id,type){
 const selected=$('siteAddressSource').value;
 if(!selected||selected.startsWith('base-'))return status('Select a saved website shipping address with a record ID before applying a live jig.',true);
 const linked=list(customerDetail?.linked).find(x=>x.id===id&&x.type===type);
 if(!linked)return status('This account is no longer linked to this customer.',true);
 const selectedRules=selectedWebJigOptions();
 if(!selectedRules.length)return status('Choose at least one supported address group under Create profiles before jigging a linked account.',true);
 if(!confirm(`Apply website-supported address formatting to ${linked.loginEmail||id}, using the saved customer address? The website controls unique-address history and can reject unsuitable formats.`))return;
 try{const result=await api.jig({managedAccountId:id,assignmentType:type,savedAddressId:selected,jigOptions:selectedRules});status(result.message||'Address saved by website.');await sync(true);}catch(e){status(e.message,true);}
}
async function sync(manual=false){
 if(!api)return status('Website sync is only available in the private desktop app.',true);
 if(inFlight){queued=true;return;}
 inFlight=true;
 try{
  const response=await api.read('roster',{}),next=list(response.customers),previous=roster;
  setConnection(true);
  await loadNotices();
  describeChanges(previous,next);
  roster=next;baseline=true;document.dispatchEvent(new CustomEvent('jigstudio:customers-updated',{detail:{connected:true,count:roster.length}}));
  if(!websiteJigs.length){try{websiteJigs=list((await api.read('jigOptions',{})).options);}catch{/* Website may not have postal lookup configured. Local examples still work. */}}
  drawRoster();
  if(activeCustomer){
   const updated=roster.find(c=>c.id===activeCustomer.id);
   if(updated)await openCustomer(updated.id,{silent:true,keepView:true});
   else showHome();
  }
  if(manual)status(`Synced ${roster.length} customers at ${new Date().toLocaleTimeString()}. ${response.linkedInventoryComplete?'Linked account inventory is current.':'Some linked pool records may need a separate inventory refresh.'}`);
  stopSignInMonitor();
 }catch(e){setConnection(false);if(manual)status(e.message||'Admin sign-in required.',true);}
 finally{inFlight=false;if(queued){queued=false;setTimeout(()=>void sync(false),500);}}
}
function stopSignInMonitor(){if(signInPoll){clearInterval(signInPoll);signInPoll=null;}signInAttempts=0;}
function monitorSignIn(){stopSignInMonitor();void sync(false);signInPoll=setInterval(()=>{if(connected||++signInAttempts>120){stopSignInMonitor();return;}if(!inFlight)void sync(false);},1500);}
async function startLogin(){
 // Keep the native desktop Admin in front; launch the website only to authenticate.
 // After sign-in, the desktop uses its authenticated API bridge and live events.
 try{await (api.signIn?.()||api.open());status('Complete the secure website sign-in in the separate window. Your native Admin will sync automatically.');monitorSignIn();}catch(e){status(e.message,true);}
}
function onAll(id,target){$(id).addEventListener('change',e=>{for(const x of $(target).querySelectorAll('input[type="checkbox"]'))x.checked=e.target.checked;});}
function keepSelectAllCurrent(id,target){$(target).addEventListener('change',()=>{const all=Array.from($(target).querySelectorAll('input[type="checkbox"]:not(:disabled)'));$(id).checked=all.length>0&&all.every(x=>x.checked);});}
$('siteConnect').addEventListener('click',startLogin);
$('siteRefresh').addEventListener('click',()=>void sync(true));
$('siteSignout').addEventListener('click',async()=>{try{await api.logout();stopSignInMonitor();roster=[];activeCustomer=null;customerDetail=null;pool=null;baseline=false;document.dispatchEvent(new CustomEvent('jigstudio:customers-updated',{detail:{connected:false,count:0}}));window.JigStudioLocalImport?.clearWebsiteImports();notices=[];noticesLoaded=false;renderNotices();setConnection(false);showHome();status('Signed out. No website customer information will be shown until Admin authorization.');}catch(e){status(e.message,true);}});
$('siteSearch').addEventListener('input',drawRoster);
$('siteCustomerRows').addEventListener('click',e=>{
 const studio=e.target.closest('[data-studio-customer]');
 if(studio){window.JigStudioProfileImport?.openCustomer(studio.dataset.studioCustomer);return;}
 const target=e.target.closest('[data-customer]');if(target)void openCustomer(target.dataset.customer);
});
$('siteOpenInStudio')?.addEventListener('click',()=>{if(activeCustomer)window.JigStudioProfileImport?.openCustomer(activeCustomer.id);});
function openSavedLocalCards(){if(activeCustomer?.id)void window.JigStudioLocalCards?.open(activeCustomer.id,activeCustomer.name,tierCount(activeCustomer));}
$('siteLocalCardsManage')?.addEventListener('click',openSavedLocalCards);
$('siteLocalCardsOpenBottom')?.addEventListener('click',openSavedLocalCards);
$('viceRosterSync')?.addEventListener('click',()=>void sync(true));
$('siteBack').addEventListener('click',showHome);
$('siteRetailer').addEventListener('change',()=>{retailer=$('siteRetailer').value;drawSlots();void loadPool(true);if(wizardOpen)$('siteWizardRetailer').value=retailer;if(generated.length){generated=[];$('siteGenerate').hidden=true;}});
$('sitePoolDisclosure').addEventListener('toggle',()=>{if($('sitePoolDisclosure').open)void loadPool(true);});
$('sitePoolRefresh').addEventListener('click',()=>void loadPool());
$('sitePoolSearch').addEventListener('input',()=>{poolSearch=$('sitePoolSearch').value;clearTimeout(window.__sitePoolTimer);window.__sitePoolTimer=setTimeout(()=>void loadPool(true),300);});
$('sitePoolPrev').addEventListener('click',()=>{if(poolPage>1){poolPage--;void loadPool(false);}});
$('sitePoolNext').addEventListener('click',()=>{if(poolPage<(pool?.pageCount||1)){poolPage++;void loadPool(false);}});
$('sitePoolResults').addEventListener('click',e=>{const b=e.target.closest('[data-assign]');if(b)void assign(b.dataset.assign);});
$('siteSlotsForCustomer').addEventListener('click',e=>{const j=e.target.closest('[data-jig]');if(j){void jigLinked(j.dataset.jig,j.dataset.type);return;}const b=e.target.closest('[data-unlink]');if(b)void returnToPool(b.dataset.unlink,b.dataset.type,b.dataset.assignment);});
$('siteCreateProfiles').addEventListener('click',()=>openWizard());
$('siteWorkflowCancel').addEventListener('click',closeWizard);
$('siteWorkflowCancelTop').addEventListener('click',closeWizard);
$('siteWizardRetailer').addEventListener('change',()=>{retailer=$('siteWizardRetailer').value;$('siteRetailer').value=retailer;drawSlots();void loadPool(true);$('siteWorkflowTitle').textContent=retailerLabel[retailer]+' · Create Shikari / Valor profiles';});
$('siteWorkflowJig').addEventListener('click',()=>void doJig());
$('sitePreviewGenerate').addEventListener('click',()=>openWizard({keep:true}));
$('siteExport').addEventListener('click',()=>void exportDraft());
$('siteBillingSame').addEventListener('change',()=>{const hide=$('siteBillingSame').checked;$('siteBillChoices').classList.toggle('siteInactive',hide);$('siteBillAll').disabled=hide;for(const x of $('siteBillChoices').querySelectorAll('input'))x.disabled=hide;});
for(const [all,target] of [['siteShipAll','siteShipChoices'],['siteBillAll','siteBillChoices'],['siteCardAll','siteCardChoices']]){onAll(all,target);keepSelectAllCurrent(all,target);}
$('siteNotifications').addEventListener('click',()=>{$('siteNotificationTray').hidden=!$('siteNotificationTray').hidden;$('siteNotifications').setAttribute('aria-expanded',String(!$('siteNotificationTray').hidden));});
$('siteCloseNotifications').addEventListener('click',()=>{$('siteNotificationTray').hidden=true;$('siteNotifications').setAttribute('aria-expanded','false');});
$('siteClearNotifications').addEventListener('click',()=>{notices=[];renderNotices();persistNotices();});
$('siteNotificationList').addEventListener('click',e=>{const b=e.target.closest('[data-dismiss-notice]');if(b){notices=notices.filter(n=>n.id!==b.dataset.dismissNotice);renderNotices();persistNotices();}});
$('siteToast').addEventListener('click',e=>{if(e.target.closest('[data-close-toast]'))closeToast();});
if(api?.onChange)api.onChange(()=>{if(connected)void sync(false);else if(signInPoll)void sync(false);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&connected)void sync(false);});
setInterval(()=>{if(connected&&!document.hidden)void sync(false);},60000);
window.JigStudioWebsiteCards=Object.freeze({targets:()=>({count:generated.length,indices:generated.map((_,i)=>i)})});
window.addEventListener('jigstudio:cards-applied',event=>{if(event.detail?.scope==='site'&&generated.length)drawGenerated();});
window.JigWebsiteCustomers=Object.freeze({
 connected:()=>connected,
 list:()=>connected?roster.map(c=>({id:c.id,name:c.name,email:c.email,tierCount:tierCount(c),paid:c.paid})):[],
 signIn:()=>startLogin(),
 refresh:()=>sync(true),
 async detail(customerId){
  if(!connected)throw Error('Sign in to website Admin first.');
  const c=roster.find(x=>x.id===customerId);
  if(!c)throw Error('Customer no longer appears in the live roster. Refresh first.');
  if(!c.orderId)throw Error('This customer does not have a paid membership record to import.');
  const details=await api.read('customer',{orderId:c.orderId});
  return {customer:{id:c.id,name:c.name,email:c.email,tierCount:tierCount(c),paid:c.paid,
     shipping:c.shipping,billing:c.billing},saved:details.saved,linked:details.linked};
 }
});
renderNotices();renderJigGroups();setConnection(false);
})();
