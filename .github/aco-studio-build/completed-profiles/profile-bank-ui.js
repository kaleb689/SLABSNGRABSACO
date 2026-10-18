/* Compact, retailer-grouped per-customer completed profile banks. Imports are
 * scanned read-only before saving. Deletion/swap requires explicit confirmation. */
(()=>{'use strict';
 const d=document,$=id=>d.getElementById(id),api=window.desktopAPI?.profileBanks;
 if(!api||!$('jigPage'))return;
 const store={scope:'personal',customerId:null,profiles:[],websiteLinked:[],counts:{},scanned:null,scanImports:[],dirty:false,ready:false,activeRetailer:'all',stage:'in-progress',poolCounts:null};
 const panel=d.createElement('section');panel.id='profileBanksPanel';panel.className='panel profileBanksPanel';
 panel.innerHTML=`<div class="profileBanksHead"><div><div class="eyebrow">SEPARATE OS-ENCRYPTED PROFILE BANKS</div><h2>Retailer Profile Vault & Duplicate Scanner</h2><p>Finished profiles stay in Personal or in the exact selected customer's bank. No automatic cross-bank transfers.</p></div><button type="button" class="profileScanBadge" id="profileScanBadge" title="Review detected same-retailer duplicate accounts">Scan ready</button></div>
 <div class="profileBankActions"><label>Vault<select id="profileBankScope"><option value="personal">🔒 Personal · owner only</option><option value="aco">ACO customer profiles</option></select></label><label id="profileCustomerPicker" hidden>Membership customer<select id="profileCustomer"><option value="">Select a customer</option></select></label><label>Imported file retailer<select id="profileImportRetailer"><option value="target">Target</option><option value="walmart">Walmart</option><option value="pokemoncenter">Pokémon Center</option><option value="costco">Costco</option><option value="sams">Sam’s Club</option></select></label><button type="button" id="profileImportBank" class="btn primary slim">Import selected profile cards</button><button type="button" id="profileScanNow" class="btn secondary slim">Scan duplicate emails</button><button type="button" id="personalBankLock" class="btn plain slim">🔒 Lock Personal</button></div>
 <div class="profileBankSummary" id="profileBankSummary" role="status">Choose a vault and import your completed profile file.</div>
 <div class="profileBankRetailerTabs" id="profileBankRetailers"><button data-filter="all" aria-pressed="true">All</button><button data-filter="target">Target</button><button data-filter="walmart">Walmart</button><button data-filter="pokemoncenter">PKC</button><button data-filter="costco">Costco</button><button data-filter="sams">Sam’s</button></div>
 <div class="profileBankRetailerTabs" id="profileStageTabs"><button type="button" data-stage="in-progress" aria-pressed="true">In Progress</button><button type="button" data-stage="completed" aria-pressed="false">Completed Profiles</button></div><p id="profilePoolAvailability" role="status"></p><div class="profileBankSearchLine"><input type="search" id="profileBankSearch" placeholder="Search email or profile label" aria-label="Search profile vault" autocomplete="off"><span id="profileBankCount">No profiles</span></div><div class="profileBankRows" id="profileBankRows"></div>
 <details class="profileBankHelp"><summary>How imports, duplicate resolution and website accounts work ▾</summary><p>Open a CSV/JSON in Profile Studio, select its source vault/customer, choose its retailer, then click Import selected profile cards. Imports are scanned automatically first. The scan compares emails in files and encrypted banks, plus live website-linked retailer accounts when Admin is connected. A collision does not modify anything until you choose. Replacements may only use an unused completed profile in the same retailer and same vault/customer. Website-linked records must be managed through the authorized website Admin, never deleted by a local scanner.</p></details>`;
 const destination=$('studioJigBanks');destination.after(panel);
 const modal=d.createElement('div');modal.id='profileDuplicatesModal';modal.className='profileReviewModal';modal.hidden=true;modal.innerHTML=`<div class="profileReviewBox" role="dialog" aria-modal="true" aria-labelledby="profileReviewTitle"><div class="profileReviewHead"><div><div class="eyebrow">DUPLICATE PROFILE CHECK · READ ONLY</div><h2 id="profileReviewTitle">Review reused email accounts</h2><p id="profileReviewSub"></p></div><button class="btn plain slim" id="profileReviewClose" type="button">✕ Close</button></div><div class="profileReviewList" id="profileReviewList"></div><div class="profileReviewFooter"><small>Nothing is automatically removed or reassigned; no Personal records are copied to ACO or vice versa.</small><button class="btn primary slim" type="button" id="profileReviewDone">Close review</button></div></div>`;d.body.append(modal);
 const historyKey='aco-duplicate-notification-ledger-v1';
 const ledger=window.ACODuplicateNotifications?.createLedger({load:()=>{try{return JSON.parse(localStorage.getItem(historyKey)||'{}');}catch{return {};}},save:value=>localStorage.setItem(historyKey,JSON.stringify(value))});
 let allConflicts=[];
 const history=d.createElement('details');history.className='profileBankHelp';history.innerHTML='<summary>Duplicate notification history</summary><button type="button" data-clear-all>Clear history</button><div data-history></div>';panel.append(history);
 function renderHistory(){const list=history.querySelector('[data-history]');list.replaceChildren();for(const entry of ledger?.history()||[]){const row=d.createElement('div');row.className='profileDuplicateRow';const label=d.createElement('span');label.textContent=(entry.resolved?'Resolved conflict':entry.kept?'Intentional reuse':entry.dismissed?'Dismissed conflict':'Conflict to review')+' · '+new Date(entry.at).toLocaleString();row.append(label);const conflict=allConflicts.find(c=>c.conflictId===entry.id);if(conflict){const open=d.createElement('button');open.type='button';open.textContent='Review records';open.onclick=()=>void compareConflict(conflict);row.append(open);}const clear=d.createElement('button');clear.type='button';clear.textContent='Clear';clear.onclick=()=>{ledger.action(entry.id,'clear');renderHistory();};row.append(clear);list.append(row);}}
 history.querySelector('[data-clear-all]').onclick=()=>{ledger?.clearAll();renderHistory();};
 function dismissReview(){for(const c of store.scanned?.duplicates||[])ledger?.action(c.conflictId,'dismiss');modal.hidden=true;renderHistory();}
 const context=()=>window.JigStudioLocalImport?.bankTargets?.()||null;
 const msg=(value,error=false)=>{$('profileBankSummary').textContent=value;$('profileBankSummary').classList.toggle('profileBankError',error);};
 function customers(){return(window.JigWebsiteCustomers?.list?.()||[]).filter(x=>x.id&&Number(x.tierCount)>0);}
 function renderCustomers(){const selected=store.customerId,users=customers(),pick=$('profileCustomer');pick.replaceChildren(new Option(users.length?'Choose a membership customer':'Sign in to website Admin',''));
  for(const c of users)pick.append(new Option(c.name+' · '+c.tierCount+' profiles',c.id));
  if(users.some(c=>c.id===selected))pick.value=selected;
  $('profileCustomerPicker').hidden=store.scope==='personal';
  $('personalBankLock').hidden=store.scope!=='personal';
  $('profileImportBank').disabled=store.scope==='aco'&&!pick.value;
 }
 let bankReadEpoch=0;
 async function choose(scope,customerId){d.querySelectorAll('.profileFullDetails').forEach(x=>x.remove());bankReadEpoch++;store.poolCounts=null;store.profiles=[];store.websiteLinked=[];store.counts={};store.scope=scope;store.customerId=scope==='aco'?customerId||null:null;
  $('profileBankScope').value=scope;renderCustomers();render();await refresh();}
 function currentId(){return store.scope==='aco'?store.customerId:null;}
 async function refresh(){const ticket=++bankReadEpoch,scope=store.scope,id=currentId();renderCustomers();if(store.scope==='aco'&&!store.customerId){store.profiles=[];store.websiteLinked=[];store.counts={};render();return;}
  if(store.scope==='personal'&&!await window.JigPersonalGuard?.ensureUnlocked?.()){msg('Personal vault is locked. Your private accounts remain protected.',true);return;}
  try{const result=await api.list(scope,id);if(ticket!==bankReadEpoch||scope!==store.scope||id!==currentId())return;const workshop=window.desktopAPI?.profileWorkshop;if(workshop){const [assets,...emails]=await Promise.all([workshop.assets({scope,customerId:id}),...['target','walmart','pokemoncenter','costco','sams'].map(retailer=>workshop.emails({scope,customerId:id,retailer}))]);if(ticket!==bankReadEpoch||scope!==store.scope||id!==currentId())return;store.poolCounts={cards:assets.cards.filter(c=>c.unused).length,emails:emails.map(e=>({retailer:e.retailer,unused:e.emails.filter(x=>x.status==='available').length}))};}store.profiles=result.profiles;store.websiteLinked=result.websiteLinked||[];store.counts=result.combinedCounts||result.counts;render();msg((store.scope==='personal'?'Personal':'Selected customer ACO')+' bank · '+store.profiles.length+' saved profile(s)'+(store.scope==='aco'?' · '+store.websiteLinked.length+' live website-linked profile(s).':' · No cross-vault mixing.')+(result.websiteComplete===false?' Live website list may be partial.':''));}
  catch(error){if(ticket!==bankReadEpoch)return;store.profiles=[];store.websiteLinked=[];store.counts={};render();msg(error.message,true);}}
 const retailerNames={target:'Target',walmart:'Walmart',pokemoncenter:'Pokémon Center',costco:'Costco',sams:'Sam’s'};
 function render(){const q=$('profileBankSearch').value.toLowerCase();const localKeys=new Set(store.profiles.map(x=>x.retailer+'|'+x.email));const inventory=[...store.profiles,...store.websiteLinked.filter(x=>!localKeys.has(x.retailer+'|'+x.email))];const staged=inventory.filter(p=>store.stage==='completed'?p.stage==='completed':p.stage!=='completed');const rows=staged.filter(p=>(store.activeRetailer==='all'||p.retailer===store.activeRetailer)&&(p.email+' '+p.label).toLowerCase().includes(q));
  $('profileBankCount').textContent=rows.length+' '+(store.stage==='completed'?'completed':'in progress')+' visible';for(const b of $('profileStageTabs').querySelectorAll('[data-stage]')){b.setAttribute('aria-pressed',String(b.dataset.stage===store.stage));b.textContent=(b.dataset.stage==='completed'?'Completed Profiles':'In Progress')+' ('+inventory.filter(p=>(p.stage==='completed')===(b.dataset.stage==='completed')&&(store.activeRetailer==='all'||p.retailer===store.activeRetailer)).length+')';}const pools=store.poolCounts;$('profilePoolAvailability').textContent=pools?'Unused emails: '+pools.emails.filter(x=>store.activeRetailer==='all'||x.retailer===store.activeRetailer).reduce((n,x)=>n+x.unused,0)+' | Unused cards in this vault: '+pools.cards:'';$('profileBankRows').replaceChildren();
  for(const button of $('profileBankRetailers').querySelectorAll('button')){
   const selected=button.dataset.filter===store.activeRetailer;button.setAttribute('aria-pressed',String(selected));if(button.dataset.filter!=='all')button.textContent=(button.dataset.filter==='pokemoncenter'?'PKC':retailerNames[button.dataset.filter])+' ('+(store.counts[button.dataset.filter]||0)+')';
  }
  if(!rows.length){const empty=d.createElement('p');empty.className='profileBankEmpty';empty.textContent=store.scope==='aco'&&!store.customerId?'Choose a customer to open their bank.':'No matching retailer profiles. Imported file profiles can be saved here.';$('profileBankRows').append(empty);return;}
  for(const p of rows.slice(0,150)){
   const div=d.createElement('article');div.className='profileBankCard';const text=d.createElement('div'),title=d.createElement('strong'),meta=d.createElement('small');
   title.textContent=p.label||p.email;meta.textContent=[retailerNames[p.retailer],p.email,p.stage==='completed'?'Completed':p.status,...(p.stage!=='completed'&&p.missing?.length?['Needs: '+p.missing.join(', ')]:[])].join(' · ');text.append(title,meta);
   const actions=d.createElement('div');actions.className='buttons';
   for(const [label,action] of (p.source==='website'?[['View in Admin','website']]:[['View','view'],['Edit selected fields','fields'],['Jig address','jig'],['Set available','available'],['Remove','remove']])){
    const btn=d.createElement('button');btn.type='button';btn.className='btn slim '+(action==='remove'?'plain':'secondary');btn.textContent=label;
    btn.addEventListener('click',()=>void cardAction(action,p));actions.append(btn);
   }
   div.append(text,actions);$('profileBankRows').append(div);
  }
  if(rows.length>150){const hint=d.createElement('p');hint.className='profileBankEmpty';hint.textContent='Showing the first 150. Search to find a specific profile without scrolling.';$('profileBankRows').append(hint);}
 }
 async function openJig(profile){
  const before=await api.view(store.scope,currentId(),profile.id);
  const available=await api.jigAddresses(store.scope,currentId());
  if(!available.addresses.length){msg('Save an address in this specific Personal/customer address bank before jigging.',true);return;}
  const win=d.createElement('div');win.className='profileReviewModal';
  win.innerHTML='<div class="profileReviewBox profileJigBox" role="dialog" aria-modal="true"><div class="profileReviewHead"><div><div class="eyebrow">PROFILE SHIPPING ADDRESS</div><h2>Choose address & jig styles</h2><p>A linked website customer profile will publish the confirmed jig to the website and app. Personal and unlinked profiles remain local. The customer’s original saved address bank is not overwritten.</p></div><button class="btn plain slim" data-close>✕</button></div><label>Saved address <select data-address></select></label><p data-hint></p><details><summary>Choose formatting checkboxes</summary><div data-rules class="profileJigRules"></div></details><label class="profileJigCombine"><input type="checkbox" data-combine> Allow combining selected rules</label><pre data-preview>Choose a saved address and generate a preview.</pre><div class="buttons"><button class="btn secondary slim" data-preview-btn>Preview jig</button><button class="btn primary slim" data-save disabled>Apply jig to this local profile</button></div><p data-status role="status"></p></div>';
  const select=win.querySelector('[data-address]'),preview=win.querySelector('[data-preview]'),save=win.querySelector('[data-save]'),hint=win.querySelector('[data-hint]');
  const rulesContainer=win.querySelector('[data-rules]');
   if(store.scope==='aco'&&before.profile?.source==='website-linked-profile')save.textContent='Publish jig to website & app';
  for(const a of available.addresses)select.append(new Option(a.label+' · '+a.address1+' · '+a.uses+' uses',a.id));
  select.value=available.addresses[0].id;hint.textContent='Least-used saved address is preselected. You can choose a different address.';
  for(const r of (window.JigCore?.RULES||[])){
    const label=d.createElement('label');label.className='profileJigRule';
    const cb=d.createElement('input');cb.type='checkbox';cb.value=r.id;cb.checked=(window.JigCore?.defaultRuleIDs||[]).includes(r.id);
    if(r.experimental){label.classList.add('experimental');cb.checked=false;}
    const span=d.createElement('span');span.textContent=r.label+(r.experimental?' · review carefully':'');
    label.append(cb,span);rulesContainer.append(label);
  }
  const value=()=>({scope:store.scope,customerId:currentId(),profileId:profile.id,addressId:select.value,
    ruleIds:[...rulesContainer.querySelectorAll('input:checked')].map(x=>x.value),combine:win.querySelector('[data-combine]').checked});
  let last=null,lastPreview=null;const close=()=>win.remove();win.querySelector('[data-close]').addEventListener('click',close);
  win.addEventListener('click',event=>{if(event.target===win)close();});
  function invalidate(){last=null;lastPreview=null;save.disabled=true;preview.textContent='Generate a new preview to confirm these settings.';}
  select.addEventListener('change',invalidate);rulesContainer.addEventListener('change',invalidate);win.querySelector('[data-combine]').addEventListener('change',invalidate);
  win.querySelector('[data-preview-btn]').addEventListener('click',async()=>{
    try{last=value();const result=await api.jig({...last,commit:false});lastPreview=result.preview;
      preview.textContent=JSON.stringify({customer:store.scope==='personal'?'Personal':store.customerId,retailer:profile.retailer,account:profile.email,from:result.original,to:result.preview,usedRules:result.ruleIds,availableVariants:result.availableVariants},null,2);
      save.disabled=false;win.querySelector('[data-status]').textContent='Preview ready. Review the address before saving.';
    }catch(e){last=null;save.disabled=true;win.querySelector('[data-status]').textContent=e.message;}
  });
  save.addEventListener('click',async()=>{
    if(!last)return;
    if(store.scope==='personal'&&!await window.JigPersonalGuard?.ensureUnlocked?.())return;
    const linked=store.scope==='aco'&&before.profile?.source==='website-linked-profile';
    if(!confirm(linked?'Publish this jigged shipping address to the exact linked website account and save to ACO Studio?':'Save this jigged address only to this LOCAL '+store.scope+' profile?'))return;
    save.disabled=true;
    try{
      if(linked){
       const published=await window.desktopAPI.profileLibrary.publishLinkedJig({scope:'aco',customerId:store.customerId,profileId:profile.id,expectedRevision:before.profile.revision,address:lastPreview,confirmed:true});
       if(!published?.remoteSaved)throw Error('The website did not confirm the jig.');
       close();await refresh();msg('Shipping jig published to the website/app linked profile and saved in ACO Studio.');
      }else{
       await api.jig({...last,commit:true,confirmed:true});close();await refresh();msg('Jigged shipping address saved to this local '+store.scope+' profile.');
      }
     }
    catch(e){win.querySelector('[data-status]').textContent=e.message;save.disabled=false;}
  });
  d.body.append(win);
  win.querySelector('[data-close]').focus();
 }
 async function cardAction(action,p){const actionScope=store.scope,actionId=currentId(),actionEpoch=bankReadEpoch;try{
  if(action==='website'){document.querySelector('.tabButton[data-tab=\"site\"]')?.click();document.getElementById('siteSearch')?.focus();msg('Website-linked profile stays in its authorized Admin account. Open the customer profile there to manage it.');return;}
  if(action==='fields'){await window.ACOProfileWorkshop.openSaved({scope:store.scope,customerId:currentId(),profileId:p.id});return;}
  if(action==='jig'){await openJig(p);return;}
  if(action==='view'){
   const result=await api.view(store.scope,currentId(),p.id);
   if(actionScope!==store.scope||actionId!==currentId()||actionEpoch!==bankReadEpoch)return;const raw=result.profile.data;
   const box=d.createElement('div');box.className='profileReviewModal profileFullDetails';box.innerHTML='<div class="profileReviewBox"><h2>Full profile details</h2><pre></pre><button class="btn secondary slim">Close</button></div>';box.querySelector('pre').textContent=JSON.stringify({retailer:p.retailer,email:p.email,status:p.status,stage:p.stage||'in-progress',missing:p.missing||[],profile:raw},null,2);box.querySelector('button').addEventListener('click',()=>box.remove());
   const jigButton=d.createElement('button');jigButton.type='button';jigButton.className='btn primary slim';jigButton.textContent='Jig shipping address';jigButton.addEventListener('click',()=>{box.remove();void openJig(p);});
   const addressTitle=d.createElement('p');addressTitle.textContent='Shipping address options';
   box.querySelector('.profileReviewBox').insertBefore(addressTitle,box.querySelector('pre'));
   box.querySelector('.profileReviewBox').append(jigButton);d.body.append(box);
  }else if(action==='remove'){
   if(!confirm('Remove '+p.email+' from this local '+store.scope+' bank? This does NOT remove any website-linked retailer account.'))return;
   await api.remove(store.scope,currentId(),p.id);await refresh();await scan([],false);
  }else if(action==='available'){
   if(!confirm('Mark this '+retailerNames[p.retailer]+' account available as a replacement in the same bank?'))return;
   await api.status(store.scope,currentId(),p.id,'available');await refresh();
  }
 }catch(e){msg(e.message,true);}}
 function normalizeImports(){const target=context();if(!target||!target.count||target.savedToProfileBank)return [];
  const raw=window.JigStudioLocalImport?.currentAllProfiles?.();
  if(!raw||raw.importKey!==target.importKey)return [];
  const retailer=$('profileImportRetailer').value;
  return raw.records.map(record=>({scope:target.scope,customerId:target.scope==='aco'?target.customerId:null,retailer,data:record}));
 }
 function scanOutput(result,imports){store.scanned=result;store.scanImports=imports;$('profileScanBadge').textContent=result.duplicates.length?'⚠ '+result.duplicates.length+' reused email(s)':'✓ No duplicate emails';$('profileScanBadge').classList.toggle('profileScanAlert',Boolean(result.duplicates.length));
  const count=result.duplicates.length;
  if(count)showReview(result);
  else msg('Scanned '+result.scanned+' profile references across saved banks and this import. '+(result.websiteComplete?'Website-linked accounts included.':'Website scan incomplete: '+result.websiteReason));
 }
 // Inspect an entire conflict before deciding which exact record to change.
 // The normal website and Personal authorization checks still apply.
 async function compareConflict(dup){
  const inspector=d.createElement('div');inspector.className='profileReviewModal profileCompareModal';
  inspector.innerHTML='<div class="profileReviewBox" role="dialog" aria-modal="true"><div class="profileReviewHead"><div><div class="eyebrow">COMPARE BEFORE CHANGING ANYTHING</div><h2>Compare both accounts</h2><p data-count></p></div><button type="button" class="btn secondary slim" data-close>Close</button></div><div data-accounts></div><p role="status" data-error></p><div class="profileReviewFooter"><small>Customer and Personal banks remain separate. Nothing is deleted until you explicitly choose a record and confirm.</small></div></div>';
  inspector.querySelector('[data-count]').textContent=(retailerNames[dup.retailer]||dup.retailer)+' · '+dup.email+' · '+dup.items.length+' records';
  const accounts=inspector.querySelector('[data-accounts]');accounts.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:14px;max-height:60vh;overflow:auto;';
  inspector.querySelector('[data-close]').onclick=()=>inspector.remove();
  inspector.addEventListener('click',e=>{if(e.target===inspector)inspector.remove();});
  for(const entry of dup.items){
   const card=d.createElement('section');card.style.cssText='border:1px solid #55738c;border-radius:12px;padding:16px;min-width:0;overflow-wrap:anywhere';
   const heading=d.createElement('h3');heading.textContent=(entry.scope==='website'?'Live Website':entry.scope==='aco'?'Customer Vault':entry.scope==='personal'?'Private Vault':'Imported File')+' · '+(retailerNames[entry.retailer]||entry.retailer);
   const details=d.createElement('div');details.style.cssText='white-space:pre-wrap;line-height:1.6;margin:12px 0;color:inherit';
   details.textContent=['Email: '+(entry.email||'Locked Personal record'),'Owner: '+(entry.scope==='personal'?'Private':entry.owner||'Not assigned'),'Status: '+(entry.status||'Unknown'),'Label: '+(entry.label||''),'Record ID: '+(entry.id||'Not available')].join('\n');
   const actions=d.createElement('div');actions.className='buttons';actions.style.cssText='display:flex;flex-wrap:wrap;gap:8px';
   card.append(heading,details,actions);accounts.append(card);
   const makeButton=(title,handler,variant='secondary')=>{const b=d.createElement('button');b.type='button';b.className='btn slim '+variant;b.textContent=title;b.onclick=handler;actions.append(b);return b;};
   if((entry.scope==='aco'||entry.scope==='personal')&&entry.id){
    const more=d.createElement('div');more.textContent='Loading authorized local profile details…';card.append(more);
    void api.view(entry.scope,entry.scope==='aco'?entry.owner:null,entry.id).then(result=>{
     if(!inspector.isConnected)return;
     const p=result?.profile||{},data=p.data||{},shipping=data.shipping||{},billing=data.billing||{};
     const pan=String(data.cc_number||data.card?.number||'').replace(/\D/g,'');
     const lines=['Profile name: '+String(data.profile_name||data.name||data.profileName||p.label||''),
       'Phone: '+String(data.phone_num||data.phoneNumber||data.phone||''),
       'Shipping: '+[shipping.addressLine1||data.shipping_street||data.shipping_address||'',shipping.city||data.shipping_city||'',shipping.state||data.shipping_state||'',shipping.zipCode||data.shipping_zip_code||''].filter(Boolean).join(', '),
       'Billing: '+[billing.addressLine1||data.billing_street||'',billing.city||data.billing_city||'',billing.state||data.billing_state||'',billing.zipCode||data.billing_zip_code||''].filter(Boolean).join(', '),
       'Card: '+(pan?'•••• '+pan.slice(-4):'No card')];
     more.textContent=lines.join('\n');more.style.whiteSpace='pre-wrap';
    }).catch(error=>{more.textContent='Details protected: '+String(error?.message||error);});
    makeButton('Edit this profile',()=>{inspector.remove();modal.hidden=true;d.dispatchEvent(new CustomEvent('aco-studio:edit-profile',{detail:{scope:entry.scope,customerId:entry.scope==='aco'?entry.owner:null,profileId:entry.id}}));});
    makeButton('Delete this LOCAL record',async()=>{
     if(!confirm('Delete ONLY the local '+(retailerNames[entry.retailer]||entry.retailer)+' record '+(entry.label||entry.id)+'? This will not delete a website account. If it is synced from the website, it may be re-imported.'))return;
     try{
      await api.remove(entry.scope,entry.scope==='aco'?entry.owner:null,entry.id);
      inspector.remove();modal.hidden=true;await refresh();await scan([],false);
      msg('Deleted the selected LOCAL profile only. Live website accounts are unchanged.');
     }catch(e){inspector.querySelector('[data-error]').textContent=String(e.message||e);}
    },'plain');
   }else if(entry.scope==='website'){
    const more=d.createElement('pre');more.textContent='Loading authoritative customer profile…';card.append(more);
    let exact=null;const lib=window.desktopAPI.profileLibrary;
    void (async()=>{try{await lib.syncCustomer({scope:'aco',customerId:entry.owner});const result=await lib.list({scope:'aco',customerId:entry.owner});if(!inspector.isConnected)return;exact=result.profiles.find(x=>x.remoteManagedId===entry.id&&x.retailer===entry.retailer&&x.sourceLinked);if(!exact)throw Error('The assignment changed; reopen its customer account.');const data=exact.data||{},s=data.shipping||{},b=data.billing||{},pan=String(data.cc_number||data.card?.number||'').replace(/\D/g,'');more.textContent=['Source: authoritative website assignment','Customer: '+entry.owner,'Email: '+exact.email,'Shipping: '+[s.firstName||data.first_name,s.lastName||data.last_name,s.addressLine1||data.shipping_street,s.city||data.shipping_city,s.state||data.shipping_state,s.zipCode||data.shipping_zip_code].filter(Boolean).join(', '),'Billing: '+[b.addressLine1||data.billing_street,b.city||data.billing_city,b.state||data.billing_state].filter(Boolean).join(', '),'Payment: '+(pan?'•••• '+pan.slice(-4):'Not saved')].join('\n');}catch(error){more.textContent=String(error.message||error);}})();
    makeButton('Edit / manage this exact live profile',()=>{if(!exact){inspector.querySelector('[data-error]').textContent='Wait for the exact website profile to load.';return;}inspector.remove();modal.hidden=true;d.dispatchEvent(new CustomEvent('aco-studio:edit-profile',{detail:{scope:'aco',customerId:entry.owner,profileId:exact.id}}));});
   }else if(entry.scope==='import'&&Number.isSafeInteger(entry.index)){
    makeButton('Remove this IMPORT row',()=>{
     if(!confirm('Remove only this row from the current import?'))return;
     try{window.JigStudioLocalImport.removeImportedRow(entry.index);inspector.remove();modal.hidden=true;void scan([],false);}
     catch(e){inspector.querySelector('[data-error]').textContent=String(e.message||e);}
    });
   }
  }
  d.body.append(inspector);
 }
 function showReview(result){modal.hidden=false;$('profileReviewList').replaceChildren();
  $('profileReviewSub').textContent=result.duplicates.length+' email(s) appear more than once. '+(result.websiteComplete?'All linked website account pages checked.':'Website inventory not fully available: '+result.websiteReason);
  for(const dup of result.duplicates.slice(0,90)){
   const wrap=d.createElement('div');wrap.className='profileDuplicateEntry';
   const h=d.createElement('strong');h.textContent=dup.email+' ('+dup.count+' matches)';wrap.append(h);const keep=d.createElement('button');keep.type='button';keep.className='btn secondary slim';keep.textContent='Keep both · intentional reuse';keep.onclick=()=>{ledger?.action(dup.conflictId,'keep');store.scanned.duplicates=store.scanned.duplicates.filter(x=>x.conflictId!==dup.conflictId);showReview(store.scanned);renderHistory();};wrap.append(keep);
    const compare=d.createElement('button');compare.type='button';compare.className='btn primary slim';compare.textContent='Compare both records · View / Edit / Delete';compare.style.margin='10px 0';compare.onclick=()=>void compareConflict(dup);wrap.append(compare);
   for(const entry of dup.items){const row=d.createElement('div');row.className='profileDuplicateRow';
    const label=d.createElement('span');label.textContent=[entry.scope==='import'?'Current import':entry.scope==='personal'?'Personal · private':entry.scope==='website'?'Live website linked':'ACO customer '+entry.owner,retailerNames[entry.retailer]||entry.retailer,entry.status||'',entry.label||''].filter(Boolean).join(' · ');row.append(label);
    // Local deletions and replacements are scoped to a single bank/customer.
    if(['personal','aco'].includes(entry.scope)&&entry.id){
     const btn=d.createElement('button');btn.className='btn slim plain';btn.textContent='Delete local duplicate';btn.addEventListener('click',()=>void resolve('remove',entry));row.append(btn);
     const choices=store.profiles.filter(p=>p.retailer===entry.retailer&&p.status==='available'&&p.id!==entry.id&&store.scope===entry.scope&&(store.scope==='personal'||store.customerId===entry.owner));
     if(choices.length){const select=d.createElement('select');select.append(new Option('Select fresh account',''));for(const c of choices)select.append(new Option(c.email,c.id));const replace=d.createElement('button');replace.type='button';replace.className='btn slim secondary';replace.textContent='Replace from THIS bank';replace.addEventListener('click',()=>void resolve('swap',entry,select.value));row.append(select,replace);}
    }
    if(entry.scope==='import'&&Number.isInteger(entry.index)){
     const remove=d.createElement('button');remove.className='btn slim plain';remove.textContent='Remove imported row';remove.addEventListener('click',()=>{
      if(!confirm('Remove this duplicate from the current imported file? Other saved banks and website accounts stay unchanged.'))return;
      try{window.JigStudioLocalImport.removeImportedRow(entry.index);modal.hidden=true;void scan();}catch(e){msg(e.message,true);}
     });row.append(remove);
     const importedScope=entry.importScope,importOwner=entry.owner;
     const fresh=store.profiles.filter(p=>p.status==='available'&&p.retailer===entry.retailer&&store.scope===importedScope&&(importedScope==='personal'||importOwner===store.customerId));
     if(fresh.length){
      const select=d.createElement('select');select.append(new Option('Choose unused account',''));
      for(const f of fresh)select.append(new Option(f.email,f.id));
      const replace=d.createElement('button');replace.className='btn slim secondary';replace.textContent='Replace imported row';
      replace.addEventListener('click',async()=>{
       if(!select.value){msg('Select a fresh same-retailer account first.',true);return;}
       if(!confirm('Replace this imported row with a fresh profile from the SAME bank and retailer?'))return;
       try{
        const replacement=await api.view(store.scope,currentId(),select.value);
        // Do not move the replacement into another customer: verify bank context.
        if(replacement.scope!==importedScope||replacement.customerId!==(importedScope==='aco'?importOwner:null))throw Error('Cross-bank replacement blocked.');
        await api.status(store.scope,currentId(),select.value,'active');
        window.JigStudioLocalImport.replaceImportedRow(entry.index,replacement.profile.data);
        modal.hidden=true;await refresh();await scan();
       }catch(e){msg(e.message,true);}
      });row.append(select,replace);
     }
    }
    if(entry.scope==='website'){const info=d.createElement('small');info.textContent='Manage on website Admin; no automatic remote delete';row.append(info);}
    wrap.append(row);
   }
   $('profileReviewList').append(wrap);
  }
 }
 async function resolve(action,entry,replacementId){try{
  // Never allow resolving bank A's entry while viewing B or a Personal bank.
  if(entry.scope!==store.scope||(store.scope==='aco'&&entry.owner!==store.customerId))throw Error('Open the matching bank first. Nothing was changed.');
  if(action==='swap'){
   if(!replacementId)throw Error('Choose a different unused same-retailer profile first.');
   if(!confirm('Swap '+entry.label+' for the unused '+retailerNames[entry.retailer]+' profile in this same bank?'))return;
   await api.swap(store.scope,currentId(),entry.id,replacementId);
  }else{
   if(!confirm('Delete this exact local duplicate? Website-linked records will NOT be touched.'))return;
   await api.remove(store.scope,currentId(),entry.id);
  }
  await refresh();modal.hidden=true;await scan([],false);
 }catch(e){msg(e.message,true);}}
 async function scan(imports=normalizeImports(),show=true){try{
  $('profileScanBadge').textContent='Scanning accounts…';let result=await api.scan(imports);allConflicts=result.duplicates;result={...result,duplicates:ledger?ledger.observe(allConflicts):allConflicts};renderHistory();
  if(show)scanOutput(result,imports);
  else{store.scanned=result;store.scanImports=imports;$('profileScanBadge').textContent=result.duplicates.length?'⚠ '+result.duplicates.length+' to review · click':'✓ Scan clear';$('profileScanBadge').classList.toggle('profileScanAlert',Boolean(result.duplicates.length));/* Never reopen a dismissed review from an automatic scan. */}
  return result;
 }catch(e){$('profileScanBadge').textContent='Scan unavailable';msg(e.message,true);return null;}}
 async function importCurrent(){const target=context();if(!target||!target.count)throw Error('Import profiles into Profile Studio first.');
  if(target.scope!==store.scope||(store.scope==='aco'&&target.customerId!==store.customerId))throw Error('The selected file belongs to a different Personal/customer bank. Change its source first.');
  const raw=window.JigStudioLocalImport?.currentAllProfiles?.();if(!raw||raw.importKey!==target.importKey)throw Error('Profile import changed. Choose the matching file again.');
  if(store.scope==='personal'&&!await window.JigPersonalGuard.ensureUnlocked())return;
  const duplicates=await scan(normalizeImports(),true);if(!duplicates)return;
  if(duplicates.duplicates.length){msg('Review duplicates before importing. No profiles have been changed.');return;}
  const result=await api.importRows({scope:store.scope,customerId:currentId(),retailer:$('profileImportRetailer').value,rows:raw.records,status:'active'});
  await refresh();msg(result.added.length+' profile cards saved to this '+store.scope+' bank. '+result.skipped.length+' same-retailer duplicates skipped.');
 }
 $('profileBankScope').addEventListener('change',()=>void choose($('profileBankScope').value,$('profileCustomer').value));
 $('profileCustomer').addEventListener('change',()=>void choose('aco',$('profileCustomer').value));
 $('profileStageTabs').addEventListener('click',e=>{const b=e.target.closest('[data-stage]');if(b){store.stage=b.dataset.stage;render();}});
 $('profileBankSearch').addEventListener('input',render);
 $('profileBankRetailers').addEventListener('click',event=>{const btn=event.target.closest('[data-filter]');if(btn){store.activeRetailer=btn.dataset.filter;render();}});
 $('profileImportBank').addEventListener('click',async()=>{try{await importCurrent();}catch(error){msg(error.message,true);}});
 $('profileScanNow').addEventListener('click',()=>void scan(normalizeImports(),true));
 $('profileScanBadge').addEventListener('click',()=>{if(store.scanned?.duplicates?.length)showReview(store.scanned);else void scan(normalizeImports(),true);});
 $('profileImportRetailer').addEventListener('change',()=>void scan(normalizeImports(),false));
 $('personalBankLock').addEventListener('click',async()=>{await window.JigPersonalGuard?.lock();msg('Personal bank locked. Enter PIN or Touch ID to open it again.');});
 $('profileReviewClose').addEventListener('click',()=>dismissReview());$('profileReviewDone').addEventListener('click',()=>dismissReview());
 modal.addEventListener('click',event=>{if(event.target===modal)dismissReview();});
 // Auto scans happen after every profile file import and roster change, not
 // while a user is typing in the bank editor.
 let debounce;function backgroundScan(){clearTimeout(debounce);if(context()?.savedToProfileBank)return;debounce=setTimeout(()=>void scan(normalizeImports(),false),550);}
 d.addEventListener('jigstudio:bank-context-updated',()=>{const target=context();if(!target){void choose(window.JigStudioLocalImport.workspaceScope(),null);return;}
  void choose(target.scope,target.customerId).then(backgroundScan);});
 d.addEventListener('jigstudio:customers-updated',()=>{renderCustomers();if(window.JigWebsiteCustomers?.connected?.())backgroundScan();});
 d.addEventListener('jigstudio:personal-locked',()=>{if(store.scope==='personal'){bankReadEpoch++;d.querySelectorAll('.profileFullDetails').forEach(x=>x.remove());store.profiles=[];store.poolCounts=null;store.counts={};render();}});
 d.addEventListener('jigstudio:personal-unlocked',()=>{if(store.scope==='personal')void refresh();});
 d.addEventListener('aco-studio:open-profile-bank',event=>{
  const id=event.detail?.customerId;if(!id)return;
  d.querySelector('.tabButton[data-tab="jig"]')?.click();
  void choose('aco',id).then(()=>{$('profileBanksPanel')?.scrollIntoView({behavior:'smooth',block:'center'});});
 });
 window.ACOProfileBank=Object.freeze({context:()=>({scope:store.scope,customerId:currentId()}),openPersonal:async retailer=>{if(retailerNames[retailer]){$('profileImportRetailer').value=retailer;store.activeRetailer=retailer;}await choose('personal',null);},openCustomer:customerId=>d.dispatchEvent(new CustomEvent('aco-studio:open-profile-bank',{detail:{customerId}})),scan:()=>scan(),refresh:()=>refresh()});
 renderCustomers();render();
})();
