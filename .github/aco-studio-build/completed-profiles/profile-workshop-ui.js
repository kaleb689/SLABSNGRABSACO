/* Independent Address/Card/Name controls and scoped saved assets / blank drafts. */
(()=>{'use strict';
 const d=document,$=id=>d.getElementById(id),api=window.desktopAPI?.profileWorkshop,library=window.desktopAPI?.profileLibrary;
 if(!api||!$('studioJigBanks'))return;
 const importer=()=>window.JigStudioLocalImport,context=()=>importer()?.workshopContext?.();
 const retail={target:'Target',walmart:'Walmart',pokemoncenter:'Pokemon Center',costco:'Costco',sams:"Sam's Club"};
 const panel=d.createElement('section');panel.id='profileWorkshop';panel.className='workshopPanel';
 panel.innerHTML=`<div class="workshopHead"><div><h3>Choose exactly what to change</h3><small id="workshopContext">Select a profile file or create a blank profile.</small></div><div class="buttons"><button class="btn slim secondary" id="workshopVault" type="button">Cards &amp; Addresses Vault</button><button class="btn slim primary" id="workshopCreate" type="button">+ Create Blank Profile</button></div></div>
 <div class="workshopChoices"><label><input id="workshopAddress" type="checkbox"><span><strong>Address</strong><small>From this vault's saved addresses</small></span></label><label><input id="workshopCard" type="checkbox"><span><strong>Card information</strong><small>From this vault's saved cards</small></span></label><label><input id="workshopName" type="checkbox"><span><strong>Name</strong><small>Generate one profile identity; shipping, billing, and cardholder names match automatically</small></span></label></div>
 <div class="workshopPickers"><details id="workshopAddresses" hidden open><summary>Choose saved addresses</summary><div class="workshopAssetChoices" id="workshopAddressRows"></div><small>Optional extra allocation: select multiple saved addresses and specify how many extra profiles each should receive. Remaining profiles are distributed evenly.</small><label class="workshopCheck"><input id="workshopMirror" type="checkbox"> Use the jigged shipping address for billing too</label><label class="workshopCheck"><input id="workshopStyles" type="checkbox"> Apply the retailer jig rules selected below</label></details>
 <details id="workshopCards" hidden open><summary>Choose saved cards</summary><label class="workshopCheck"><input id="workshopUnused" type="checkbox" checked> Show cards eligible for this retailer (unused or Hard Card)</label><div class="workshopAssetChoices" id="workshopCardRows"></div><label class="workshopCheck" hidden><input id="workshopReuse" type="checkbox"> Card reuse within the same retailer is prohibited</label></details></div>
 <details id="workshopHardJigs"><summary>Advanced hard jig category counts</summary><label class="workshopCheck"><input data-enable-hard-counts type="checkbox"> Use specific hard-jig counts rather than even distribution</label><div class="workshopChoices" id="workshopHardCounts">
  <label><span>Fractional <small>Randomized among 1/2, 1/3, 1/4</small></span><input type="number" data-hard-count="fraction" min="0" max="500" step="1" value="3" aria-label="Fractional jigs per main address"></label>
  <label><span>Hyphen <small>Randomized among -A through -H</small></span><input type="number" data-hard-count="hyphen" min="0" max="500" step="1" value="8" aria-label="Hyphen jigs per main address"></label>
  <label><span>Double letter <small>Duplicates one letter of the street name</small></span><input type="number" data-hard-count="doubleLetter" min="0" max="500" step="1" value="6" aria-label="Double-letter jigs per main address"></label>
  
 </div><small>One unchanged address per repeated-address group. Counts apply to categories, not individual fraction or letter variants. A fabricated unit is not a verified delivery address.</small></details>
 <div class="buttons"><button class="btn primary" id="workshopPreview" type="button" disabled>Preview selected changes</button><button class="btn secondary" id="workshopApply" type="button" disabled>Apply to file preview</button><button class="btn secondary" id="workshopSave" type="button" disabled>Save to this vault</button><button class="btn secondary" id="workshopExport" type="button" disabled>Export reviewed file</button><button class="btn plain slim" id="workshopLegacy" type="button">Return to previous formatting controls</button></div>
 <p id="workshopStatus" role="status" aria-live="polite">Unchecked fields stay unchanged. No profiles or vault entries are moved between owners.</p><details id="workshopReview" hidden><summary>Review changes</summary><div id="workshopReviewRows"></div></details>`;
 $('studioJigBanks').querySelector('.jigBanksScopes').after(panel);
 let plan=null,assets=null,busy=false,loading=false,assetEpoch=0,seenKey='',seenSourceKey='',previewTask=null,picks={addresses:new Set(),cards:new Set()},extraAllocation={};
  function selectedHardCounts(){const counts={randomUnit:0};for(const box of panel.querySelectorAll('[data-hard-count]')){const n=Number(box.value);if(!Number.isInteger(n)||n<0||n>500)throw Error('Use whole-number Jig counts from 0 to 500.');counts[box.dataset.hardCount]=n;}return counts;}
 const checked=()=>({address:$('workshopAddress').checked,card:$('workshopCard').checked,name:$('workshopName').checked});
 function ownerText(p){if(p?.scope==='personal')return 'Personal only';const c=window.JigWebsiteCustomers?.list?.().find(x=>x.id===p?.customerId);return 'Customer: '+(c?.name||p?.customerId||'not selected');}
 function fallback(){const c=context();if(c)return {scope:c.scope,customerId:c.customerId};const scope=importer()?.workspaceScope?.()||'personal',bank=window.ACOProfileBank?.context?.();return scope==='personal'?{scope:'personal',customerId:null}:{scope:'aco',customerId:bank?.scope==='aco'?bank.customerId:null};}
 async function unlock(p){if(p.scope==='personal'&&!await window.JigPersonalGuard?.ensureUnlocked?.())throw Error('Unlock Personal before opening its vault.');if(p.scope==='aco'&&!p.customerId)throw Error('Select a customer in the Retailer Profile Vault first.');}
 function note(text,error=false){$('workshopStatus').textContent=text;$('workshopStatus').classList.toggle('profileBankError',error);}
 function applyScopeSimplicity(c){
  const customer=c?.scope==='aco'||fallback()?.scope==='aco';
  // Customer Jigs uses the exact same single jig workflow. Owner-only creation
  // and vault-management shortcuts do not need a second customer-side control.
  $('workshopVault').hidden=customer;
  $('workshopCreate').hidden=customer;
  const personalImport=[...d.querySelectorAll('section,article,div')].find(el=>/Personal profile imports/i.test(String(el.querySelector?.('h1,h2,h3,h4,summary')?.textContent||'')));
  if(personalImport)personalImport.hidden=customer;
 }
 function controls(){const c=context(),ch=checked();applyScopeSimplicity(c);$('workshopPreview').disabled=busy||!c||!c.indices.length||!Object.values(ch).some(Boolean)||((ch.address||ch.card)&&(!assets||loading>0));
  $('workshopApply').disabled=busy||!plan;$('workshopSave').disabled=busy||!plan?.canSave||plan.saved;$('workshopExport').disabled=busy||!plan?.applied;
  $('workshopContext').textContent=c?ownerText(c)+' | '+c.indices.length+' of '+c.count+' profiles selected':'No profile file selected. Create a blank profile or import one.';
  for(const id of ['workshopAddress','workshopCard','workshopName','workshopMirror','workshopStyles','workshopReuse','workshopUnused'])$(id).disabled=busy;
 }
 function invalidate(){if(plan)void api.cancel(plan.token);plan=null;$('workshopReview').hidden=true;$('workshopReviewRows').replaceChildren();importer()?.clearWorkshopPreview?.();controls();}
 function assetRows(){
  $('workshopAddressRows').replaceChildren();$('workshopCardRows').replaceChildren();
  for(const a of assets?.addresses||[]){const label=d.createElement('label'),box=d.createElement('input'),text=d.createElement('span');box.type='checkbox';box.value=a.id;box.checked=picks.addresses.has(a.id);text.textContent=[a.label,a.address1,a.address2,a.city,a.state,a.zip].filter(Boolean).join(' | ');box.addEventListener('change',()=>{box.checked?picks.addresses.add(a.id):picks.addresses.delete(a.id);invalidate();});label.append(box,text);const count=d.createElement('input');count.type='number';count.min='0';count.max='500';count.step='1';count.value=String(extraAllocation[a.id]||0);count.setAttribute('aria-label','Extra profiles for '+(a.label||a.address1));count.title='Extra profiles allocated to this address';count.disabled=!box.checked;count.addEventListener('change',()=>{const n=Number(count.value);if(!Number.isInteger(n)||n<0||n>500){count.value='0';extraAllocation[a.id]=0;note('Extra allocation must be between 0 and 500.',true);}else{extraAllocation[a.id]=n;invalidate();}});box.addEventListener('change',()=>{count.disabled=!box.checked;if(!box.checked)delete extraAllocation[a.id];});label.append(count);$('workshopAddressRows').append(label);}
  for(const c of assets?.cards||[]){if($('workshopUnused').checked&&!c.unused)continue;const label=d.createElement('label'),box=d.createElement('input'),text=d.createElement('span');box.type='checkbox';box.value=c.id;box.checked=picks.cards.has(c.id);text.textContent=c.label+' | ending '+c.last4+' | '+(c.hardCard?'Hard Card | ':'')+(c.eligibleRetailers?.includes(context()?.retailer||activeRetailerPreset)?'Eligible for this retailer':c.unused?'Unused':c.usedCount?'Linked to '+c.usedCount+' profile(s)':'Previously assigned');box.addEventListener('change',()=>{box.checked?picks.cards.add(c.id):picks.cards.delete(c.id);invalidate();});label.append(box,text);$('workshopCardRows').append(label);}
  if(!$('workshopAddressRows').children.length)$('workshopAddressRows').textContent='No saved addresses. Open Cards & Addresses Vault to add one.';
  if(!$('workshopCardRows').children.length)$('workshopCardRows').textContent='No matching saved cards. Add a card to this vault, or review the Unused only filter.';
 }
 async function loadAssets(){const c=context(),ticket=++assetEpoch;if(!c)return;loading=true;try{await unlock(c);const result=await api.assets({scope:c.scope,customerId:c.customerId,retailer:c.retailer||activeRetailerPreset});if(ticket!==assetEpoch||context()?.contextKey!==c.contextKey)return;assets=result;assetRows();}catch(e){assets=null;note(e.message,true);}finally{if(ticket===assetEpoch)loading=false;controls();}}

 // Saved-profile batch jigging lives directly in Jig so the owner can choose
 // one, several, or every saved profile without bouncing back to Profiles.
 const bulkPanel=d.createElement('section');bulkPanel.className='workshopPanel';
 bulkPanel.innerHTML=`<div class="workshopHead"><div><h3>Saved profiles</h3><small id="bulkJigOwner">Select one, multiple, or all saved profiles. The retailer buttons and rule choices above control the jig.</small></div></div>
 <div class="buttons"><button class="btn plain slim" data-select-all type="button">Select all</button><button class="btn plain slim" data-clear type="button">Clear</button></div>
 <div class="workshopPickers"><details open><summary>Profiles to jig</summary><div class="workshopAssetChoices" data-profiles></div></details>
 <label class="workshopCheck"><input data-postal-scan type="checkbox" checked> Scan online ZIP/city crossovers during Jig Profiles preview</label>
 <label class="workshopCheck"><input data-postal-apply type="checkbox" checked> Apply ZIP/state-matched alternate city names when available</label>
 <small>City names come from an online ZIP listing, not a verified USPS street delivery address. Only ZIP is sent online; street, email, cards and personal details stay local.</small>
 <label class="workshopCheck"><input data-optional-unit type="checkbox"> Add Random Apt / Unit / Ste / # / Number (optional, OFF by default)</label>
 <label data-optional-unit-count-wrap hidden>How many selected unitless profiles? <input data-optional-unit-count type="number" min="1" max="500" step="1" value="1"></label>
 <small>Optional — OFF by default. Never change, remove or rename an existing Apt/Ste/Unit or unit number. Applies alongside selected fractional, hyphen and other jig styles. Generated units are not confirmed delivery points.</small>
 <label class="workshopCheck"><input data-distribution-toggle type="checkbox"> Choose more of one or more jig styles</label><div data-distribution-panel hidden><small>OFF: selected styles are distributed evenly. ON: enter preferred counts and the remainder is distributed automatically.</small><div data-distribution-rows></div></div><label class="workshopCheck"><input data-reuse-toggle type="checkbox"> Reuse a saved Main or Jigged shipping address across selected profiles</label>
 <section data-reuse-panel hidden><p>Choose the exact Main or previously Jigged address to use. Its complete shipping fields are copied without generating another jig.</p>
 <label>Choose Main or Jigged address<select data-reuse-choice></select></label>
 <label>Number of profiles using this address<input data-reuse-count type="number" min="2" max="500" step="1" value="2"></label></section></div>
 <label class="workshopCheck" data-duplicate-warning hidden><input data-allow-duplicate type="checkbox"> Allow duplicate jigged addresses for the exact saved-account conflicts shown in the preview</label>
 <div class="buttons"><button class="btn secondary" data-preview type="button" disabled>Preview selected profiles</button><button class="btn primary" data-apply type="button" disabled>Apply jig to selected profiles</button></div>
 <details data-review hidden><summary>Batch preview</summary><div data-review-rows></div></details><p data-status role="status">No duplicate retailer or name settings here. Use the single retailer preset and rule section above.</p>`;
 panel.after(bulkPanel);
 const bq=name=>bulkPanel.querySelector('[data-'+name+']');
 let bulkRetailer='target',bulkRows=[],bulkSelected=new Set(),bulkToken=null,bulkOwnerKey='',bulkLoading=false,bulkSettings=null,bulkDuplicateCount=0,activeRetailerPreset='target';
 const bulkOwner=()=>fallback();
 const bulkKey=p=>p.scope+':'+(p.customerId||'owner');
 let reuseLoadedKey='';
 function invalidateReuse(){bulkToken=null;bulkDuplicateCount=0;bq('allow-duplicate').checked=false;bq('duplicate-warning').hidden=true;bq('review').hidden=true;bulkControls();}
 async function loadReuseChoices(){
  const owner=bulkOwner(),key=bulkKey(owner);
  if(reuseLoadedKey===key&&bq('reuse-choice').options.length)return;
  bq('reuse-choice').disabled=true;
  try{
   await unlock(owner);
   const data=await library.reuseChoices(owner);
   if(bulkKey(bulkOwner())!==key)return;
   const select=bq('reuse-choice');select.replaceChildren();
   for(const type of ['main','jigged']){
    const group=d.createElement('optgroup');group.label=type==='main'?'Main addresses':'Previously jigged addresses';
    for(const a of (data.choices||[]).filter(x=>x.type===type)){
     const item=d.createElement('option');item.value=a.id;item.textContent=(a.label||'Saved address')+' | '+a.summary;group.append(item);
    }
    if(group.children.length)select.append(group);
   }
   if(!select.options.length)throw Error('No saved Main or Jigged addresses exist in this vault.');
   reuseLoadedKey=key;bulkStatus('Choose the saved Main/Jigged address and how many selected profiles should use it.');
  }catch(e){reuseLoadedKey='';bq('reuse-toggle').checked=false;bq('reuse-panel').hidden=true;bulkStatus(e.message,true);}
  finally{bq('reuse-choice').disabled=false;}
 }
 function fillDistributionRows(){
   const host=bq('distribution-rows');host.replaceChildren();
   const options=bulkSettings?.options||[],grouped=new Map();
   for(const rule of options.filter(x=>bulkRuleIds().includes(x.id))){
    const style=rule.id.startsWith('target.house.integer.')?'integer-house':rule.id.startsWith('target.house.fraction.')?'fraction-house':rule.id.startsWith('target.house.hyphen.')?'hyphen-house':/suffix|street type|road|avenue|lane|boulevard/i.test(rule.id+' '+rule.label)?'suffix':/ordinal/i.test(rule.id+' '+rule.label)?'ordinals':/compass|direction|north|south|east|west/i.test(rule.id+' '+rule.label)?'directions':rule.id;
    if(/phone/i.test(rule.id+' '+rule.label))continue;
    if(!grouped.has(style))grouped.set(style,rule.label);
   }
   for(const [style,name] of grouped){
    const label=d.createElement('label'),input=d.createElement('input');
    label.textContent=name+' preferred profile count';input.type='number';input.min='0';input.max='500';input.step='1';input.value='0';input.dataset.style=style;
    input.addEventListener('input',invalidateReuse);label.append(input);host.append(label);
   }
  }
  bq('distribution-toggle').addEventListener('change',()=>{bq('distribution-panel').hidden=!bq('distribution-toggle').checked;fillDistributionRows();invalidateReuse();});
  for(const name of ['postal-scan','postal-apply'])bq(name).addEventListener('change',()=>{invalidateReuse();bq('postal-apply').disabled=!bq('postal-scan').checked;});
 bq('optional-unit').addEventListener('change',()=>{bq('optional-unit-count-wrap').hidden=!bq('optional-unit').checked;invalidateReuse();bulkControls();});
 bq('optional-unit-count').addEventListener('input',()=>{invalidateReuse();bulkControls();});
 bq('allow-duplicate').addEventListener('change',bulkControls);
 bq('reuse-toggle').addEventListener('change',()=>{invalidateReuse();bq('reuse-panel').hidden=!bq('reuse-toggle').checked;if(bq('reuse-toggle').checked)void loadReuseChoices();});
 for(const name of ['reuse-choice','reuse-count'])bq(name).addEventListener('change',invalidateReuse);
 function bulkStatus(message,error=false){const el=bq('status');el.textContent=message;el.classList.toggle('profileBankError',error);}
 function bulkControls(){const count=bulkSelected.size;bq('preview').disabled=bulkLoading||!count||(!bq('reuse-toggle').checked&&!bq('optional-unit').checked&&!bulkSettings?.selected?.length&&!Object.values(selectedHardCounts()).some(Boolean));bq('apply').disabled=bulkLoading||!bulkToken||(bulkDuplicateCount>0&&!bq('allow-duplicate').checked);bq('preview').textContent=count?'Preview '+count+' selected profile'+(count===1?'':'s'):'Preview selected profiles';bq('apply').textContent=count?'Apply jig to '+count+' selected profile'+(count===1?'':'s'):'Apply jig to selected profiles';}
 function renderBulkProfiles(){
  const box=bq('profiles');box.replaceChildren();
  for(const row of bulkRows.filter(x=>x.retailer===bulkRetailer)){
   const label=d.createElement('label'),cb=d.createElement('input'),span=d.createElement('span');cb.type='checkbox';cb.value=row.id;cb.checked=bulkSelected.has(row.id);
   span.textContent=[row.label||row.email,row.email,row.bank==='live'?'Live Profiles · currently in use':'Working profiles',row.stage==='completed'?'Completed':'In progress',row.missing?.length?'Missing: '+row.missing.join(', '):''].filter(Boolean).join(' | ');
   cb.addEventListener('change',()=>{cb.checked?bulkSelected.add(row.id):bulkSelected.delete(row.id);bulkToken=null;bq('review').hidden=true;bulkControls();});label.append(cb,span);box.append(label);
  }
  if(!box.children.length)box.textContent='No saved '+(retail[bulkRetailer]||bulkRetailer)+' profiles in this vault.';
  bulkControls();
 }
 function mainRuleState(){
  const state={fraction:false,alpha:false,combine:false};
  for(const label of d.querySelectorAll('label')){
   const text=String(label.textContent||'').replace(/\s+/g,' ').trim(),box=label.querySelector('input[type="checkbox"]');
   if(!box)continue;
   if(/Fractional house numbers/i.test(text))state.fraction=box.checked;
   if(/Alphanumeric house number/i.test(text))state.alpha=box.checked;
   if(/Enable combinations/i.test(text))state.combine=box.checked;
  }
  return state;
 }
 function bulkRuleIds(){
  const selected=[...(bulkSettings?.selected||[])],state=mainRuleState();
  return selected;
 }
 async function loadBulk(retailerId=bulkRetailer){
  if(!library)return;bulkRetailer=retailerId;bulkToken=null;bq('review').hidden=true;bulkLoading=true;bulkControls();
  const owner=bulkOwner();try{await unlock(owner);const [list,settings]=await Promise.all([library.list(owner),library.rules({...owner,retailer:bulkRetailer})]);if(bulkOwnerKey&&bulkOwnerKey!==bulkKey(owner)){reuseLoadedKey='';bq('reuse-choice').replaceChildren();bq('reuse-toggle').checked=false;bq('reuse-panel').hidden=true;}bulkOwnerKey=bulkKey(owner);bulkRows=list.profiles||[];bulkSettings=settings;bulkSelected=new Set([...bulkSelected].filter(id=>bulkRows.some(x=>x.id===id&&x.retailer===bulkRetailer)));renderBulkProfiles();
   if(settings.legacyMigrated)await library.saveRules({...owner,retailer:bulkRetailer,rules:settings.selected});
   const ownerEl=bulkPanel.querySelector('#bulkJigOwner');if(ownerEl)ownerEl.textContent=ownerText(owner)+' | '+(retail[bulkRetailer]||bulkRetailer)+' preset';
   bulkPanel.hidden=!bulkRows.some(x=>x.retailer===bulkRetailer);
   bulkStatus('Select the saved profiles to jig. Retailer and rule choices come from the single controls above.');
  }catch(error){bulkRows=[];bulkSettings=null;bulkSelected.clear();renderBulkProfiles();bulkStatus(error.message,true);}finally{bulkLoading=false;bulkControls();}
 }
 bq('select-all').addEventListener('click',()=>{for(const row of bulkRows)if(row.retailer===bulkRetailer)bulkSelected.add(row.id);bulkToken=null;bq('review').hidden=true;renderBulkProfiles();});
 bq('clear').addEventListener('click',()=>{bulkSelected.clear();bulkToken=null;bq('review').hidden=true;renderBulkProfiles();});
 bq('preview').addEventListener('click',async()=>{const owner=bulkOwner();bulkLoading=true;invalidateReuse();try{
   const ruleIds=bulkRuleIds(),profileIds=[...bulkSelected],state=mainRuleState(),reuseCount=Number(bq('reuse-count').value);
   const optionalUnitCount=bq('optional-unit').checked?Number(bq('optional-unit-count').value):0;
   if(bq('optional-unit').checked&&(!Number.isSafeInteger(optionalUnitCount)||optionalUnitCount<1||optionalUnitCount>profileIds.length))
    throw Error('Set an optional unit quantity from 1 to '+profileIds.length+' (unitless profiles only).');
   if(bq('reuse-toggle').checked&&(!bq('reuse-choice').value||!Number.isSafeInteger(reuseCount)||reuseCount<2||reuseCount>profileIds.length))
    throw Error('Select an exact Main/Jigged address and a number from 2 to '+profileIds.length+'.');
   const reuse=bq('reuse-toggle').checked?{sourceId:bq('reuse-choice').value,count:reuseCount}:null;
   bulkStatus(bq('postal-scan').checked?'Checking online ZIP-to-city matches for selected addresses…':'Preparing offline jig preview…');
   const distribution={enabled:bq('distribution-toggle').checked,counts:Object.fromEntries([...bq('distribution-rows').querySelectorAll('[data-style]')].map(x=>[x.dataset.style,Number(x.value)]))};
    const result=await library.batchJigPreview({...owner,retailer:bulkRetailer,profileIds,ruleIds,hardCounts:distribution.enabled||!panel.querySelector('[data-enable-hard-counts]').checked?null:selectedHardCounts(),distribution,optionalUnitCount,combine:state.combine,billingSameAsShipping:$('workshopMirror').checked,reuse,postalScan:bq('postal-scan').checked,postalApplyCities:bq('postal-scan').checked&&bq('postal-apply').checked});
   bulkToken=result.token;bulkDuplicateCount=(result.duplicateAddresses||[]).length;
   if(optionalUnitCount!==result.optionalUnitAdded)throw Error('The selected unit count did not match the preview; do not apply this batch.');
   const addedNote=d.createElement('p');addedNote.textContent=result.optionalUnitAdded+' optional second-line unit(s) added in preview. Existing units are unchanged.';
   bq('allow-duplicate').checked=false;bq('duplicate-warning').hidden=!bulkDuplicateCount;
   const out=bq('review-rows');out.replaceChildren();out.append(addedNote);if(result.distribution) {const info=d.createElement('p');info.textContent='Jig distribution: '+Object.entries(result.distribution).map(([style,n])=>style+': '+n).join(' · ');out.append(info);}
   if(bulkDuplicateCount){
    const heading=d.createElement('p');heading.textContent=bulkDuplicateCount+' jig address(es) already belong to other saved accounts. Saving is disabled until you explicitly allow these duplicates.';out.append(heading);
    for(const clash of result.duplicateAddresses.slice(0,100)){
     const info=d.createElement('p');
     info.textContent=clash.email+' → '+clash.address+' · also used by '+clash.matches.map(x=>x.email+' ('+x.retailer+')').join(', ');
     out.append(info);
    }
   }
   if(result.postalScanned){const info=d.createElement('p');info.textContent='Online ZIP directory: '+result.postalScanned+' ZIP/city source(s) checked · '+result.postalCityCandidates+' alternative cities found · '+result.postalCityApplied+' applied. These are not USPS street delivery confirmations.';out.append(info);}
   const groupViews=new Map();
    for(const row of result.profiles.slice(0,150)){
     const base=row.mainAddress||row.before,key=[base.address1,base.address2,base.city,base.state,base.zip].join('|');
     let group=groupViews.get(key);if(!group){group=d.createElement('details');group.open=false;const summary=d.createElement('summary');summary.textContent=[base.address1,base.address2,base.city,base.state,base.zip].filter(Boolean).join(', ');group.append(summary);out.append(group);groupViews.set(key,group);}
     const line=d.createElement('p');line.style.cssText='padding:9px;border-left:3px solid #45e5a8;background:#101d2b';
     const modified=['address1','address2'].some(k=>row.before[k]!==row.after[k]);
     const heading=d.createElement('strong');heading.textContent=(row.label||row.email)+' · '+(modified?'JIGGED':row.postalCityApplied?'POSTAL CITY ONLY':'UNCHANGED');
     heading.style.color=modified?'#45e5a8':'#ffc46e';line.append(heading);
     const original=d.createElement('div');original.textContent='Original: '+[row.before.address1,row.before.address2,row.before.city,row.before.state,row.before.zip].filter(Boolean).join(', ');
     original.style.color='#a8b7cc';line.append(original);
     const changed=d.createElement('div');changed.append(d.createTextNode('JIGGED: '));
     for(const key of ['address1','address2','city','state','zip']){
      if(!row.after[key])continue;
      if(changed.childNodes.length>1)changed.append(d.createTextNode(', '));
      const word=d.createElement('span');word.textContent=row.after[key];
      word.style.color=row.after[key]!==row.before[key]?'#45e5a8':'#bac6d6';
      if(row.after[key]!==row.before[key])word.style.fontWeight='700';
      changed.append(word);
     }
     line.append(changed);
     if(row.appliedRuleIds?.length){const applied=d.createElement('small');applied.textContent='Applied: '+row.appliedRuleIds.map(id=>id==='second-line.add'?'Added second-line unit':id).join(', ');applied.style.color='#8dddd4';line.append(applied);}
     group.append(line);
    }
    for(const group of groupViews.values()){const qty=group.querySelectorAll('p').length;group.querySelector('summary').textContent+=' · '+qty+' profile'+(qty===1?'':'s');}
   if(result.profiles.length>150){const more=d.createElement('p');more.textContent='+'+(result.profiles.length-150)+' more selected profiles included.';out.append(more);}bq('review').hidden=false;bq('review').open=true;bulkStatus('Preview ready: '+result.changed+' of '+result.count+' selected profiles will change'+(result.reused?' · '+result.reused+' profiles will reuse the chosen Main/Jigged shipping address':'')+'.');
  }catch(error){bulkStatus(error.message,true);}finally{bulkLoading=false;bulkControls();}});
 bq('apply').addEventListener('click',async()=>{if(!bulkToken)return;if(!confirm('Apply this reviewed jig to all '+bulkSelected.size+' selected profiles?'))return;bulkLoading=true;bulkControls();try{const result=await library.batchJigCommit({token:bulkToken,confirmed:true,allowDuplicateAddresses:bulkDuplicateCount>0&&bq('allow-duplicate').checked});bulkToken=null;await loadBulk(bulkRetailer);bulkStatus('Jigged '+result.updated+' selected profile(s) together'+(result.remoteSaved?' · '+result.remoteSaved+' synced to website/app':'')+'.');}catch(error){bulkStatus(error.message,true);}finally{bulkLoading=false;bulkControls();}});
 d.addEventListener('jigstudio:bank-context-updated',()=>{const owner=bulkOwner();if(bulkKey(owner)!==bulkOwnerKey)void loadBulk(bulkRetailer);});
 bulkStatus('Saved profiles use the retailer preset selected above.');

 function sectionByText(pattern){
  for(const el of d.querySelectorAll('section,details,article,fieldset')){
   const heading=el.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > summary');
   if(heading&&pattern.test(String(heading.textContent||'').replace(/\s+/g,' ').trim()))return el;
  }
  return null;
 }
 function checkboxByText(pattern){
  for(const label of d.querySelectorAll('label')){
   if(pattern.test(String(label.textContent||'').replace(/\s+/g,' ').trim()))return label.querySelector('input[type="checkbox"]');
  }
  return null;
 }
 function setChecked(pattern,value=true){const box=checkboxByText(pattern);if(box&&box.checked!==value){box.checked=value;box.dispatchEvent(new Event('change',{bubbles:true}));}}
 function simplifyLegacyJigUI(){
  const duplicateNames=sectionByText(/Names\s*&\s*profile information/i);if(duplicateNames)duplicateNames.hidden=true;
  const examples=[...d.querySelectorAll('details')].find(el=>/jig types and examples/i.test(el.textContent||''));if(examples)examples.hidden=true;
  for(const label of d.querySelectorAll('label')){
   const t=String(label.textContent||'').replace(/\s+/g,' ').trim();
   if(/Three-letter address prefixes|Custom ZIP\+4 suffix|Use the same name for shipping\s*&\s*billing|Edit billing recipient name|Cardholder name and payment data/i.test(t)){const row=label.closest('article,div,label');if(row)row.hidden=true;}
  }
  // Do not expose a second copy of the same retailer/rule actions in customer scope.
  for(const el of d.querySelectorAll('section,article,details')){
   const title=String(el.querySelector?.(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > summary')?.textContent||'').replace(/\s+/g,' ').trim();
   if(/^(Jig saved profiles|Names\s*&\s*profile information)$/i.test(title)&&el!==bulkPanel)el.hidden=true;
  }
 }
 function paintPreset(){
  const names={target:/^Target Jig$/i,walmart:/^Walmart Jig$/i,pokemoncenter:/^PKC Jig$/i};
  for(const button of d.querySelectorAll('button')){
   const text=String(button.textContent||'').replace(/\s+/g,' ').trim();
   const id=Object.entries(names).find(([,rx])=>rx.test(text))?.[0];
   if(!id)continue;
   const active=id===activeRetailerPreset;
   button.classList.toggle('retailerPresetActive',active);button.setAttribute('aria-pressed',String(active));
  }
 }
 function chooseRetailerPreset(retailerId){
  activeRetailerPreset=retailerId;bulkRetailer=retailerId;bulkToken=null;
  if(retailerId==='target'){
   setChecked(/Street suffix formatting/i,true);setChecked(/Compass directions/i,true);setChecked(/Street ordinals/i,true);setChecked(/Existing suite\s*\/\s*apartment labels/i,true);
   setChecked(/Fractional house numbers/i,true);setChecked(/Alphanumeric house number/i,true);
  }
  paintPreset();void loadBulk(retailerId);
 }
 function presetId(button){
  const t=String(button?.textContent||'').replace(/\s+/g,' ').trim();
  return /^Target Jig$/i.test(t)?'target':/^Walmart Jig$/i.test(t)?'walmart':/^PKC Jig$/i.test(t)?'pokemoncenter':null;
 }
 function bindPresetButtons(){
  for(const button of d.querySelectorAll('button')){
   const retailerId=presetId(button);
   if(!retailerId||button.dataset.simplePresetBound==='true')continue;
   button.dataset.simplePresetBound='true';
   button.addEventListener('click',()=>{
    chooseRetailerPreset(retailerId);
    // Legacy controls can repaint after their own click handler. Re-assert the
    // single authoritative preset after those updates so the active button and
    // Target defaults never visually fall out of sync.
    for(const delay of [0,50,200])setTimeout(()=>{chooseRetailerPreset(retailerId);paintPreset();},delay);
   });
  }
  paintPreset();
 }
 const simpleStyle=d.createElement('style');simpleStyle.textContent='.retailerPresetActive{border-color:#24e8ff!important;box-shadow:0 0 0 2px rgba(36,232,255,.28)!important;background:rgba(36,232,255,.18)!important;color:#fff!important;outline:1px solid #24e8ff!important;outline-offset:1px!important}';d.head.append(simpleStyle);
 const presetObserver=new MutationObserver(()=>{bindPresetButtons();paintPreset();});
 presetObserver.observe($('studioJigBanks'),{childList:true,subtree:true});
 simplifyLegacyJigUI();bindPresetButtons();setTimeout(()=>{simplifyLegacyJigUI();bindPresetButtons();chooseRetailerPreset(activeRetailerPreset);},0);

 for(const box of panel.querySelectorAll('[data-hard-count]'))box.addEventListener('change',()=>{try{selectedHardCounts();invalidate();bulkToken=null;bq('review').hidden=true;bulkControls();}catch(e){note(e.message,true);}});
 for(const id of ['workshopAddress','workshopCard','workshopName'])$(id).addEventListener('change',async()=>{invalidate();importer()?.beginWorkshop?.();const c=checked();$('workshopAddresses').hidden=!c.address;$('workshopCards').hidden=!c.card;if((c.address||c.card)&&!assets)await loadAssets();controls();});
 for(const id of ['workshopMirror','workshopStyles','workshopReuse'])$(id).addEventListener('change',invalidate);
 $('workshopUnused').addEventListener('change',()=>{picks.cards.clear();invalidate();assetRows();});
 async function preparePreview(){if(busy)return false;const c=context();if(!c)return false;busy=true;seenKey=c.contextKey;seenSourceKey=window.ACOWorkspaceCore.sourceIdentity(c);invalidate();controls();try{
  await unlock(c);const req={...c,choices:checked(),addressIds:[...picks.addresses],cardIds:[...picks.cards],unusedOnly:$('workshopUnused').checked,allowCardReuse:false,mirrorBilling:checked().address&&$('workshopMirror').checked,addressOptions:{applyStyles:checked().address&&$('workshopStyles').checked,rules:(c.addressRules||[]).filter(id=>activeRetailerPreset!=='target'||!/(fraction|alphanumeric|house.*letter|letter.*house)/i.test(String(id))),combineStyles:c.combineStyles,retailerPreset:activeRetailerPreset,hardCounts:checked().address&&$('workshopStyles').checked?selectedHardCounts():{fraction:0,hyphen:0,doubleLetter:0,randomUnit:0},extraAllocation:Object.fromEntries([...picks.addresses].map(id=>[id,extraAllocation[id]||0])),targetPrimary:null}};
  plan=await api.preview(req);if(context()?.contextKey!==c.contextKey){await api.cancel(plan.token);plan=null;throw Error('Profile selection changed. Preview again.');}
  const view=await api.apply({token:plan.token,contextKey:c.contextKey,confirmed:true});importer().acceptWorkshopPreview(view);plan.applied=true;
  $('workshopReview').hidden=false;$('workshopReview').open=true;
  const groups=new Map();
   for(const r of plan.preview){
    const base=r.mainAddress,groupKey=base?[base.address1,base.address2,base.city,base.state,base.zip].join('|'):(r.addressId||'profile-'+r.index);
    let group=groups.get(groupKey);
    if(!group){group=d.createElement('details');const heading=d.createElement('summary');heading.textContent=base?[base.address1,base.address2,base.city,base.state,base.zip].filter(Boolean).join(', '):'Saved address '+(r.addressId||r.index+1);group.append(heading);groups.set(groupKey,group);$('workshopReviewRows').append(group);}
    const line=d.createElement('p');line.textContent='Profile '+(r.index+1)+': '+[r.category?'Jig: '+r.category:'',r.name?'Name: '+r.name:'',r.address?.length?'Address: '+r.address.map(x=>x.text).join(' / '):'',r.cardLast4?'Card ending '+r.cardLast4:''].filter(Boolean).join(' | ');group.append(line);
   }
   for(const group of groups.values()){const count=group.querySelectorAll('p').length;group.querySelector('summary').textContent+=' · '+count+' profile'+(count===1?'':'s');}
  note('Preview ready: '+plan.selected+' selected, '+plan.changed+' changed. Review profiles and export. Saving to the vault is optional and separate.');return true;
 }catch(e){if(plan)void api.cancel(plan.token);plan=null;note(e.message,true);return false;}finally{busy=false;controls();}}
 function prepareReview(){if(previewTask)return previewTask;if(plan?.applied&&plan.contextKey===context()?.contextKey)return Promise.resolve(true);if(!Object.values(checked()).some(Boolean)){note('Select Address, Card information and/or Name first. Nothing has been changed.');return Promise.resolve(false);}previewTask=preparePreview().finally(()=>{previewTask=null;});return previewTask;}
 $('workshopPreview').addEventListener('click',()=>void prepareReview());
 const confirmPayload=()=>({token:plan.token,contextKey:context()?.contextKey,confirmed:true});
 $('workshopApply').addEventListener('click',async()=>{if(!plan||busy)return;busy=true;controls();try{const r=await api.apply(confirmPayload());importer().acceptWorkshopPreview(r);plan.applied=true;note('Applied only the checked fields to this file preview. The original file and vault are unchanged until saved.');}catch(e){note(e.message,true);}finally{busy=false;controls();}});
 $('workshopSave').addEventListener('click',async()=>{if(!plan||busy)return;if(!confirm('Save ONLY the checked fields to '+ownerText(plan)+'? Other vaults and unchecked fields will not be changed.'))return;busy=true;controls();try{const r=await api.save(confirmPayload());plan.saved=true;const view=await api.apply(confirmPayload());importer().acceptWorkshopPreview(view);plan.applied=true;void window.ACOProfileBank?.refresh?.();note(r.updated+' profile(s) saved in '+ownerText(plan)+'. Saved card usage is now reflected in the vault.');}catch(e){note(e.message,true);}finally{busy=false;controls();}});
 $('workshopExport').addEventListener('click',async()=>{if(!plan||busy)return;busy=true;controls();try{const r=await api.exportFile(confirmPayload());if(r.saved)note('Exported '+r.name+'. Original input files were not edited.');}catch(e){note(e.message,true);}finally{busy=false;controls();}});
 $('workshopLegacy').addEventListener('click',()=>{invalidate();for(const id of ['workshopAddress','workshopCard','workshopName'])$(id).checked=false;$('workshopAddresses').hidden=true;$('workshopCards').hidden=true;try{importer()?.endWorkshop?.();note('Previous formatting controls restored for this file. No vault data was changed.');}catch(e){note(e.message,true);}controls();});
 function contextChanged(){const c=context(),key=c?.contextKey||'';if(key===seenKey)return;seenKey=key;const identity=window.ACOWorkspaceCore.sourceIdentity(c);if(c&&identity===seenSourceKey){invalidate();note('Formatting changed. Your address and card selections are retained; prepare a new preview.');return;}seenSourceKey=identity;assetEpoch++;loading=false;assets=null;picks={addresses:new Set(),cards:new Set()};extraAllocation={};invalidate();for(const id of ['workshopAddress','workshopCard','workshopName','workshopMirror','workshopStyles','workshopReuse'])$(id).checked=false;$('workshopAddresses').hidden=true;$('workshopCards').hidden=true;note('Choose Address, Card information and/or Name. Unchecked fields stay unchanged.');controls();}
 d.addEventListener('jigstudio:bank-context-updated',contextChanged);d.addEventListener('jigstudio:workshop-context-changed',contextChanged);
 // Scoped vault modal, with search/paging instead of an endlessly growing list.
 const modal=d.createElement('div');modal.className='workshopModal';modal.hidden=true;
 modal.innerHTML=`<div class="workshopBox" role="dialog" aria-modal="true" aria-labelledby="workshopVaultTitle"><div class="workshopHead"><div><h2 id="workshopVaultTitle">Cards &amp; Addresses Vault</h2><p id="workshopVaultOwner"></p></div><button class="btn plain slim" data-close type="button" aria-label="Close vault">X</button></div>
 <div class="buttons"><button class="btn secondary slim" data-tab="cards" type="button">Cards</button><button class="btn secondary slim" data-tab="addresses" type="button">Addresses</button><button class="btn secondary slim" data-tab="profiles" type="button">In Progress</button><button class="btn secondary slim" data-tab="completed" type="button">Completed Profiles</button><button class="btn primary slim" data-add type="button">+ Add card</button></div><input id="workshopVaultSearch" type="search" placeholder="Search card number, linked email, retailer or label" aria-label="Search Card Bank by number, email, retailer or label"><div class="buttons" data-bulk-cards hidden><button type="button" class="btn secondary slim" data-reconcile-cards>Review missing Card Bank entries</button><span data-bank-summary role="status"></span><button type="button" class="btn secondary slim" data-card-select-page>Select All on Page</button><button type="button" class="btn plain slim" data-card-clear>Clear selection</button><button type="button" class="btn primary slim" data-bulk-set-hard disabled>Set Hard Card for selected</button><button type="button" class="btn secondary slim" data-bulk-unset-hard disabled>Remove Hard Card for selected</button><span data-card-selected-count role="status"></span></div><div id="workshopVaultRows"></div><div class="buttons"><button class="btn slim plain" data-prev type="button">Previous</button><span data-page></span><button class="btn slim plain" data-next type="button">Next</button></div><div id="workshopVaultForm" hidden></div><p id="workshopVaultStatus" role="status"></p></div>`;
 d.body.append(modal);let vaultScope=null,vaultData=null,tab='cards',page=0,vaultTicket=0,selectedCards=new Set(),bankRepairBusy=false;
 const vnote=(s,error=false)=>{$('workshopVaultStatus').textContent=s;$('workshopVaultStatus').classList.toggle('profileBankError',error);};
 // A distinct card appears once in cardPool, even when several retailer profiles
 // use it. Only exact vault-scoped profile records without a saved bank entry
 // qualify for this optional, explicit repair.
 const missingBankEntries=()=> (vaultData?.cardPool||[]).filter(card=>!card.fromSavedBank&&typeof card.id==='string'&&card.id.startsWith('profile:'));
 const field=(name,label,type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" autocomplete="off" ${extra}></label>`;
 async function refreshVault(){const ticket=++vaultTicket,scope={...vaultScope};const data=await api.assets({...scope,showFullCards:true});if(ticket!==vaultTicket||modal.hidden)return;vaultData=data;renderVault();}
 function renderVault(){const q=$('workshopVaultSearch').value.toLowerCase();const rows=(tab==='cards'?(vaultData?.cardPool||[]):tab==='profiles'?(vaultData?.profiles||[]).filter(x=>x.stage!=='completed'):tab==='completed'?(vaultData?.profiles||[]).filter(x=>x.stage==='completed'):(vaultData?.[tab]||[])).filter(x=>[x.label,x.email,x.fullNumber,x.last4,x.address1,x.city,...(x.linkedAccounts||[]).flatMap(a=>[a.email,retail[a.retailer]||a.retailer])].filter(Boolean).join(' ').toLowerCase().includes(q));const pages=Math.max(1,Math.ceil(rows.length/10));page=Math.min(page,pages-1);modal.querySelector('[data-bulk-cards]').hidden=tab!=='cards';
  const missingBank=missingBankEntries(),savedBank=(vaultData?.cardPool||[]).filter(card=>card.fromSavedBank).length;
  const reconcile=modal.querySelector('[data-reconcile-cards]');
  reconcile.textContent='Review / restore '+missingBank.length+' missing bank '+(missingBank.length===1?'entry':'entries');
  reconcile.disabled=bankRepairBusy||tab!=='cards'||!missingBank.length;
  reconcile.hidden=tab!=='cards'||!missingBank.length;
  modal.querySelector('[data-bank-summary]').textContent=savedBank+' in Card Bank · '+missingBank.length+' saved in profiles only';
  $('workshopVaultRows').replaceChildren();modal.querySelector('[data-page]').textContent=(page+1)+' / '+pages+' | '+rows.length+' items';modal.querySelector('[data-prev]').disabled=page===0;modal.querySelector('[data-next]').disabled=page+1===pages;
  modal.querySelector('[data-add]').textContent=tab==='cards'?'+ Add card':tab==='addresses'?'+ Add address':'+ Create Blank Profile';
  for(const button of modal.querySelectorAll('[data-tab]'))button.setAttribute('aria-pressed',String(button.dataset.tab===tab));
  const shown=rows.slice(page*10,page*10+10);
   selectedCards=new Set([...selectedCards].filter(ref=>shown.some(x=>x.id===ref)));
   modal.querySelector('[data-bulk-set-hard]').disabled=tab!=='cards'||!selectedCards.size;
   modal.querySelector('[data-bulk-unset-hard]').disabled=tab!=='cards'||!selectedCards.size;
   modal.querySelector('[data-card-selected-count]').textContent=selectedCards.size+' selected on this page';
   for(const r of shown){const line=d.createElement('article');line.className='workshopVaultRow';const text=d.createElement('span');text.textContent=tab==='cards'?[r.label,r.cardholder,r.number||('ending '+r.last4),r.expMonth+'/'+r.expYear,r.unused?'Unused':r.usedCount?'Used in '+r.usedCount+' profile(s)':'Previously assigned'].join(' | '):tab==='addresses'?[r.label,r.address1,r.address2,r.city,r.state,r.zip].filter(Boolean).join(' | '):[r.label,retail[r.retailer],r.email||'Email not yet entered',r.stage==='completed'?'Completed':r.status,...(r.stage!=='completed'&&r.missing?.length?['Needs: '+r.missing.join(', ')]:[])].join(' | ');line.append(text);
   if(tab==='cards'){
    text.replaceChildren();
    const heading=d.createElement('strong');heading.textContent=r.fullNumber||('Card ending '+r.last4);heading.style.cssText='display:block;font-weight:700;word-break:break-all';
    const linked=d.createElement('small');linked.style.display='block';
    linked.textContent=r.linkedAccounts?.length?r.linkedAccounts.map(a=>a.email+' · '+(retail[a.retailer]||a.retailer)).join(' | '):'Unused · no linked retailer accounts';
    const meta=d.createElement('small');meta.style.display='block';
    meta.textContent=[r.expiry,r.hardCard?'Hard Card':'Regular card',r.status,r.availableRetailers?.length?'Available for '+r.availableRetailers.map(x=>retail[x]||x).join(', '):'Not eligible for additional profiles'].filter(Boolean).join(' · ');
    const bankStatus=d.createElement('small');bankStatus.style.display='block';
    bankStatus.textContent=r.fromSavedBank?'Saved in Card Bank':'Saved in profile only · separate bank entry missing';
    text.append(heading,linked,meta,bankStatus);
    const cb=d.createElement('input');cb.type='checkbox';cb.setAttribute('aria-label','Select card ending '+r.last4);
    cb.checked=selectedCards.has(r.id);cb.onchange=()=>{if(cb.checked)selectedCards.add(r.id);else selectedCards.delete(r.id);renderVault();};line.prepend(cb);
    const toggle=d.createElement('button');toggle.type='button';toggle.className='btn slim secondary';toggle.textContent=r.hardCard?'Remove Hard Card':'Set Hard Card';
    toggle.onclick=async()=>{
     if(!confirm((r.hardCard?'Remove':'Set')+' Hard Card for card ending '+r.last4+' in '+ownerText(vaultScope)+'? Other vaults are unaffected.'))return;
     toggle.disabled=true;
     try{const result=await api.setHardCard({...vaultScope,cardRef:r.id,hard:!r.hardCard,confirmed:true});selectedCards.clear();await refreshVault();vnote('Updated the card in this vault: '+result.matchedProfiles+' matching profiles and '+result.savedCardCopies+' saved card copies across all retailer pools.');}
     catch(e){vnote(e.message,true);toggle.disabled=false;}
    };line.append(toggle);line.onclick=e=>{if(e.target.closest('button,input'))return;if(storedForClick())openResourceForm('cards',storedForClick());};function storedForClick(){return (vaultData?.cards||[]).find(x=>'saved:'+x.id===r.id)||null;}line.oncontextmenu=e=>{e.preventDefault();if(storedForClick())openResourceForm('cards',storedForClick());};
    const stored=(vaultData?.cards||[]).find(x=>'saved:'+x.id===r.id);
    if(stored){
     const edit=d.createElement('button');edit.type='button';edit.className='btn slim secondary';edit.textContent='View / Edit';edit.onclick=()=>openResourceForm('cards',stored);
     const remove=d.createElement('button');remove.type='button';remove.className='btn slim plain';remove.textContent='Remove saved bank copy';
     remove.onclick=async()=>{
      if(!confirm('Remove the separate Card Bank copy? The card remains in its existing profiles, but is no longer available as a saved bank resource.'))return;
      remove.disabled=true;
      try{await api.manageResource({...vaultScope,kind:'card',operation:'remove',resourceId:stored.id});selectedCards.clear();await refreshVault();vnote('Saved card removed from this vault.');}
      catch(e){vnote(e.message,true);remove.disabled=false;}
     };line.append(edit,remove);
    }else{
     const view=d.createElement('button');view.type='button';view.className='btn slim secondary';view.textContent='View / Edit';
     view.onclick=()=>{
      const profileId=String(r.id||'').replace(/^profile:/,'');
      if(!profileId)throw Error('Matching imported profile is unavailable.');
      const owner={...vaultScope};
      closeVault();
      d.dispatchEvent(new CustomEvent('aco-studio:edit-profile',{detail:{...owner,profileId}}));
     };
     line.append(view);
     const save=d.createElement('button');save.type='button';save.className='btn slim secondary';save.textContent='Restore bank entry';
     save.onclick=async()=>{
      if(!confirm('Restore the missing saved Card Bank entry from this existing profile? Exact-number duplicates are skipped. Linked profiles and their separate references remain unchanged.'))return;
      save.disabled=true;
      try{await api.addProfileCardToBank({...vaultScope,profileId:r.id.slice(8),confirmed:true});selectedCards.clear();await refreshVault();vnote('Saved Card Bank entry restored without changing the original profile.');}
      catch(e){vnote(e.message,true);save.disabled=false;}
     };line.append(save);
    }
    $('workshopVaultRows').append(line);continue;
   }
   if(tab==='profiles'||tab==='completed'){for(const [title,action]of [['Full profile','full'],['Open in Studio','open'],['Export profile','export'],...(r.createdInWorkshop?[['Edit fields','edit']]:[])]){const b=d.createElement('button');b.className='btn slim secondary';b.type='button';b.textContent=title;b.addEventListener('click',async()=>{try{if(action==='full'){const fixed={...vaultScope},result=await window.desktopAPI.profileBanks.view(fixed.scope,fixed.customerId,r.id);if(modal.hidden||fixed.scope!==vaultScope.scope||fixed.customerId!==vaultScope.customerId)return;const box=d.createElement('div');box.className='workshopModal profileFullDetails';box.style.zIndex='12500';const body=d.createElement('div');body.className='workshopBox';const heading=d.createElement('h2');heading.textContent=ownerText(fixed)+' | Full profile';const pre=d.createElement('pre');pre.style.whiteSpace='pre-wrap';pre.textContent=JSON.stringify(result.profile.data,null,2);const close=d.createElement('button');close.type='button';close.className='btn secondary';close.textContent='Close';close.onclick=()=>box.remove();body.append(heading,pre,close);box.append(body);d.body.append(box);}else if(action==='export')await api.exportSaved({...vaultScope,profileId:r.id});else if(action==='edit'){const data=await api.load({...vaultScope,profileId:r.id});openDraft(vaultScope,data);}else{const data=await api.load({...vaultScope,profileId:r.id});await importer().loadWorkshopProfile(data);closeVault();d.dispatchEvent(new CustomEvent('jigstudio:navigate-stage',{detail:{stage:'settings'}}));panel.scrollIntoView({block:'center'});note('Profile loaded from '+ownerText(data)+'. Select the fields to fill from this vault.');}}catch(e){vnote(e.message,true);}});line.append(b);}}
   if(tab==='cards'||tab==='addresses'){
    const kind=tab,b=d.createElement('button'),edit=d.createElement('button'),remove=d.createElement('button'),c=context();
    b.type=edit.type=remove.type='button';b.className='btn slim secondary';edit.className='btn slim secondary';remove.className='btn slim plain';
    b.textContent=kind==='cards'?'Use card':'Use address';edit.textContent='Edit';remove.textContent='Remove';
    b.disabled=busy||!c||!c.indices.length||c.scope!==vaultScope.scope||(c.customerId||null)!==(vaultScope.customerId||null);
    b.addEventListener('click',async()=>{try{
     const selected=context();if(busy||!selected||selected.scope!==vaultScope.scope||(selected.customerId||null)!==(vaultScope.customerId||null))throw Error('Open a profile in this same vault first.');
     await unlock(selected);
     if(kind==='cards'&&!r.unused&&$('workshopUnused').checked)throw Error('This card is not eligible for the selected retailer. Hard Cards permit only one assignment per retailer.');
     invalidate();importer().beginWorkshop();
     $(kind==='cards'?'workshopCard':'workshopAddress').checked=true;picks[kind]=new Set([r.id]);
     $('workshopAddresses').hidden=!checked().address;$('workshopCards').hidden=!checked().card;
     closeVault();controls();panel.scrollIntoView({block:'center'});
     note((kind==='cards'?'Saved card selected. ':'Saved address selected. ')+'Click Preview selected changes before saving. Other checkboxes were not changed.');
    }catch(error){vnote(error.message,true);}});
    edit.addEventListener('click',()=>openResourceForm(kind,r));
    remove.addEventListener('click',async()=>{if(!confirm('Remove this saved '+(kind==='cards'?'card':'address')+' from this exact vault? Profiles already containing its copied values are not moved to another vault.'))return;remove.disabled=true;try{await api.manageResource({...vaultScope,kind:kind==='cards'?'card':'address',operation:'remove',resourceId:r.id});await refreshVault();vnote('Removed from this vault.');}catch(error){vnote(error.message,true);remove.disabled=false;}});
    line.append(b,edit,remove);
   }
   $('workshopVaultRows').append(line);
  }if(!rows.length)$('workshopVaultRows').textContent='Nothing saved here yet. Use the Add button.';
 }
 // This is deliberately owner-confirmed rather than automatic on every load:
 // a removed saved copy must not reappear silently, and imported profiles
 // remain intact even when a bank repair cannot be completed.
 modal.querySelector('[data-reconcile-cards]').onclick=async()=>{
  if(bankRepairBusy||!vaultData||!vaultScope)return;
  const scope=vaultScope,owner={...scope},missing=missingBankEntries().map(card=>({id:card.id,last4:card.last4}));
  if(!missing.length)return vnote('Every listed card already has a saved Card Bank entry.');
  if(!confirm('Restore '+missing.length+' missing Card Bank '+(missing.length===1?'entry':'entries')+' from cards already stored in this exact vault? This adds only missing, exact-number bank copies; existing profiles, Hard Card settings and independent references are preserved.'))return;
  bankRepairBusy=true;renderVault();
  let restored=0,alreadySaved=0,failed=0;const failures=[];
  try{
   for(let i=0;i<missing.length;i++){
    if(modal.hidden||vaultScope!==scope){vnote('Bank reconciliation stopped because the selected vault changed.');break;}
    const card=missing[i];
    try{
     const result=await api.addProfileCardToBank({...owner,profileId:card.id.slice(8),confirmed:true});
     if(result?.alreadyExists===true)alreadySaved++;
     else if(result?.saved===true)restored++;
     else throw Error('The saved bank copy was not verified.');
    }catch(error){failed++;if(failures.length<5)failures.push('ending '+card.last4+': '+String(error.message||error));}
    vnote('Card Bank reconciliation '+(i+1)+'/'+missing.length+' · '+restored+' restored · '+alreadySaved+' already saved · '+failed+' need review');
   }
  }finally{
   bankRepairBusy=false;
   if(!modal.hidden&&vaultScope===scope){
    try{await refreshVault();vnote('Card Bank reconciliation: '+restored+' restored, '+alreadySaved+' already saved, '+failed+' need review.'+(failures.length?' '+failures.join(' | '):''),failed>0);}
    catch(error){vnote('Reconciliation results could not be refreshed: '+String(error.message||error),true);}
   }
  }
 };
 async function openVault(p=fallback(),initial='cards',search=''){try{await unlock(p);vaultScope={scope:p.scope,customerId:p.customerId||null};tab=initial;page=0;selectedCards.clear();vaultData=null;modal.style.zIndex='11600';modal.hidden=false;$('workshopVaultOwner').textContent=ownerText(p)+' | No transfers to another vault';$('workshopVaultSearch').value=String(search||'');$('workshopVaultForm').replaceChildren();$('workshopVaultForm').hidden=true;vnote('Loading this vault...');await refreshVault();vnote('Full saved card numbers and expiration dates are shown in this vault. "Unused" means not assigned by this app or present in its saved profiles.');modal.querySelector('[data-close]').focus();}catch(e){note(e.message,true);}}
 function closeVault(){d.querySelectorAll('.profileFullDetails').forEach(x=>x.remove());vaultTicket++;modal.hidden=true;vaultData=null;selectedCards.clear();$('workshopVaultForm').replaceChildren();$('workshopVaultForm').hidden=true;if(checked().card||checked().address)void loadAssets();}
 for(const b of modal.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>{tab=b.dataset.tab;page=0;selectedCards.clear();$('workshopVaultForm').replaceChildren();$('workshopVaultForm').hidden=true;renderVault();});
 $('workshopVaultSearch').addEventListener('input',()=>{page=0;selectedCards.clear();renderVault();});
  modal.querySelector('[data-prev]').addEventListener('click',()=>{page--;selectedCards.clear();renderVault();});
  modal.querySelector('[data-next]').addEventListener('click',()=>{page++;selectedCards.clear();renderVault();});
  modal.querySelector('[data-card-select-page]').onclick=()=>{
   const q=$('workshopVaultSearch').value.toLowerCase();
   const matching=(vaultData?.cardPool||[]).filter(x=>[x.label,x.fullNumber,x.last4,...(x.linkedAccounts||[]).flatMap(a=>[a.email,retail[a.retailer]||a.retailer])].filter(Boolean).join(' ').toLowerCase().includes(q));
   selectedCards=new Set(matching.slice(page*10,page*10+10).map(x=>x.id));renderVault();
  };
  modal.querySelector('[data-card-clear]').onclick=()=>{selectedCards.clear();renderVault();};
  for(const [buttonName,hard] of [['bulk-set-hard',true],['bulk-unset-hard',false]]){
   modal.querySelector('[data-'+buttonName+']').onclick=async()=>{
    const refs=[...selectedCards];if(!refs.length)return;
    if(!confirm((hard?'Set':'Remove')+' Hard Card for '+refs.length+' cards from this one page in '+ownerText(vaultScope)+'? This changes no other vault.'))return;
    const button=modal.querySelector('[data-'+buttonName+']');button.disabled=true;
    try{
     const result=await api.setHardCards({...vaultScope,cardRefs:refs,hard,confirmed:true});
     selectedCards.clear();await refreshVault();vnote('Updated '+result.updated+' distinct cards across '+result.matchedProfiles+' matching profiles and '+result.savedCardCopies+' saved card copies in this vault only.');
    }catch(error){vnote(error.message,true);button.disabled=false;}
   };
  }
 modal.querySelector('[data-close]').addEventListener('click',closeVault);modal.addEventListener('click',e=>{if(e.target===modal)closeVault();});
 function openResourceForm(type,existing=null){
  const holder=$('workshopVaultForm');holder.hidden=false;const form=d.createElement('form');form.autocomplete='off';form.className='workshopForm';
  form.innerHTML=type==='cards'
   ?field('number','Card number','password','inputmode="numeric" maxlength="26" required')+field('expMonth','Expiration month','text','inputmode="numeric" maxlength="2" placeholder="MM" required')+field('expYear','Expiration year','text','inputmode="numeric" maxlength="4" placeholder="YYYY" required')+field('customSecurityCode','Security Code (separate saved reference)','text','maxlength="64"')
   :field('label','Address label','text','maxlength="100" required')+field('address1','Street address','text','maxlength="160" required')+field('address2','Apartment / unit','text','maxlength="120"')+field('city','City','text','maxlength="120" required')+field('state','State','text','maxlength="2" required')+field('zip','ZIP / verified ZIP+4','text','maxlength="10" required');
  form.insertAdjacentHTML('beforeend','<div class="buttons"><button class="btn primary" type="submit">'+(existing?'Save changes':'Save to this vault')+'</button><button class="btn plain" data-cancel type="button">Cancel</button></div>');
  holder.replaceChildren(form);
  if(existing){for(const [k,v] of Object.entries({...existing,customSecurityCode:existing.customSecurityCode??existing.customReference??''})){const el=form.elements.namedItem(k);if(el&&v!=null)el.value=v;}}
  form.querySelector('[data-cancel]').addEventListener('click',()=>{holder.replaceChildren();holder.hidden=true;});const scope={...vaultScope};
  form.addEventListener('submit',async e=>{e.preventDefault();const submit=form.querySelector('[type=submit]');submit.disabled=true;try{
   const value=Object.fromEntries(new FormData(form));
   if(existing)await api.manageResource({...scope,kind:type==='cards'?'card':'address',operation:'update',resourceId:existing.id,value});
   else if(type==='cards')await api.addCard({...scope,card:value});
   else await api.addAddress({...scope,address:value});
   holder.replaceChildren();holder.hidden=true;await refreshVault();vnote((existing?'Updated':'Saved')+' in '+ownerText(scope)+' only. No other vault was changed.');
  }catch(error){vnote(error.message,true);submit.disabled=false;}});form.querySelector('input').focus();
 }
 modal.querySelector('[data-add]').addEventListener('click',()=>{if(tab==='profiles'||tab==='completed'){openDraft(vaultScope);return;}openResourceForm(tab);});
 // Create an empty structured profile or edit only its non-payment form fields.
 const draftModal=d.createElement('div');draftModal.className='workshopModal';draftModal.hidden=true;
 draftModal.innerHTML=`<div class="workshopBox" role="dialog" aria-modal="true" aria-labelledby="workshopDraftTitle"><div class="workshopHead"><div><h2 id="workshopDraftTitle">Create Blank Profile</h2><p id="workshopDraftOwner"></p></div><button class="btn slim plain" data-close type="button" aria-label="Close profile form">X</button></div><form id="workshopDraftForm" autocomplete="off"></form><p id="workshopDraftStatus" role="status"></p></div>`;d.body.append(draftModal);
 async function openDraft(p=fallback(),existing=null){try{await unlock(p);const scope={scope:p.scope,customerId:p.customerId||null},form=$('workshopDraftForm');draftModal.hidden=false;$('workshopDraftOwner').textContent=ownerText(p)+' | Blank fields may be saved as a draft';$('workshopDraftTitle').textContent=existing?'Edit Profile Fields':'Create Blank Profile';$('workshopDraftStatus').textContent='Cards stay in the card vault. Save this draft, then use the Address / Card information checkboxes to fill it.';
  form.innerHTML=`<div class="workshopForm"><label>Retailer<select name="retailer">${Object.entries(retail).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('')}</select></label><label>Profile format<select name="format"><option value="shikari">Shikari CSV</option><option value="valor">Valor JSON</option></select></label></div><details open><summary>Profile and account fields</summary><div class="workshopForm">${field('label','Profile label')+field('email','Account email','email')+field('password','Account password','password')+field('first','First name')+field('last','Last name')+field('phone','Phone')}</div><p class="tiny">Enter the person name once. Shipping name, billing name, and cardholder name automatically use this same first/last name.</p></details>${['shipping','billing'].map(r=>'<details><summary>'+r[0].toUpperCase()+r.slice(1)+' address</summary><div class="workshopForm">'+Object.entries({address1:'Street address',address2:'Apartment / unit',city:'City',state:'State',zip:'ZIP / postal code',country:'Country code',phone:'Phone'}).map(([key,label])=>field(r+'.'+key,label)).join('')+'</div></details>').join('')}<details><summary>Payment</summary><p>The saved card supplies number and expiration. Cardholder name automatically matches the profile first/last name.</p></details><div class="buttons"><button class="btn primary" type="submit">${existing?'Save profile fields':'Create draft & open in Studio'}</button><button class="btn secondary" data-open-vault type="button">Open this card / address vault</button><button class="btn plain" data-cancel type="button">Cancel</button></div>`;
  if(existing){form.elements.retailer.value=existing.retailer;form.elements.format.value=existing.format;form.elements.retailer.disabled=true;form.elements.format.disabled=true;for(const [k,v]of Object.entries(existing.fields||{}))if(form.elements.namedItem(k))form.elements.namedItem(k).value=v;}
  else{form.elements.namedItem('shipping.country').value='US';form.elements.namedItem('billing.country').value='US';form.elements.retailer.value=$('profileImportRetailer')?.value||'target';form.elements.format.value=form.elements.retailer.value==='target'?'shikari':'valor';}
  form.elements.retailer.addEventListener('change',()=>{form.elements.format.value=form.elements.retailer.value==='target'?'shikari':'valor';});
  const close=()=>{draftModal.hidden=true;form.replaceChildren();};form.querySelector('[data-cancel]').addEventListener('click',close);draftModal.querySelector('[data-close]').onclick=close;form.querySelector('[data-open-vault]').addEventListener('click',()=>void openVault(scope));
  let savedProfile=null;form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;try{const data=Object.fromEntries(new FormData(form)),retailer=existing?.retailer||data.retailer,format=existing?.format||data.format;delete data.retailer;delete data.format;
    const result=existing?await api.edit({...scope,profileId:existing.profileId,revision:existing.revision,fields:data}):await api.create({...scope,retailer,format,fields:data});
    savedProfile=result;const row=await api.load({...scope,profileId:result.id});await importer().loadWorkshopProfile(row);close();closeVault();void window.ACOProfileBank?.refresh?.();d.dispatchEvent(new CustomEvent('jigstudio:navigate-stage',{detail:{stage:'settings'}}));panel.scrollIntoView({block:'center'});note('Draft saved in '+ownerText(scope)+'. Choose Address, Card information and/or Name to fill only those fields.');
   }catch(error){$('workshopDraftStatus').textContent=savedProfile?'Your profile was saved, but opening it failed: '+error.message+'. Open it from this vault Profiles tab; do not create another copy.':error.message;button.disabled=!!savedProfile;}};
  form.elements.namedItem('label').focus();
 }catch(e){note(e.message,true);}}
 $('workshopVault').addEventListener('click',()=>void openVault());$('workshopCreate').addEventListener('click',()=>void openDraft());
 function trap(modal,e){if(e.key==='Escape'){e.preventDefault();modal.querySelector('[data-close]')?.click();}if(e.key==='Tab'){const nodes=[...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')].filter(x=>x.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&d.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&d.activeElement===last){e.preventDefault();first?.focus();}}}
 modal.addEventListener('keydown',e=>trap(modal,e));draftModal.addEventListener('keydown',e=>trap(draftModal,e));
 d.addEventListener('jigstudio:personal-locked',()=>{if(vaultScope?.scope==='personal')closeVault();d.querySelectorAll('.profileFullDetails').forEach(x=>x.remove());draftModal.hidden=true;$('workshopDraftForm').replaceChildren();void api.cancel();assets=null;picks.cards.clear();picks.addresses.clear();invalidate();assetRows();});
 window.ACOProfileWorkshop=Object.freeze({prepareReview,openVault,create:openDraft,openSaved:async p=>{
 await unlock(p);
 const row=await api.load(p);
 await importer().loadWorkshopProfile(row);
 contextChanged();
 $('workshopUnused').checked=false; // Used cards also belong to this customer's account.
 await loadAssets();
 if(!assets)throw Error('Could not load saved address/card resources for this customer.');
 picks.addresses=new Set((assets.addresses||[]).map(x=>x.id));
 picks.cards=new Set((assets.cards||[]).map(x=>x.id));
 $('workshopAddress').checked=picks.addresses.size>0;
 $('workshopCard').checked=picks.cards.size>0;
 $('workshopAddresses').hidden=!picks.addresses.size;
 $('workshopCards').hidden=!picks.cards.size;
 $('workshopReuse').checked=true;
 assetRows();invalidate();
 d.dispatchEvent(new CustomEvent('jigstudio:navigate-stage',{detail:{stage:'settings'}}));
 panel.scrollIntoView({block:'center'});
 note('Loaded all '+picks.addresses.size+' saved addresses and '+picks.cards.size+' saved cards in this vault, including cards already used. Select the ones to apply, then preview.');
}});
 const shortcuts=d.createElement('div');shortcuts.className='buttons';for(const [label,fn]of [['+ Create Blank Profile',()=>openDraft()],['Cards & Addresses Vault',()=>openVault()]]){const b=d.createElement('button');b.type='button';b.className='btn secondary';b.textContent=label;b.addEventListener('click',()=>void fn());shortcuts.append(b);}$('studioStage-import')?.querySelector('header')?.after(shortcuts);
 controls();
})();

