(()=>{'use strict';const d=document,$=id=>d.getElementById(id),api=window.desktopAPI?.profileLibrary;if(!api)return;
 const nav=d.querySelector('.appTabs');if(!nav)return;
 const personal=$('personalJigsTab'),customer=nav.querySelector('[data-tab="jig"]'),settings=nav.querySelector('[data-quick="settings"]'),notifications=nav.querySelector('[data-quick="notifications"]'),email=nav.querySelector('[data-tab="email"]'),admin=nav.querySelector('[data-tab="admin"]');
 function separator(label){const line=d.createElement('hr'),title=d.createElement('div');line.className='profileNavLine';title.className='profileNavLabel';title.textContent=label;nav.append(line,title);}
 // Preserve existing controls and handlers while grouping the sidebar explicitly.
 for(const node of [admin])if(node)nav.append(node);
 const customerProfiles=d.createElement('button');customerProfiles.type='button';customerProfiles.className='tabButton profileNavChild';customerProfiles.innerHTML='<span class="navIcon">▤</span><span>Profiles</span>';customer?.after(customerProfiles);
 separator('PERSONAL');if(personal)nav.append(personal);const personalProfiles=customerProfiles.cloneNode(true);nav.append(personalProfiles);if(email)nav.append(email);
 separator('SETTINGS');if(settings)nav.append(settings);if(notifications)nav.append(notifications);
 // Duplicate older workspaces remain installed but are no longer primary tabs.
 for(const el of [customer,personal,settings,nav.querySelector('[data-tab="site"]')])if(el){el.hidden=true;el.style.display='none';el.setAttribute('aria-hidden','true');}
 // Remove duplicate Quick Actions individually; retain every unrelated
 // shortcut (including Settings, Drop News and diagnostics).
 // Remove redundant Quick Action links from the sidebar only. The
 // import and customer-directory functions remain available elsewhere.
 const sidebar=d.querySelector('.desktop-sidebar');
 if(sidebar){
  const hideDuplicateShortcuts=()=>{
   for(const element of sidebar.querySelectorAll('button,a,[role="button"]')){
    const label=(element.textContent||'').trim().replace(/\s+/g,' ').toLowerCase();
    if(element.hidden||!/(?:^|\s)(?:import profiles|customer directory)$/.test(label))continue;
    element.hidden=true;element.style.display='none';element.setAttribute('aria-hidden','true');
   }
  };
  hideDuplicateShortcuts();
  new MutationObserver(hideDuplicateShortcuts).observe(sidebar,{childList:true,subtree:true});
 }
 const legacyTiles=d.getElementById('viceFeatureGrid');
 if(legacyTiles)for(const tile of legacyTiles.querySelectorAll('button,a,[role="button"]')){
  if(!/import profiles|customer directory|jig settings/i.test(tile.textContent||''))continue;
  const card=tile.closest('article,.viceFeatureTile,.viceCard,.quickAction')||tile;
  card.hidden=true;card.style.display='none';
 }
 const main=d.createElement('main');main.id='profileLibraryPage';main.className='shell main profileLibrary';main.hidden=true;
 main.innerHTML='<header><div><div class="eyebrow" data-owner-title></div><h1>Profiles</h1><p>Choose a retailer, prepare unused accounts, review completed jigs, export, then move selected profiles to Live.</p></div><div class="buttons"><button type="button" class="btn primary" data-create-pools>Create profiles from pools</button><button type="button" class="btn secondary" data-import>Import</button><button type="button" class="btn secondary" data-import-live>Import live profiles</button><button type="button" class="btn secondary" data-jig-selected disabled>Jig selected</button><button type="button" class="btn secondary" data-bulk-move disabled>Move All Selected</button><button type="button" class="btn plain" data-bulk-delete disabled>Delete All Selected</button><button type="button" class="btn secondary" data-import-history>Import History</button><button type="button" class="btn primary" data-export>Export selected</button><button type="button" class="btn secondary" data-export-archive>Export full profile JSON</button></div></header><div class="profileLibraryControls"><label data-customer-label>Customer<select data-customer></select></label><label data-retailer-picker hidden>Retailer<select data-retailer aria-label="Current retailer"><option value="target">Target · Shikari CSV</option><option value="walmart">Walmart · Valor JSON</option><option value="pokemoncenter">Pokémon Center · Valor JSON</option><option value="costco">Costco · Valor JSON</option><option value="sams">Sam’s · Valor JSON</option></select></label><div class="profileRetailerButtons" data-retailer-tabs role="group" aria-label="Choose retailer"></div><label>Search<input type="search" data-search placeholder="Email, card or address"></label><label>View<select data-view><option value="all">All profiles</option><option value="issues">Issues only</option><option value="duplicates">Duplicates only</option></select></label><button type="button" class="btn secondary" data-pkc-reconcile>Reconcile PKC email pool</button><button type="button" class="btn secondary" data-rules>Retailer jig rules</button><button type="button" class="btn secondary" data-sync>Sync linked profiles</button></div><section data-retailer-workspace class="profileRetailerWorkspace" aria-label="Profiles for selected retailer"><div class="profileLibraryTabs"><button type="button" class="btn secondary" data-stage="unused" aria-pressed="true">Unused</button><button type="button" class="btn secondary" data-stage="new">New · Not Exported</button><button type="button" class="btn secondary" data-stage="completed">Ready for Export</button><button type="button" class="btn secondary" data-stage="live">Live Profiles</button><button type="button" class="btn plain" data-all>Select All on Page</button><button type="button" class="btn plain" data-clear>Clear selection</button></div><p data-current-retailer role="status">Target · Unused accounts</p></section><p data-selected-count role="status" aria-live="polite" style="position:sticky;top:0;z-index:2;background:#0d1b2a;padding:10px;border:1px solid #32d6d9;border-radius:8px">0 profiles selected on this page</p><p data-pool-counts role="status"></p><section class="profileResourceBanks" data-resource-banks><div class="profileResourceBank"><header><div><span class="eyebrow">AVAILABLE RESOURCES</span><h3>Card Bank <span data-card-count></span></h3></div><button type="button" class="btn slim secondary" data-manage-cards>Manage cards</button></header><input type="search" data-card-bank-search aria-label="Search Card Bank by full card number, linked email or retailer" placeholder="Search card number, email, retailer, label…" autocomplete="off"><div class="profileResourceList" data-card-bank><p>Loading saved cards…</p></div></div><div class="profileResourceBank"><header><div><span class="eyebrow">AVAILABLE RESOURCES</span><h3>Address Bank <span data-address-count></span></h3></div><button type="button" class="btn slim secondary" data-manage-addresses>Manage addresses</button></header><div class="profileResourceList" data-address-bank><p>Loading saved addresses…</p></div></div></section><p class="profileLibrarySummary" data-status role="status"></p><div class="profileLibraryLayout"><aside class="profileLibraryGroups" data-groups></aside><section class="profileLibraryCards" data-cards></section></div><input type="file" data-file hidden accept=".csv,.json,.txt,.tsv"><input type="file" data-live-file hidden multiple accept=".csv,.json,.txt,.tsv">';
 $('sitePage').before(main);const q=s=>main.querySelector('[data-'+s+']');
 // Position Unused, Ready for Export and Live directly beneath Card/Address Banks.
 // This is a DOM-only move; all existing stages and click handlers remain intact.
 const stageWorkspace=main.querySelector('.profileRetailerWorkspace');
 main.querySelector('.profileResourceBanks').after(stageWorkspace);
 // One-time reconciliation for Live profiles imported before duplicate
 // cleanup was available; never re-imports, modifies Live, or guesses by name.
 const reconcileExistingLive=text('button','Review existing Live duplicates');
 reconcileExistingLive.type='button';reconcileExistingLive.className='btn secondary';
 q('import-live').after(reconcileExistingLive);
 const exportAllUnique=text('button','Export All — Skip Duplicates');exportAllUnique.type='button';exportAllUnique.className='btn secondary';q('export').after(exportAllUnique);
  const exportTypeLabel=d.createElement('label');exportTypeLabel.textContent='Export as';
 const exportType=d.createElement('select');exportType.setAttribute('aria-label','Choose exported profile file type');
 exportType.dataset.exportFormat='true';
 for(const [value,label]of [['retailer','Retailer format (Shikari / Valor)'],['json','JSON'],['csv','CSV'],['tsv','TSV'],['txt','TXT']])
  exportType.append(new Option(label,value));
 exportTypeLabel.append(exportType);q('export').before(exportTypeLabel);
 // One owner-authorized, read-only recovery entry point across every
 // source this Mac can open. Original files require an explicit file selection;
 // Electron cannot silently access old files elsewhere on the device.
 const recoveryReviewPanel=d.createElement('section');
 recoveryReviewPanel.className='profileLibraryAdvanced';
 recoveryReviewPanel.setAttribute('aria-label','Recovery source review');
 const recoveryHeading=d.createElement('h3');recoveryHeading.textContent='Recovery Source Review';
 const recoveryIntro=d.createElement('p');
 recoveryIntro.textContent='Choose one folder in the Mac picker. ACO Studio will scan its available local vault sources and examine eligible original CSV/JSON profile files in the folder you authorize, including subfolders. No second file picker or import is needed. No records are changed.';
 const reviewControls=d.createElement('div');reviewControls.className='buttons';
 const reviewScan=d.createElement('button');reviewScan.type='button';reviewScan.className='btn secondary';
 reviewScan.textContent='Scan All Recovery Sources';
 reviewControls.append(reviewScan);
 const restoreFromBackup=d.createElement('button');
 restoreFromBackup.type='button';restoreFromBackup.className='btn secondary';
 restoreFromBackup.textContent='Preview Restore from Encrypted Backups';
 restoreFromBackup.hidden=true;reviewControls.append(restoreFromBackup);
 const restoreStatus=d.createElement('p');restoreStatus.setAttribute('role','status');
 restoreStatus.textContent='Restoration is available only after a read-only preview and explicit confirmation.';
 const reviewOutput=d.createElement('div');reviewOutput.setAttribute('role','status');
 reviewOutput.textContent='No scan has been run yet. Your saved information is unchanged.';
 const reviewWarning=d.createElement('small');
 reviewWarning.textContent='Selected original files are read locally in the authenticated desktop process for independent profile-reference matches only. Your files and vaults are not edited, and payment-card CVV/CVC values are not recovered or stored. You may cancel the folder picker to scan built-in sources only.';
 recoveryReviewPanel.append(recoveryHeading,recoveryIntro,reviewControls,reviewOutput,restoreStatus,reviewWarning);
 q('export').before(recoveryReviewPanel);
 const reviewLine=(label,value)=>{
  const p=d.createElement('p'),strong=d.createElement('strong');
  strong.textContent=label+' ';p.append(strong,d.createTextNode(String(value)));return p;
 };
 function showRecoveryReview(report){
  restoreFromBackup.hidden=!(Number(report.backups?.potentialMatches||0)>0);
  restoreStatus.textContent=restoreFromBackup.hidden
   ?'No independently named references from encrypted snapshots are available for restoration.'
   :'Encrypted snapshots contain independently named reference candidates. Preview them before any restore.';
  reviewOutput.replaceChildren();
  reviewOutput.append(
   reviewLine('Vault:',report.scope==='personal'?'Personal':'Selected customer'),
   reviewLine('Profiles checked:',report.totalProfiles),
   reviewLine('Profiles missing a reference:',report.missingProfiles),
   reviewLine('Encrypted profile snapshots:',report.backups.scanned+' readable; '+report.backups.unreadable+' unreadable; '+report.backups.potentialMatches+' possible matches; '+(report.backups.conflicts||0)+' conflicting references excluded'),
   reviewLine('Current saved Card Bank:',report.savedCardBank.potentialMatches+' possible matches; '+report.savedCardBank.conflictingCards+' conflicting card entries')
  );
  const h=report.historicSources;
  if(h){reviewOutput.append(
    reviewLine('Historical profile vault copies:',h.found+' located; '+h.readable+' readable; '+h.unreadable+' incompatible or unreadable; '+h.oversized+' oversized; '+h.matched+' possible independent-reference matches; '+h.conflicting+' conflicts'),
    reviewLine('Historical Card Bank file candidates:',h.cardHistoryFiles+' found (metadata only; verification values not inspected)'),
    reviewLine('Historical vault dates:',h.oldest&&h.newest?h.oldest.slice(0,10)+' through '+h.newest.slice(0,10):'No readable older copies found')
   );}
  if(report.importInventory)reviewOutput.append(reviewLine('Import history:',report.importInventory.batches+' recorded batches / '+report.importInventory.recordedFilenames+' distinct filenames; original file contents are not retained in history'));
  if(report.selectedFolder){
   const sf=report.selectedFolder;
   if(sf.cancelled)reviewOutput.append(reviewLine('Selected historical folder:','Picker cancelled; existing sources still scanned'));
   else reviewOutput.append(
    reviewLine('Selected historical folder:',sf.folders+' folders; '+sf.files+' files examined; '+sf.deniedDirectories+' inaccessible directories'+(sf.limited?'; scan limit reached':'')),
    reviewLine('Historical file candidates:',sf.categories.encryptedVaultCopies+' encrypted vaults, '+sf.categories.historicBackupCopies+' backup copies, '+sf.categories.possibleOriginalFiles+' possible exports/imports, '+sf.categories.archives+' archives'),
    reviewLine('Candidate modified dates:',sf.oldest&&sf.newest?sf.oldest+' through '+sf.newest:'No named candidates found'),
    reviewLine('Historical folder content inspection:','Not performed; metadata only')
   );
  }else if(report.selectedFolderError)reviewOutput.append(reviewLine('Selected folder scan failed:',report.selectedFolderError));
  else reviewOutput.append(reviewLine('Historical folder:','Not selected. Folder contents are not scanned without owner permission.'));
  if(report.folderOriginalScan){
   const scan=report.folderOriginalScan;
   reviewOutput.append(reviewLine('Original-file search:',scan.cancelled?'Folder selection canceled; built-in sources only':
    scan.scanned+' eligible original files analyzed from '+scan.candidates+' candidates; '+
    scan.incompatible+' incompatible, '+scan.unreadable+' unreadable, '+scan.skippedLarge+' oversized'+
    (scan.limited?'; scan limit reached':'')+'.'));
  }
  const files=report.originalFiles;
  if(files){
   reviewOutput.append(reviewLine('Original files:',files.scanned+' files / '+files.scannedRecords+' records; '+files.potentialMatches+' distinct possible matches; '+files.ambiguous+' conflicts or ambiguous matches; '+files.cardMismatches+' card mismatches'));
   // Show why a result can be zero without showing any verification values.
   // A populated legacy CVV-named field is ambiguous and is NOT recoverable
   // from this review, even if its record identity matches a missing profile.
   if(files.legacyFieldsMetadataOnly){
    reviewOutput.append(
     reviewLine('Independent reference coverage:',files.withSourceReference+' original records have separately named references; '+files.withoutIndependentReference+' do not'),
     reviewLine('Old CVV-labeled field inventory:',files.legacyFieldPopulatedRows+' original records have a populated legacy column; '+files.legacyOnlyPopulatedRows+' of those have no independent reference'),
     reviewLine('Legacy field identity overlap:',files.legacyIdentityMatches+' distinct profiles missing a reference have matching email/retailer/card identity in an original record; '+files.legacyIdentityCardMismatches+' card identity mismatches'),
     reviewLine('Legacy-field safety:', 'Presence and identity only. No code was displayed, copied, retained, or restored. A legacy column may contain a payment-card verification value.')
    );
   }
  }else reviewOutput.append(reviewLine('Original files:',report.originalSelectionCancelled?'Native file picker cancelled; no original files scanned':'Not selected. Files outside ACO Studio cannot be scanned without your permission.'));
  reviewOutput.append(reviewLine('Result:',report.notice));
  if(report.missingProfiles&&!report.backups.potentialMatches&&!report.savedCardBank.potentialMatches&&!h?.matched&&!files?.potentialMatches)
   reviewOutput.append(reviewLine('Next step:','No matching independent references were found in the examined sources. Check your original exports or a device backup made before the fields went missing.'));
 }
 async function scanRecoverySources(){
  if(scope==='aco'&&!customerId){reviewOutput.textContent='Select a customer vault first.';return;}
  restoreFromBackup.hidden=true;
  reviewScan.disabled=true;
  reviewOutput.textContent='Choose a folder in the Mac window. ACO Studio will check eligible original files in that folder together with its existing sources. No saved data will be changed.';
  try{
   if(scope==='personal'&&!await window.JigPersonalGuard?.ensureUnlocked?.())
    throw Error('Unlock your Personal vault with PIN or Touch ID before scanning.');
   const report=await api.historicalFolderReview({...request(),scanOriginals:true});
   if(!report?.readOnly)throw Error('The recovery service did not confirm read-only mode.');
   showRecoveryReview(report);
  }catch(error){
   reviewOutput.textContent='Recovery review failed: '+String(error?.message||error)+'. No saved record was modified.';
  }finally{reviewScan.disabled=false;}
 }
 reviewScan.onclick=()=>void scanRecoverySources();
 restoreFromBackup.onclick=async()=>{
  if(scope==='aco'&&!customerId){restoreStatus.textContent='Select a customer vault first.';return;}
  const owner=request(),openedEpoch=epoch;
  restoreFromBackup.disabled=true;reviewScan.disabled=true;
  try{
   if(scope==='personal'&&!await window.JigPersonalGuard?.ensureUnlocked?.())
    throw Error('Unlock your Personal vault before previewing restoration.');
   const preview=await api.recoverCodes({...owner,confirmed:false,independentOnly:true});
   if(openedEpoch!==epoch||main.hidden)return;
   if(!preview?.preview||!preview?.recoverable||!preview.token){
    restoreFromBackup.hidden=true;
    restoreStatus.textContent='No independent backup references remain available. Nothing was changed.';
    return;
   }
   const count=preview.recoverable;
   restoreStatus.textContent=count+' independent references may be restored from encrypted snapshots; '+preview.stillMissing+' will remain missing; '+(preview.conflicts||0)+' conflicts were excluded. No values were displayed or changed.';
   const agreed=window.confirm('Restore '+count+' missing independently named profile references from encrypted backups? Existing references and other profile fields will be preserved. Proceed only if these are known NON-PAYMENT references: older imports may have moved ambiguously named values into a separate field, and their origin cannot be independently verified.');
   if(!agreed){restoreStatus.textContent='Restore cancelled. No saved profiles were changed.';return;}
   if(openedEpoch!==epoch||main.hidden)throw Error('The profile view changed. Scan again before restoring.');
   const result=await api.recoverCodes({...owner,confirmed:true,token:preview.token,independentOnly:true});
   if(openedEpoch!==epoch||main.hidden)return;
   const updated=await api.recoveryReview(owner);
   showRecoveryReview(updated);
   restoreStatus.textContent='Restored '+result.restored+' independently named references; '+result.stillMissing+' remain missing. Existing profile references and other data were preserved.';
   await refresh();
  }catch(error){
   if(openedEpoch===epoch&&!main.hidden)restoreStatus.textContent='Restore not completed: '+String(error?.message||error)+'. Review the current vault before retrying.';
  }finally{restoreFromBackup.disabled=false;reviewScan.disabled=false;}
 };
 const advanced=d.createElement('details');advanced.className='profileLibraryAdvanced';
 advanced.innerHTML='<summary>Advanced tools &amp; maintenance</summary><div class="buttons"><button type="button" class="btn secondary slim" data-advanced-jig>Legacy jig editor</button><button type="button" class="btn secondary slim" data-advanced-directory>Customer directory</button><button type="button" class="btn secondary slim" data-advanced-settings>Existing Jig Settings</button><button type="button" class="btn secondary slim" data-health-scan>Check website, builds &amp; app health</button><button type="button" class="btn secondary slim" data-health-ai>Explain with optional local AI</button></div><p data-health-report role="status">Read-only. Checks report problems but never apply fixes, deploy, or edit customer information.</p><small>Optional local AI uses Ollama on this Mac and may require installing a model. No paid AI API key is required; computer and hosting resources still have costs. Advanced tools only appear here, not as duplicate top-level tabs.</small>';
 main.querySelector('.profileLibraryTabs').after(advanced);
 const postal=d.createElement('details');postal.className='profileLibraryAdvanced';
 postal.innerHTML='<summary>Postal verification &amp; retailer shipping references</summary><p>Find authentic ZIP+4 codes using the complete address and unit; do not invent suffixes. Online ZIP/city crossover listings are suggestions, not proof of deliverability.</p><div class="buttons"><a href="https://tools.usps.com/zip-code-lookup.htm" target="_blank" rel="noopener noreferrer">USPS ZIP+4 lookup</a><a href="https://pe.usps.com/text/pub28/welcome.htm" target="_blank" rel="noopener noreferrer">USPS Publication 28</a><a href="https://www.target.com/help" target="_blank" rel="noopener noreferrer">Target shipping help</a><a href="https://www.walmart.com/help" target="_blank" rel="noopener noreferrer">Walmart shipping help</a><a href="https://support.pokemoncenter.com/hc/en-us" target="_blank" rel="noopener noreferrer">Pokémon Center help</a><a href="https://customerservice.costco.com/" target="_blank" rel="noopener noreferrer">Costco help</a><a href="https://help.samsclub.com/" target="_blank" rel="noopener noreferrer">Sam’s Club help</a></div>';
 advanced.after(postal);
 const healthStatus=()=>advanced.querySelector('[data-health-report]');healthStatus().style.whiteSpace='pre-wrap';
 const healthText=r=>{const rows=['Last checked: '+r.checkedAt,'Website: '+(r.site.reachable?'Reachable':'Unavailable')+' (HTTP '+r.site.status+')','GitHub revision: '+(r.ci.head||'Unavailable'),'Checks: '+r.ci.successful+' passed, '+r.ci.failed.length+' failed, '+r.ci.pending.length+' pending','Local AI: '+(r.localAI.available?r.localAI.models.join(', '):r.localAI.reason),...r.findings.map(f=>f.level.toUpperCase()+': '+f.title+' — '+f.evidence+'; suggestion: '+f.recommendation)];return rows.join('\n');};
 advanced.querySelector('[data-health-scan]').onclick=async()=>{healthStatus().textContent='Checking read-only public health endpoints…';try{const report=await window.desktopAPI.ownerHealth.scan();healthStatus().textContent=healthText(report);}catch(e){healthStatus().textContent='Health scan failed: '+String(e.message||e);}};
 advanced.querySelector('[data-health-ai]').onclick=async()=>{healthStatus().textContent='Checking available local model…';try{const report=await window.desktopAPI.ownerHealth.explain();healthStatus().textContent=(report.available?'Local AI suggestions (not applied): ':'')+report.text;}catch(e){healthStatus().textContent='Local model unavailable: '+String(e.message||e);}};
 advanced.querySelector('[data-advanced-jig]').onclick=()=>{const target=scope==='personal'?personal:customer;close();target?.click();};
 advanced.querySelector('[data-advanced-directory]').onclick=()=>{close();const legacyDirectory=nav.querySelector('[data-tab="site"]');(legacyDirectory||admin)?.click();};
 advanced.querySelector('[data-advanced-settings]').onclick=()=>{close();settings?.click();};
 // Continuous advisory while the owner desktop application is open. No writes,
 // repair, deployments, or paid external AI calls occur in this timer.
 let lastHealthSignature='';
 async function passiveHealthCheck(){
  if(!window.desktopAPI?.ownerHealth?.scan)return;
  try{
   const report=await window.desktopAPI.ownerHealth.scan();
   const urgent=report.findings.filter(x=>x.level==='urgent');
   const signature=JSON.stringify(urgent.map(x=>x.id+':'+x.evidence));
   if(signature!==lastHealthSignature){
    lastHealthSignature=signature;
    advanced.querySelector('summary').textContent=urgent.length?'Advanced tools & maintenance · '+urgent.length+' urgent issue(s)':'Advanced tools & maintenance';
    healthStatus().textContent=healthText(report)+'\\nNo repair, deployment, or account change was performed. Review any proposed action before approving.';
   }
  }catch{ /* Health is advisory; a monitor failure must never block profiles. */ }
 }
 const passiveTimer=setInterval(()=>{void passiveHealthCheck();},30*60*1000);
 window.addEventListener('beforeunload',()=>clearInterval(passiveTimer),{once:true});let scope='personal',customerId=null,rows=[],stage='unused',group='all',issueView='all',epoch=0,busy=false,selected=new Set(),syncing=false,syncQueued=false,bankAssets={addresses:[],cards:[]},unusedAccounts=[],unusedConflicts=[],poolReport=null;
 const retailName={target:'Target',walmart:'Walmart',pokemoncenter:'Pokémon Center',costco:'Costco',sams:'Sam’s'};
 const retailerSidebar=d.createElement('aside');retailerSidebar.className='profileRetailerSidebar';retailerSidebar.append(q('retailer-tabs'),q('groups'));main.querySelector('.profileLibraryLayout').prepend(retailerSidebar);const retailerButtons=new Map();
 for(const [id,name] of Object.entries(retailName)){
  const b=text('button',name);b.type='button';b.className='btn secondary';b.dataset.retailerButton=id;
  b.setAttribute('aria-pressed',String(id===q('retailer').value));
  b.onclick=()=>{if(q('retailer').value===id)return;q('retailer').value=id;q('retailer').onchange?.();};
  retailerButtons.set(id,b);q('retailer-tabs').append(b);
 }
 // Selection belongs to one rendered page of the current retailer and stage.
 // Keep the preexisting 200-card display size, but make later pages accessible.
 const PAGE_SIZE=200;let pageIndex=0;let selectionAnchor=null,customGroups={};
 let sortMode='newest';let visibleCardLimit=80;let lastResourceSignature='';let lastResourceRetailer='';
 const sortToolbar=d.createElement('div');sortToolbar.className='profileLibrarySortToolbar';
 const sortLabel=d.createElement('label');sortLabel.textContent='Profile order';
 const sortSelect=d.createElement('select');sortSelect.setAttribute('aria-label','Sort profiles');
 for(const [value,label]of [['newest','Newest accounts at top'],['oldest','Newest accounts at bottom'],['email','Email A–Z']])sortSelect.append(new Option(label,value));
 sortLabel.append(sortSelect);
 const latestLabel=d.createElement('label');latestLabel.textContent='Newest profiles to select';
 const latestCount=d.createElement('input');latestCount.type='number';latestCount.min='1';latestCount.max='200';latestCount.step='1';latestCount.value='26';latestCount.setAttribute('aria-label','Number of newest profiles to select');
 latestLabel.append(latestCount);
 const selectNewest=text('button','Select newest 26');selectNewest.type='button';selectNewest.className='btn secondary';
 sortToolbar.append(sortLabel,latestLabel,selectNewest);q('current-retailer').after(sortToolbar);
  // Contextual selection controls remain available when scrolling a long bank.
  const floatingActions=d.createElement('div');floatingActions.className='profileSelectionDock';
  floatingActions.setAttribute('role','toolbar');floatingActions.setAttribute('aria-label','Selected profile actions');
  const actionDetails=d.createElement('div');actionDetails.className='profileSelectionDockPrimary';
  const actionManage=d.createElement('div');actionManage.className='profileSelectionDockSecondary';
  actionDetails.append(q('selected-count'),q('all'),q('clear'));
  actionManage.append(q('jig-selected'),q('bulk-move'),q('bulk-delete'),q('export'),exportAllUnique,exportTypeLabel,q('export-archive'));
  floatingActions.append(actionDetails,actionManage);main.querySelector('.profileLibraryLayout').before(floatingActions);
 const timeValue=value=>{const t=Date.parse(value||'');return Number.isFinite(t)?t:0;};
 const creationTime=row=>timeValue(row.profileGeneratedAt)||timeValue(row.createdAt)||timeValue(row.completedAt);
 const sortedProfiles=profiles=>{
  if(stage==='unused')return profiles;
  return [...profiles].sort((a,b)=>sortMode==='email'?String(a.email||'').localeCompare(String(b.email||'')):
   sortMode==='oldest'?creationTime(a)-creationTime(b)||String(a.id||'').localeCompare(String(b.id||'')):
    creationTime(b)-creationTime(a)||String(a.id||'').localeCompare(String(b.id||'')));
 };
 const pageRows=()=>visible().slice(pageIndex*PAGE_SIZE,(pageIndex+1)*PAGE_SIZE);
 let cachedPageRows=null;
 sortSelect.onchange=()=>{sortMode=sortSelect.value;pageIndex=0;selected.clear();draw();};
 latestCount.oninput=()=>{selectNewest.textContent='Select newest '+(Number(latestCount.value)||0);};
 selectNewest.onclick=()=>{
  if(stage==='unused'){note('Choose Ready for Export or Live Profiles before selecting the newest batch.');return;}
  const count=Number(latestCount.value);
  if(!Number.isSafeInteger(count)||count<1||count>PAGE_SIZE){note('Choose a quantity between 1 and '+PAGE_SIZE+'.');return;}
  sortMode='newest';sortSelect.value='newest';group='all';q('search').value='';issueView='all';q('view').value='all';pageIndex=0;selected.clear();
  for(const row of visible().slice(0,count))selected.add(row.id);
  draw();
  note('Selected '+selected.size+' newest '+retailName[q('retailer').value]+' '+(stage==='live'?'Live':'Ready for Export')+' profile(s). Review the selection, then export from the toolbar or right-click a selected profile.');
 };
 const pager=d.createElement('nav');pager.className='buttons profileLibraryPagination';pager.setAttribute('aria-label','Profile result pages');pager.style.cssText='display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;margin:12px 0 20px';
 const previousPage=text('button','Previous page'),nextPage=text('button','Next page'),pageLabel=d.createElement('span');
 for(const button of [previousPage,nextPage]){button.type='button';button.className='btn secondary slim';}
 pageLabel.setAttribute('role','status');pageLabel.setAttribute('aria-live','polite');
 pager.append(previousPage,pageLabel,nextPage);
 main.querySelector('.profileLibraryLayout').after(pager);
 previousPage.onclick=()=>{if(pageIndex>0){pageIndex--;selected.clear();draw();}};
 nextPage.onclick=()=>{if((pageIndex+1)*PAGE_SIZE<visible().length){pageIndex++;selected.clear();draw();}};
 const duplicatesButton=d.createElement('button');duplicatesButton.type='button';duplicatesButton.className='btn secondary';duplicatesButton.textContent='Duplicates (0)';duplicatesButton.onclick=()=>{
  const retailer=q('retailer').value,hits=duplicateReviewEntries(retailer);
  const win=dialog('Duplicate review · '+retailName[retailer]);
  win.body.append(text('p','Only matching emails or complete card numbers inside '+retailName[retailer]+' count. Target and Pokémon Center may share an email or card. Unused email-bank conflicts are listed separately; no data is deleted or changed by this review.'));
  if(!hits.length){win.body.append(text('p','No email, card or unused-pool conflicts found for this retailer in the selected vault.'));return;}
  for(const entry of hits){
   const box=d.createElement('section');box.className='profileLibraryCard';
   if(entry.kind==='group'){
    box.append(text('strong',(entry.reason==='card'?'Exact shared card number':'Exact shared email')+' · '+entry.value),
     text('p',entry.profiles.length+' matching profiles in '+retailName[retailer]+'. Choose the profile to rotate to an UNUSED '+(entry.reason==='card'?'saved Card Bank card':'email-bank account')+'.'));
    const peers=d.createElement('div');peers.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px';
    for(const row of entry.profiles){
     const panel=d.createElement('section');panel.className='profileLibraryCard';
     panel.append(text('strong',row.email),text('p',row.bank==='live'?'Live':row.stage==='completed'?'Ready for Export':'Unused / In Progress'));
     const jump=text('button','Show this profile');jump.type='button';jump.className='btn secondary slim';
     jump.onclick=()=>{
      stage=row.bank==='live'?'live':row.stage==='completed'?'completed':'unused';
      issueView=stage==='unused'?'all':'duplicates';q('view').value=issueView;
      group='all';q('search').value=row.email;selected.clear();pageIndex=0;
      win.wrap.remove();draw();note('Showing '+row.email+'. No changes made.');
     };
     const fix=text('button','Fix Duplicate');fix.type='button';fix.className='btn primary slim';
     fix.onclick=async()=>{
      fix.disabled=true;
      try{
       const preview=await api.duplicateRepairPreview({...request(),retailer,profileId:row.id,kind:entry.reason});
       const confirmation=dialog('Fix '+retailName[retailer]+' duplicate');
       confirmation.body.append(text('p','Selected profile: '+row.email),
        text('p','Replace the shared '+entry.reason+' with an unused '+(entry.reason==='card'?'saved card ending '+preview.newCardLast4:'email '+preview.newEmail)+'.'));
       confirmation.body.append(text('p','The original complete profile and independent security references are preserved in encrypted recovery history. No new card is generated. All other profiles remain unchanged.'));
       const buttons=d.createElement('div');buttons.className='buttons';
       const cancel=text('button','Cancel');cancel.type='button';cancel.className='btn secondary';
       cancel.onclick=()=>{confirmation.wrap.remove();fix.disabled=false;};
       const apply=text('button','Confirm Fix Duplicate');apply.type='button';apply.className='btn primary';
       apply.onclick=async()=>{
        apply.disabled=true;
        try{
         const result=await api.duplicateRepairCommit({token:preview.token,confirmed:true});
         confirmation.wrap.remove();win.wrap.remove();
         q('search').value='';await refresh();duplicatesButton.click();
         note('Fixed '+result.kind+' duplicate on '+row.email+' using an existing unused pool resource. Original encrypted record archived.');
        }catch(error){confirmation.status().textContent=error.message;apply.disabled=false;}
       };
       buttons.append(cancel,apply);confirmation.body.append(buttons);
      }catch(error){win.status().textContent=error.message;fix.disabled=false;}
     };
     panel.append(jump,fix);peers.append(panel);
    }
    box.append(peers);
   }else{
    box.append(text('strong',entry.email),text('p',entry.reason==='matches-profile'?'Unused email-bank entry overlaps a saved profile in this retailer.':'Repeated unassigned email in this retailer’s Unused pool.'));
    box.append(text('small','Review in the matching retailer Email Bank; the entry remains untouched.'));
   }
   win.body.append(box);
  }
 };q('view').closest('label').after(duplicatesButton);

 const request=()=>({scope,customerId:scope==='aco'?customerId:null});
 const note=s=>q('status').textContent=s;
 async function exportFromContext(row=null){
  if(stage==='unused'){note('Choose Ready for Export or Live Profiles to export profiles.');return;}
  const page=pageRows();
  const chosen=row&&selected.has(row.id)?page.filter(x=>selected.has(x.id)):row?[row]:page.filter(x=>selected.has(x.id));
  if(!chosen.length){note('Select at least one profile on this page to export.');return;}
  try{
   const retailer=q('retailer').value;
   if(chosen.some(x=>x.retailer!==retailer))throw Error('Only the active retailer can be exported.');
   const result=await api.exportFile({...request(),retailer,profileIds:chosen.map(x=>x.id),customerName:customerName(),exportFormat:exportType.value});
   if(result?.saved){await refresh();note('Exported '+result.count+' selected '+retailName[retailer]+' profiles: '+result.name+(result.markError?' · Tab status not updated: '+result.markError:''));}
  }catch(error){note('Selected profile export failed: '+String(error?.message||error));}
 }
 // Customer website/app information is displayed from the authoritative live
 // vault, not copied to Personal or silently treated as local-only profile data.
 const websiteVault=d.createElement('details');websiteVault.className='profileLibraryWebVault';
 websiteVault.hidden=true;websiteVault.style.cssText='margin:18px 0;border:1px solid #456779;border-radius:14px;padding:15px';
 websiteVault.innerHTML='<summary style="cursor:pointer;font-weight:700">Live Website & App · Saved customer data</summary><p data-web-status role="status">Open to load this customer’s current saved addresses and payment methods.</p><div data-web-records></div>';
 main.append(websiteVault);
 let websiteLoad=0;
 const webStatus=s=>websiteVault.querySelector('[data-web-status]').textContent=s;
 function webField(form,name,label,value,inputType='text'){
  const el=d.createElement('label');el.textContent=label;const input=d.createElement('input');input.name=name;input.type=inputType;input.value=value??'';el.append(input);form.append(el);return input;
 }
 async function editWebsiteAddress(address={}){
  const win=dialog('Edit live customer shipping address'),form=d.createElement('form');
  const keys=[['label','Address label'],['firstName','First name'],['lastName','Last name'],['address','Street address'],['address2','Apt / unit'],['city','City'],['state','State'],['zip','Postal code'],['country','Country']];
  win.body.append(form);
  for(const [key,label]of keys)webField(form,key,label,address[key]);
  const submit=d.createElement('button');submit.type='submit';submit.className='btn primary';submit.textContent='Save to website & app';form.append(submit);
  const id=customerId,revision=address.revision;
  form.onsubmit=async event=>{
   event.preventDefault();submit.disabled=true;
   try{
    const values=Object.fromEntries(new FormData(form));
    const saved=address.id?await api.saveWebsiteAddress({scope:'aco',customerId:id,addressId:address.id,expectedRevision:revision,address:values,confirmed:true}):await api.manageWebsiteRecord({scope:'aco',customerId:id,kind:'address',operation:'create',address:values,confirmed:true});
    if(!win.valid())return;
    if(!saved.saved)throw Error('The live website did not confirm this save.');
    win.wrap.remove();webStatus('Shipping address saved on the website and app.');await loadWebsiteVault();
    // The linked customer profile snapshot can use this saved address.
    void syncCustomer(id);
   }catch(error){win.status().textContent=String(error.message||error);submit.disabled=false;}
  };
 }
 async function editWebsiteCard(card={}){
  const win=dialog('Edit live customer payment method'),form=d.createElement('form');
  win.body.append(form);
  webField(form,'cardLabel','Card label',card.cardLabel);
  webField(form,'cardholder','Cardholder',card.cardholder);
  webField(form,'acoCardNumber','Replace card number (optional; existing number stays saved)','');
  webField(form,'expMonth','Expiration month',card.expMonth);
  webField(form,'expYear','Expiration year',card.expYear);
  const info=d.createElement('p');info.textContent='Existing '+card.maskedNumber+' remains stored securely unless a new number is entered. Security codes are never displayed or updated here.';form.append(info);
  const submit=d.createElement('button');submit.type='submit';submit.className='btn primary';submit.textContent='Save to website & app';form.append(submit);
  const id=customerId,revision=card.revision;
  form.onsubmit=async event=>{
   event.preventDefault();submit.disabled=true;
   try{
    const values=Object.fromEntries(new FormData(form));
    const saved=card.id?await api.saveWebsitePayment({scope:'aco',customerId:id,paymentId:card.id,expectedRevision:revision,payment:values,confirmed:true}):await api.manageWebsiteRecord({scope:'aco',customerId:id,kind:'payment',operation:'create',payment:values,confirmed:true});
    values.acoCardNumber='';
    if(!win.valid())return;
    if(!saved.saved)throw Error('The website did not confirm this payment edit.');
    win.wrap.remove();webStatus('Payment method saved on the website and app.');await loadWebsiteVault();void syncCustomer(id);
   }catch(error){win.status().textContent=String(error.message||error);submit.disabled=false;}
  };
 }
 async function loadWebsiteVault(){
  if(!websiteVault.open||scope!=='aco'||!customerId)return;
  const id=customerId,stamp=++websiteLoad,container=websiteVault.querySelector('[data-web-records]');
  webStatus('Loading the live customer information from the website…');
  try{
   const snapshot=await api.websiteSnapshot({scope:'aco',customerId:id});
   if(stamp!==websiteLoad||id!==customerId||scope!=='aco'||!websiteVault.open)return;
   container.replaceChildren();
   const heading=d.createElement('p');heading.textContent=(snapshot.customer?.firstName||'')+' '+(snapshot.customer?.lastName||'')+' · '+(snapshot.customer?.email||'');container.append(heading);
   for(const [title,list,kind] of [['Saved shipping addresses',snapshot.addresses||[],'address'],['Saved payment methods',snapshot.paymentMethods||[],'payment']]){
    const section=d.createElement('section');section.style.cssText='margin:12px 0';
    const h=d.createElement('h3');h.textContent=title+' ('+list.length+')';const add=text('button','Add live '+(kind==='address'?'address':'payment method'));add.type='button';add.className='btn secondary slim';add.onclick=()=>void(kind==='address'?editWebsiteAddress():editWebsiteCard());section.append(h,add);
    if(!list.length){const empty=d.createElement('p');empty.textContent='Nothing saved yet.';section.append(empty);}
    for(const item of list){
     const row=d.createElement('div');row.style.cssText='display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-top:1px solid #456779;padding:12px 0';
     const label=d.createElement('span');label.textContent=kind==='address'?[item.label,item.firstName+' '+item.lastName,item.address,item.address2,item.city,item.state,item.zip].filter(Boolean).join(' · '):[item.cardLabel,item.cardholder,item.maskedNumber,item.expMonth+'/'+item.expYear].filter(Boolean).join(' · ');
     const edit=d.createElement('button');edit.type='button';edit.className='btn secondary slim';edit.textContent='Edit live '+(kind==='address'?'address':'card');
     edit.onclick=()=>void (kind==='address'?editWebsiteAddress(item):editWebsiteCard(item));
     const remove=text('button','Delete exact saved record');remove.type='button';remove.className='btn plain slim';remove.onclick=async()=>{if(!confirm('Delete this exact saved '+kind+' from '+customerName()+' on the website and apps?'))return;remove.disabled=true;try{await api.manageWebsiteRecord({...request(),kind,recordId:item.id,expectedRevision:item.revision,operation:'delete',confirmed:true});await loadWebsiteVault();void syncCustomer(id);}catch(error){webStatus(error.message);remove.disabled=false;}};row.append(label,edit,remove);section.append(row);
    }
    container.append(section);
   }
   webStatus('Live website/app data loaded. Editing a record writes to its original customer account, not a duplicate local bank.');
  }catch(error){if(stamp===websiteLoad)webStatus('Website data unavailable: '+String(error.message||error));}
 }
 websiteVault.addEventListener('toggle',()=>{if(websiteVault.open)void loadWebsiteVault();});

 function hiddenPage(){return main.hidden;}
 function customerList(){const list=window.JigWebsiteCustomers?.list?.()||[],old=customerId;q('customer').replaceChildren(new Option('Select customer',''));for(const c of list)q('customer').append(new Option(c.name||c.email,c.id));if(list.some(c=>c.id===old))q('customer').value=old;}
 const customerName=()=>scope==='personal'?'Personal':(window.JigWebsiteCustomers?.list?.().find(x=>x.id===customerId)?.name||customerId||'Customer');
 function duplicateReviewEntries(retailer){
  // Group by full matching value instead of showing the same pair twice.
  const groups=new Map();
  for(const row of rows.filter(x=>x.retailer===retailer)){
   for(const detail of row.duplicateDetails||[]){
    if(!['card','email'].includes(detail.kind))continue;
    const key=detail.kind+'|'+detail.value;
    if(!groups.has(key))groups.set(key,{kind:'group',reason:detail.kind,value:detail.value,profiles:new Map()});
    groups.get(key).profiles.set(row.id,row);
    for(const peer of detail.peers||[]){
     const related=rows.find(x=>x.id===peer.id&&x.retailer===retailer);
     if(related)groups.get(key).profiles.set(related.id,related);
    }
   }
  }
  const organized=[...groups.values()].map(group=>({...group,profiles:[...group.profiles.values()]
   .sort((a,b)=>(a.bank==='live'?0:1)-(b.bank==='live'?0:1)||a.email.localeCompare(b.email))}));
  const unused=unusedConflicts.filter(item=>item.retailer===retailer)
   .map(item=>({kind:'unused-email',email:item.email,reason:item.reason}));
  return [...organized,...unused];
 }
 function profileIssues(row){
  const issues=[];
  if(row.needsReview)issues.push('Website conflict');
  if(Array.isArray(row.duplicates)&&row.duplicates.length)issues.push('Duplicate '+row.duplicates.join('/'));
  if(Array.isArray(row.missing)&&row.missing.length)issues.push('Missing '+row.missing.join(', '));
  if(String(row.status||'').toLowerCase()==='needs-repair'||String(row.status||'').toLowerCase()==='needs_repair')issues.push('Needs repair');
  return issues;
 }
 function searchable(row){const data=row.data||{},payment=cardFields(data),address=formValues(data);return [row.email,row.label,payment.number,payment.shipping,...Object.entries(address).filter(([k])=>k!=='password').map(([,v])=>v)].filter(Boolean).join(' ').toLowerCase();}
 function visible(){const term=q('search').value.trim().toLowerCase(),retailer=q('retailer').value;
  if(stage==='unused'){
   // The Unused workspace also shows saved unfinished drafts so accounts never
   // disappear when their email has been consumed but the jig isn't ready.
   const available=unusedAccounts.filter(x=>x.retailer===retailer&&x.status==='available').map(x=>({...x,kind:'unused-account'}));
   const drafts=rows.filter(x=>x.retailer===retailer&&x.bank!=='live'&&x.stage==='in-progress').map(x=>({...x,kind:'saved-draft'}));
   return [...available,...drafts].filter(x=>x.email.toLowerCase().includes(term));
  }
  return sortedProfiles(rows.filter(x=>x.retailer===retailer&&(stage==='live'?x.bank==='live':x.bank!=='live'&&x.stage==='completed'&&(stage==='new'?x.needsFirstExport===true:stage==='completed'&&x.needsFirstExport!==true))&&(group==='all'||(x.group||x.retailer)===group)&&(issueView==='issues'?profileIssues(x).length:issueView==='duplicates'?Array.isArray(x.duplicates)&&x.duplicates.length:true)&&searchable(x).includes(term)));
 }
 function text(tag,value){const el=d.createElement(tag);el.textContent=value;return el;}
 function cardFields(data){if(Object.hasOwn(data,'cc_number'))return {number:data.cc_number,holder:data.cc_name||[data.first_name,data.last_name].filter(Boolean).join(' '),expiration:data.cc_exp_month+'/'+data.cc_exp_year,code:data.custom_security_code||'',cvv:data.cc_cvv||data.cvv||data.cvc||data.security_code||data.securityCode||(/^\d{3,4}$/.test(String(data.custom_security_code||''))?data.custom_security_code:''),shipping:[data.shipping_street,data.shipping_street_2,data.shipping_city,data.shipping_zip_code].filter(Boolean).join(', ')};const c=data.card||{},s=data.shipping||{};return {number:c.number,holder:c.holder,expiration:c.expiration,code:c.custom_security_code||'',cvv:c.cvv||c.cvc||c.cid||c.securityCode||c.security_code||c.cvv2||(/^\d{3,4}$/.test(String(c.custom_security_code||''))?c.custom_security_code:''),shipping:[s.addressLine1,s.addressLine2,s.city,s.zipCode].filter(Boolean).join(', ')};}
 function showContext(event,items){event.preventDefault();d.querySelectorAll('.profileContextMenu').forEach(x=>x.remove());const menu=d.createElement('div');menu.className='profileContextMenu';menu.style.left=Math.max(0,Math.min(event.clientX,innerWidth-225))+'px';menu.style.top=Math.max(0,Math.min(event.clientY,innerHeight-250))+'px';for(const [name,fn] of items){const b=text('button',name);b.type='button';b.onclick=()=>{menu.remove();fn();};menu.append(b);}d.body.append(menu);const dismiss=e=>{if(!menu.contains(e.target)){menu.remove();d.removeEventListener('pointerdown',dismiss,true);}};setTimeout(()=>d.addEventListener('pointerdown',dismiss,true),0);}
 function drawResourceBanks(){
  const cardBox=q('card-bank'),addressBox=q('address-bank'),cardCount=q('card-count'),addressCount=q('address-count');
  if(!cardBox||!addressBox)return;
  cardBox.replaceChildren();addressBox.replaceChildren();
  if(scope==='aco'&&!customerId){
   cardCount.textContent='';addressCount.textContent='';
   cardBox.append(text('p','Select a customer to view that customer’s card bank.'));
   addressBox.append(text('p','Select a customer to view that customer’s address bank.'));
   return;
  }
  const cards=Array.isArray(bankAssets.cards)?bankAssets.cards:[],pool=Array.isArray(bankAssets.cardPool)?bankAssets.cardPool:[],addresses=Array.isArray(bankAssets.addresses)?bankAssets.addresses:[];
  const unusedCards=cards.filter(x=>x.unused===true);
  const cardQuery=(q('card-bank-search')?.value||'').trim().toLowerCase();
  const matchingCards=pool.filter(x=>[x.fullNumber,x.last4,x.label,x.status,...(x.linkedAccounts||[]).flatMap(y=>[y.email,retailName[y.retailer]])].filter(Boolean).join(' ').toLowerCase().includes(cardQuery));
  const eligible=pool.filter(x=>x.fromSavedBank&&x.availableRetailers?.includes(q('retailer').value));
  cardCount.textContent='· '+eligible.length+' available for '+retailName[q('retailer').value]+' / '+pool.length+' distinct cards';
  addressCount.textContent='· '+addresses.length+' saved';
  if(!pool.length)cardBox.append(text('p','No cards found in this '+(scope==='personal'?'Personal':'customer')+' vault or its saved profiles.'));
  for(const card of matchingCards.slice(0,visibleCardLimit)){
   const row=d.createElement('article');row.className='profileResourceRow profileSelectableCard'+(card.availableRetailers?.includes(q('retailer').value)?' isAvailable':' isUsed');
   row.tabIndex=0;row.onclick=e=>{if(!e.target.closest('button,input'))window.ACOProfileWorkshop?.openVault?.(request(),'cards',card.fullNumber||card.last4);};row.oncontextmenu=e=>showContext(e,[[ 'View / edit card',()=>window.ACOProfileWorkshop?.openVault?.(request(),'cards',card.fullNumber||card.last4)],['Set / unset Hard Card',()=>row.querySelector('button')?.click()]]);row.onkeydown=e=>{if(e.key==='Enter')row.click();};
    const body=d.createElement('div'),title=text('strong',card.fullNumber||'Card ending '+card.last4),meta=text('small',[card.expiry,card.hardCard?'Hard Card':'Regular card',card.brand,card.fromSavedBank?'Saved bank and profiles':'Found in imported profiles'].filter(Boolean).join(' · '));
   const current=card.availableRetailers?.includes(q('retailer').value);
   const linked=text('small',card.linkedAccounts?.length?card.linkedAccounts.map(a=>a.email+' · '+(retailName[a.retailer]||a.retailer)).join(' | '):'Unused — not linked to a retailer profile');
    linked.style.display='block';
    title.style.wordBreak='break-all';
    body.append(title,linked,meta,text('small',card.status+(card.hardCard?' · Available: '+card.availableRetailers.map(r=>retailName[r]).join(', '):'')+(card.hasConflict?' · Existing duplicate assignments need review':'')));
    // Show only an independent saved profile reference, never a payment verifier.
    // These rows belong to the selected, authenticated Personal/customer vault.
    // Require exact complete card identity and suppress conflicting references.
    const relatedReferences=new Set(rows.filter(profile=>
      String(cardFields(profile.data||{}).number||'').replace(/\D/g,'')===String(card.fullNumber||'').replace(/\D/g,'') &&
      /^\d{12,19}$/.test(String(card.fullNumber||'').replace(/\D/g,'')))
      .map(profile=>String(profile.data?.profileSecurityCode||profile.data?.security_code||profile.data?.custom_security_code||profile.data?.card?.custom_security_code||'').trim())
      .filter(Boolean));
    if(relatedReferences.size===1)body.append(text('small','Security Code: '+[...relatedReferences][0]));
    else if(relatedReferences.size>1)body.append(text('small','Security Code: conflicting saved references — review matching profiles'));

   const state=text('span',current?'Available for '+retailName[q('retailer').value]:'Unavailable for '+retailName[q('retailer').value]);state.className='profileResourceState';
   const toggle=text('button',card.hardCard?'Unset Hard Card':'Set Hard Card');toggle.type='button';toggle.className='btn slim secondary';
   toggle.onclick=async()=>{
    if(!confirm((card.hardCard?'Unset':'Set')+' Hard Card for card ending '+card.last4+' in '+(scope==='personal'?'your Personal vault':'this exact customer vault')+'? Hard Cards can be linked only once per retailer; Regular Cards are linked only once in total.'))return;
    toggle.disabled=true;
    try{const owner=request();const result=await window.desktopAPI.profileWorkshop.setHardCard({...owner,cardRef:card.id,hard:!card.hardCard,confirmed:true});await refresh();note('Hard Card status updated for '+result.matchedProfiles+' matching profiles and '+result.savedCardCopies+' saved card copies across all retailers in this vault only.');}
    catch(error){note(String(error.message||error));toggle.disabled=false;}
   };
   row.append(body,state,toggle);
   if(scope==='aco'&&/^\d{12,19}$/.test(String(card.fullNumber||'').replace(/\D/g,''))){
    const viewCard=text('button','View card details & code');viewCard.type='button';viewCard.className='btn slim secondary';
    viewCard.onclick=async()=>{
     const id=customerId,number=card.fullNumber,win=dialog('Customer Card Details');
     const status=text('p','Loading this card from the selected encrypted customer vault…');win.body.append(status);
     try{
      const detail=await api.customerCardDetails({scope:'aco',customerId:id,cardNumber:number});
      if(!win.valid()||scope!=='aco'||id!==customerId)return;
      status.remove();
      win.body.append(text('p','Card number: '+detail.cardNumber));
      if(card.expiry)win.body.append(text('p','Saved expiration: '+card.expiry));
      win.body.append(text('h3','Saved Card Bank reference'));
      const bankCodes=(detail.savedReferences||[]).map(x=>x.independentSecurityCode).filter(Boolean);
      win.body.append(text('p',bankCodes.length?bankCodes.join(' · '):'No independent reference in saved Card Bank.'));
      win.body.append(text('h3','Linked customer profiles'));
      if(!detail.linkedProfiles?.length)win.body.append(text('p','No linked profiles use this card.'));
      for(const item of detail.linkedProfiles||[]){
       const section=d.createElement('section');section.className='profileLibraryCard';
       section.append(text('strong',(retailName[item.retailer]||item.retailer)+' · '+item.email));
       section.append(text('p',[item.cardholder,item.expiration].filter(Boolean).join(' · ')));
       section.append(text('p','Security Code (independent reference): '+(item.independentSecurityCode||'Not saved')));
       win.body.append(section);
      }
      win.body.append(text('small','This view contains only separately saved profile-reference Security Codes, not payment-card CVV/CVC values. Website-only payment methods remain masked.'));
     }catch(error){if(win.valid())status.textContent='Unable to view this customer card: '+String(error.message||error);}
    };
    row.append(viewCard);
   }
   if(!card.fromSavedBank){
    const save=text('button','Add to saved card bank');save.type='button';save.className='btn slim secondary';
    save.onclick=async()=>{
     if(!confirm('Copy this card already contained in this vault into its saved Card Bank? No Security Code field will be copied.'))return;
     save.disabled=true;try{const owner=request();await window.desktopAPI.profileWorkshop.addProfileCardToBank({...owner,profileId:card.id.slice(8),confirmed:true});await refresh();note('Card added to this vault’s saved bank only.');}
     catch(error){note(String(error.message||error));save.disabled=false;}
    };
    row.append(save);
   }
   cardBox.append(row);
  }
  if(matchingCards.length>visibleCardLimit){
   const more=text('button','Show 80 more cards ('+(matchingCards.length-visibleCardLimit)+' remaining)');
   more.type='button';more.className='btn secondary profileBankShowMore';
   more.onclick=()=>{visibleCardLimit+=80;drawResourceBanks();};
   cardBox.append(more);
  }
  if(!addresses.length)addressBox.append(text('p','No addresses saved in this '+(scope==='personal'?'Personal':'customer')+' bank.'));
  for(const address of addresses){
   const row=d.createElement('article');row.className='profileResourceRow isAvailable profileSelectableCard';row.onclick=e=>{if(!e.target.closest('button'))window.ACOProfileWorkshop?.openVault?.(request(),'addresses');};
   const body=d.createElement('div'),title=text('strong',address.label||'Saved address'),meta=text('small',[address.address1,address.address2,address.city,address.state,address.zip].filter(Boolean).join(' · '));
   body.append(title,meta);
   const state=text('span',(Number(address.uses)||0)+' profile use'+((Number(address.uses)||0)===1?'':'s'));state.className='profileResourceState';
   row.append(body,state);addressBox.append(row);
  }
 }
 async function loadResourceBanks(owner,ticket,ownerEpoch){
  const workshop=window.desktopAPI?.profileWorkshop;
  if(!workshop||owner.scope==='aco'&&!owner.customerId){bankAssets={addresses:[],cards:[]};drawResourceBanks();return;}
  try{
   const [assets,accounts]=await Promise.all([workshop.assets({...owner,showFullCards:true}),workshop.emails({...owner,retailer:q('retailer').value})]);
   if(ticket!==refreshTicket||ownerEpoch!==epoch||main.hidden)return;
   if(editorBusy()){pendingRefresh=true;return;}
   bankAssets={addresses:Array.isArray(assets?.addresses)?assets.addresses:[],cards:Array.isArray(assets?.cards)?assets.cards:[],cardPool:Array.isArray(assets?.cardPool)?assets.cardPool:[]};
   const resourceSignature=JSON.stringify(bankAssets);
   const resourceChanged=resourceSignature!==lastResourceSignature||lastResourceRetailer!==q('retailer').value;
   lastResourceSignature=resourceSignature;lastResourceRetailer=q('retailer').value;
   unusedAccounts=(accounts.emails||[]).filter(x=>x.status==='available').map(x=>({id:x.id,email:x.email,source:x.source,status:x.status,retailer:q('retailer').value}));
   poolReport=accounts;
   if(resourceChanged)drawResourceBanks();
   const stats=accounts.retailerStats||{},cover=accounts.targetLiveReconciliation;
   const lines=[
    retailName[q('retailer').value]+': '+(stats.unusedAccountCount??unusedAccounts.length)+' Unused accounts ('+(stats.unusedEmailCount??0)+' unused emails, '+(stats.unusedExistingAccountCount??0)+' available accounts)',
    (stats.readyForExportCount??0)+' Ready for Export · '+(stats.liveProfileCount??0)+' Live · '+(stats.profileCount??0)+' stored profiles',
    assets.addresses.length+' saved addresses · '+assets.cardPool.filter(x=>x.fromSavedBank&&x.availableRetailers.includes(q('retailer').value)).length+' eligible saved cards'
   ];
   if(q('retailer').value==='pokemoncenter'&&cover){
    lines.push('PKC reconciliation: '+cover.targetUniqueEmails+' unique eligible source emails from Personal non-PKC retailers · '+cover.alreadyPkcProfiles+' source emails already have PKC profiles · '+cover.pkcCoverage+' accounted for · '+cover.added+' newly recovered entries');
    if(stats.staleReservationCount)lines.push(stats.staleReservationCount+' old PKC reservations need review and remain unavailable until verified');
   }
   q('pool-counts').textContent=lines.join(' | ');
  }catch(error){
   if(ticket!==refreshTicket||ownerEpoch!==epoch||main.hidden)return;
   bankAssets={addresses:[],cards:[]};unusedAccounts=[];poolReport=null;drawResourceBanks();
   note('Profiles loaded, but card/address bank could not be read: '+String(error.message||error));
  }
 }
 function draw(){cachedPageRows=null;duplicatesButton.textContent='Duplicates ('+duplicateReviewEntries(q('retailer').value).length+')';for(const option of q('retailer').options){const count=rows.filter(x=>x.retailer===option.value&&(stage==='live'?x.bank==='live':x.bank!=='live'&&x.stage==='completed'&&(stage==='new'?x.needsFirstExport===true:stage==='completed'&&x.needsFirstExport!==true))).length;option.textContent=retailName[option.value]+' · '+count+' '+(stage==='live'?'live profiles':'profiles');}for(const [id,b] of retailerButtons){const isActive=id===q('retailer').value;b.setAttribute('aria-pressed',String(isActive));b.classList.toggle('on',isActive);b.classList.toggle('profileRetailerActive',isActive);const count=rows.filter(x=>x.retailer===id).length;b.textContent=retailName[id]+' · '+count;}
  const stageNames={unused:'Unused',new:'New · Not Exported',completed:'Ready for Export',live:'Live Profiles'};
  const draftCount=rows.filter(x=>x.retailer===q('retailer').value&&x.bank!=='live'&&x.stage==='in-progress').length;
  q('current-retailer').textContent=retailName[q('retailer').value]+' · Total saved: '+rows.filter(x=>x.retailer===q('retailer').value).length+' (Live '+rows.filter(x=>x.retailer===q('retailer').value&&x.bank==='live').length+', New '+rows.filter(x=>x.retailer===q('retailer').value&&x.bank!=='live'&&x.needsFirstExport===true).length+', Ready '+rows.filter(x=>x.retailer===q('retailer').value&&x.bank!=='live'&&x.stage==='completed'&&x.needsFirstExport!==true).length+', Draft '+rows.filter(x=>x.retailer===q('retailer').value&&x.bank!=='live'&&x.stage==='in-progress').length+') / '+(stageNames[stage]||stage)+(stage==='unused'?' · '+unusedAccounts.length+' unused accounts · '+draftCount+' saved unfinished drafts':'');
  q('search').placeholder=stage==='unused'?'Search unused retailer account emails':'Search profile email, card or address';
  sortToolbar.hidden=stage==='unused';
  q('groups').hidden=false;q('view').closest('label').hidden=stage==='unused';duplicatesButton.hidden=false;
  for(const button of main.querySelectorAll('[data-stage]')){const count=button.dataset.stage==='unused'?unusedAccounts.length+draftCount:rows.filter(x=>x.retailer===q('retailer').value&&(button.dataset.stage==='live'?x.bank==='live':x.bank!=='live'&&x.stage==='completed'&&(button.dataset.stage==='new'?x.needsFirstExport===true:button.dataset.stage==='completed'&&x.needsFirstExport!==true))).length;button.textContent=(stageNames[button.dataset.stage]||button.dataset.stage)+' ('+count+')';}
  const matching=visible();const totalPages=Math.max(1,Math.ceil(matching.length/PAGE_SIZE));if(pageIndex>=totalPages){pageIndex=totalPages-1;selected.clear();}const pageItems=matching.slice(pageIndex*PAGE_SIZE,(pageIndex+1)*PAGE_SIZE);cachedPageRows=pageItems;const hardCardNumbers=new Set((bankAssets.cardPool||[]).filter(x=>x.hardCard).map(x=>x.fullNumber));const cardFragment=d.createDocumentFragment();const choose=(row,e)=>{const i=pageItems.findIndex(x=>x.id===row.id);if(i<0)return;if(e.shiftKey&&selectionAnchor!==null){const lo=Math.min(i,selectionAnchor),hi=Math.max(i,selectionAnchor);if(!e.metaKey&&!e.ctrlKey)selected.clear();for(const x of pageItems.slice(lo,hi+1))selected.add(x.id);}else{if(e.metaKey||e.ctrlKey){if(selected.has(row.id))selected.delete(row.id);else selected.add(row.id);}else{if(selected.size===1&&selected.has(row.id))selected.clear();else{selected.clear();selected.add(row.id);}}selectionAnchor=i;}updateSelection();};pager.hidden=matching.length<=PAGE_SIZE;pager.style.display=pager.hidden?'none':'flex';previousPage.disabled=pageIndex===0;nextPage.disabled=pageIndex>=totalPages-1;pageLabel.textContent=matching.length?'Showing '+(pageIndex*PAGE_SIZE+1)+'–'+(pageIndex*PAGE_SIZE+pageItems.length)+' of '+matching.length+' · Page '+(pageIndex+1)+' of '+totalPages:'No profiles';q('cards').replaceChildren();q('groups').replaceChildren();const eligible=rows.filter(x=>x.retailer===q('retailer').value&&(stage==='live'?x.bank==='live':x.bank!=='live'&&x.stage==='completed'&&(stage==='new'?x.needsFirstExport===true:stage==='completed'&&x.needsFirstExport!==true))),groups=['all',...new Set([...(customGroups[q('retailer').value]||[]),...eligible.map(x=>x.group||x.retailer)])];for(const value of groups){const b=d.createElement('button');b.type='button';b.textContent=(value==='all'?'All profiles':value)+' ('+(value==='all'?eligible.length:eligible.filter(x=>(x.group||x.retailer)===value).length)+')';b.setAttribute('aria-pressed',String(group===value));b.onclick=()=>{group=value;pageIndex=0;selected.clear();draw();};q('groups').append(b);}const add=text('button','+ Add group');add.onclick=async()=>{const name=prompt('New group name for '+retailName[q('retailer').value]);if(!name)return;try{await api.manageGroups({...request(),retailer:q('retailer').value,operation:'create',group:name,confirmed:true});await refresh();}catch(e){note(e.message);}};q('groups').append(add);if(stage!=='unused'){const move=text('button','Move selected to group');move.dataset.groupMove='true';move.onclick=async()=>{const name=prompt('Move selected profiles to which existing group?');if(!name)return;const chosen=pageRows().filter(x=>selected.has(x.id));try{await api.manageGroups({...request(),retailer:q('retailer').value,operation:'move',group:name,profileIds:chosen.map(x=>x.id),revisions:chosen.map(x=>x.revision||0),confirmed:true});selected.clear();await refresh();}catch(e){note(e.message);}};q('groups').append(move);}for(const b of main.querySelectorAll('[data-stage]'))b.setAttribute('aria-pressed',String(b.dataset.stage===stage));
 for(const row of pageItems){
   if(stage==='unused'){
    const box=d.createElement('article');box.className='profileLibraryCard profileUnusedAccount profileSelectableCard';
    const label=d.createElement('label'),check=d.createElement('input');check.type='checkbox';check.checked=selected.has(row.id);
    check.onchange=()=>{check.checked?selected.add(row.id):selected.delete(row.id);updateSelection();};
    label.append(text('strong',row.email));check.remove();
    box.dataset.profileId=row.id;box.classList.toggle('isSelected',selected.has(row.id));box.tabIndex=0;box.onclick=e=>{if(!e.target.closest('button,input'))choose(row,e);};box.oncontextmenu=e=>showContext(e,[[ 'Select',()=>choose(row,{})],['Jig selected',()=>{if(!selected.has(row.id)){selected.clear();selected.add(row.id);}updateSelection();void jigUnusedSelected();}],...(row.kind==='saved-draft'?[['Edit',()=>edit(row)],['Delete this saved draft…',()=>void deleteLocal(row)]]:[])]);box.append(label,text('small',row.kind==='saved-draft'?'Saved unfinished profile · resume or re-jig without changing its identity':row.source==='account'?'Available retailer account · ready to jig':'Unused email · not yet made into a profile'));
    const actions=d.createElement('div');actions.className='buttons';const jig=text('button',row.kind==='saved-draft'?'Jig this profile':'Jig this account');jig.type='button';jig.className='btn slim primary';jig.dataset.poolJig=row.kind==='saved-draft'?'draft':'email';
    jig.onclick=()=>{if(!selected.has(row.id)){selected.clear();selected.add(row.id);}updateSelection();void jigUnusedSelected();};
    if(row.kind==='saved-draft'){
     const editDraft=text('button','Complete missing fields');editDraft.type='button';editDraft.className='btn slim secondary';editDraft.onclick=()=>void edit(row);actions.append(editDraft);
    }
    actions.append(jig);box.append(actions);cardFragment.append(box);continue;
   }
   const box=d.createElement('article');box.className='profileLibraryCard profileSelectableCard';const label=d.createElement('label'),check=d.createElement('input');check.type='checkbox';check.checked=selected.has(row.id);check.onchange=()=>{check.checked?selected.add(row.id):selected.delete(row.id);updateSelection();};label.append(text('strong',row.label||row.email));check.remove();box.dataset.profileId=row.id;box.classList.toggle('isSelected',selected.has(row.id));box.tabIndex=0;box.onclick=e=>{if(!e.target.closest('button,input'))choose(row,e);};box.oncontextmenu=e=>showContext(e,[['Select',()=>choose(row,{})],['Export '+(selected.has(row.id)?'Selected ('+pageRows().filter(x=>selected.has(x.id)).length+')':'This Profile'),()=>void exportFromContext(row)],['View / Edit',()=>edit(row)],['Jig',()=>openJig(row)],['Repair',()=>repair(row)],[row.sourceLinked?'Manage linked profile':'Delete this profile…',()=>row.sourceLinked?assignmentActions(row):deleteLocal(row)],
     ...(!row.sourceLinked?[['Delete selected profiles…',()=>{if(!selected.has(row.id)){selected.clear();selected.add(row.id);updateSelection();}q('bulk-delete').click();}]]:[])]);box.append(label,...(row.profileGeneratedAt?[text('small','Generated '+new Date(row.profileGeneratedAt).toLocaleString())]:[]),text('small',row.bank==='live'?'Live Profiles · currently in use · '+retailName[row.retailer]:row.sourceLinked?'Website linked · customer '+customerName():row.source==='website-linked-profile'?'Unlinked website account · review before export':'Local only · '+customerName()+' · not linked to website'));const payment=cardFields(row.data),card=d.createElement('div');const paymentNumber=String(payment.number||'').replace(/\D/g,'');const matchedHard=hardCardNumbers.has(paymentNumber);if(matchedHard){const marker=text('small','Hard Card · all matching profiles in this vault');marker.className='profileHardCardIndicator';box.append(marker);}card.className='profilePaymentCard';card.append(text('strong',row.email),text('span',payment.holder||'Cardholder missing'),text('span',payment.number||'Card number missing'),text('span',payment.expiration||'Expiration missing'));box.append(card,text('small',payment.shipping||'Address missing'));const separateCode=row.data.profileSecurityCode||row.data.security_code||row.data.custom_security_code||'';if(separateCode)box.append(text('small','Security Code: '+separateCode));if(row.missing.length){const s=text('small','Needs: '+row.missing.join(', '));s.className='profileLibraryMissing';box.append(s);}const issues=profileIssues(row);if(issues.length){const s=text('small','Issues: '+issues.join(' · '));s.className='profileLibraryConflict';box.append(s);}const actions=d.createElement('div');actions.className='buttons';if(stage==='in-progress'&&row.missing?.length){const complete=text('button','Complete missing fields');complete.type='button';complete.className='btn slim primary';complete.onclick=()=>void edit(row);actions.append(complete);}for(const [title,action]of [['View / Edit','edit'],['Repair duplicates','repair'],['Jig profile','jig'],[row.needsReview?'Compare website conflict':row.sourceLinked?'Linked account actions':'Delete local profile',row.needsReview?'conflict':row.sourceLinked?'assignment':'delete']]){const b=d.createElement('button');b.type='button';b.className='btn slim secondary';b.textContent=title;b.onclick=()=>action==='edit'?edit(row):action==='repair'?repair(row):action==='jig'?openJig(row):action==='conflict'?reviewConflict(row):action==='assignment'?assignmentActions(row):deleteLocal(row);actions.append(b);}if(scope==='aco'&&row.source!=='website-linked-profile'){const mirror=rows.find(x=>x.sourceLinked&&x.retailer===row.retailer&&x.email===row.email);if(mirror){const link=text('button','Link these local values to matching website account');link.type='button';link.className='btn secondary slim';link.onclick=async()=>{if(!confirm('Publish this local profile to its matching website retailer account and replace only the redundant local mirror '+mirror.id+'? No retailer account is deleted.'))return;link.disabled=true;try{await api.linkLocal({...request(),profileId:row.id,revision:row.revision,mirrorId:mirror.id,mirrorRevision:mirror.revision,confirmed:true});await refresh();note('Website confirmed the profile link.');}catch(error){note(error.message);link.disabled=false;}};actions.append(link);}}if(!row.sourceLinked){const swap=text('button','Swap unused email');swap.type='button';swap.className='btn slim secondary';swap.onclick=()=>void swapPoolEmail(row);actions.append(swap);}box.append(actions);if(q('search').value.trim()){const jump=text('button','Open exact match');jump.type='button';jump.className='btn slim primary';jump.onclick=()=>void edit(row);actions.prepend(jump);}cardFragment.append(box);}q('cards').append(cardFragment);if(!matching.length)q('cards').append(text('p',scope==='aco'&&!customerId?'Select a customer to open their profiles.':stage==='unused'?'No unused '+retailName[q('retailer').value]+' emails or accounts remain in this vault.':stage==='live'?'No Live profiles for this retailer.':stage==='new'?'No new unexported profiles.':'No Ready for Export profiles for this retailer.'));updateSelection();
 }
 function updateSelection(){
 const selectedVisible=(typeof cachedPageRows!=='undefined'&&cachedPageRows?cachedPageRows:pageRows()).filter(x=>selected.has(x.id));
 for(const box of q('cards').querySelectorAll('[data-profile-id]')){const on=selected.has(box.dataset.profileId);box.classList.toggle('isSelected',on);box.setAttribute('aria-selected',String(on));const jig=box.querySelector('[data-pool-jig]');if(jig)jig.textContent=on&&selectedVisible.length>1?'Jig selected ('+selectedVisible.length+')':jig.dataset.poolJig==='draft'?'Jig this profile':'Jig this account';}
 const groupMove=q('groups').querySelector('[data-group-move]');if(groupMove)groupMove.hidden=!selectedVisible.length;
 q('export').disabled=busy||stage==='unused'||!selectedVisible.length;q('export-archive').disabled=busy||stage==='unused'||!selectedVisible.length;
 q('selected-count').textContent=selectedVisible.length+' profile(s) selected on this page';
 q('jig-selected').disabled=busy||!selectedVisible.length;
 q('jig-selected').textContent=selectedVisible.length?(stage==='unused'?'Jig selected ('+selectedVisible.length+')':'Re-jig selected ('+selectedVisible.length+')'):(stage==='unused'?'Jig selected':'Re-jig selected');
 for(const key of ['bulk-move','bulk-delete'])q(key).disabled=busy||stage==='unused'||!selectedVisible.length;
 q('bulk-move').textContent=(stage==='live'?'Return selected to Working':'Move selected Ready for Export to Live')+(selectedVisible.length?' ('+selectedVisible.length+')':'');
 q('bulk-delete').textContent=selectedVisible.length?'Delete All Selected ('+selectedVisible.length+')':'Delete All Selected';
 }
 d.addEventListener('keydown',e=>{if(main.hidden||d.querySelector('.profileLibraryModal,.workshopModal:not([hidden])'))return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='a'&&!e.target.closest('input,textarea,select')){e.preventDefault();selected.clear();for(const x of pageRows())selected.add(x.id);updateSelection();}});
 main.addEventListener('click',e=>{if(e.target.closest('.profileSelectableCard')&&!e.target.closest('button,input,a'))return;});
 q('cards').addEventListener('contextmenu',e=>{if(e.target.closest('.profileSelectableCard')||stage==='unused')return;if(pageRows().some(x=>selected.has(x.id)))showContext(e,[
    ['Export Selected ('+pageRows().filter(x=>selected.has(x.id)).length+')',()=>void exportFromContext()],
    ['Delete Selected Profiles…',()=>q('bulk-delete').click()]
   ]);});
 let pendingRefresh=false,refreshTicket=0;
 function editorBusy(){return !!d.querySelector('.profileLibraryModal,.workshopModal:not([hidden])')||!!d.activeElement?.closest?.('#profileLibraryPage input, #profileLibraryPage select, #profileLibraryPage textarea');}
 async function refresh(){if(editorBusy()){pendingRefresh=true;return;}const ticket=++refreshTicket,owner=request(),ownerEpoch=epoch,priorCards=JSON.stringify(bankAssets.cardPool||[]),priorUnused=JSON.stringify(unusedAccounts);if(scope==='aco'&&!customerId){rows=[];unusedAccounts=[];poolReport=null;bankAssets={addresses:[],cards:[]};draw();drawResourceBanks();return;}try{if(scope==='personal'&&!await window.JigPersonalGuard.ensureUnlocked())return;const [result]=await Promise.all([api.list(owner),loadResourceBanks(owner,ticket,ownerEpoch)]);if(ticket!==refreshTicket||ownerEpoch!==epoch||main.hidden)return;if(editorBusy()){pendingRefresh=true;return;}const same=JSON.stringify(rows)===JSON.stringify(result.profiles);const poolsSame=JSON.stringify(unusedConflicts)===JSON.stringify(result.unusedConflicts||[]);unusedConflicts=Array.isArray(result.unusedConflicts)?result.unusedConflicts:[];if(!same){const scroll={x:window.scrollX,y:window.scrollY};rows=result.profiles;customGroups=result.customGroups||{};selected=new Set([...selected].filter(id=>stage==='unused'?(unusedAccounts.some(x=>x.id===id)||rows.some(x=>x.id===id&&x.bank!=='live'&&x.stage==='in-progress')):rows.some(x=>x.id===id)));draw();window.scrollTo(scroll.x,scroll.y);}else if(!poolsSame||priorUnused!==JSON.stringify(unusedAccounts)||priorCards!==JSON.stringify(bankAssets.cardPool||[]))draw();else { /* The visible DOM and selected count have not changed. */ }note(customerName()+' · '+visible().length+' profiles · '+retailName[q('retailer').value]+' · '+(bankAssets.cardPool||[]).filter(x=>x.fromSavedBank&&x.availableRetailers?.includes(q('retailer').value)).length+' eligible cards · '+bankAssets.addresses.length+' saved addresses');}catch(e){if(ticket===refreshTicket&&ownerEpoch===epoch){rows=[];bankAssets={addresses:[],cards:[]};draw();drawResourceBanks();note(e.message);}}}
 function close(){epoch++;restoreFromBackup.hidden=true;restoreStatus.textContent='Scan this vault before previewing any restoration.';reviewOutput.textContent='No recovery scan has been run for this vault.';rows=[];unusedAccounts=[];unusedConflicts=[];poolReport=null;pageIndex=0;selected.clear();main.hidden=true;d.querySelectorAll('.profileLibraryModal').forEach(x=>x.remove());void api.cancel();}
 async function open(next){if(next==='personal'&&!await window.JigPersonalGuard.ensureUnlocked())return;close();stage='unused';pageIndex=0;scope=next;issueView='all';q('view').value='all';customerId=next==='aco'?(window.ACOProfileBank?.context?.().customerId||null):null;customerList();q('customer-label').hidden=scope==='personal';q('owner-title').textContent=scope==='personal'?'PERSONAL VAULT':'CUSTOMER VAULTS';q('sync').hidden=scope==='personal';q('pkc-reconcile').hidden=scope!=='personal';websiteVault.hidden=scope==='personal';websiteVault.open=false;websiteLoad++;for(const id of ['jigPage','sitePage','adminPage','emailPage'])if($(id))$(id).hidden=true;main.hidden=false;for(const b of nav.querySelectorAll('button'))b.classList.remove('on');(scope==='personal'?personalProfiles:customerProfiles).classList.add('on');d.body.dataset.mode='profiles';d.querySelector('.headerTitle strong').textContent=scope==='personal'?'Personal Profiles':'Customer Profiles';await window.desktopAPI.site?.hide?.();await refresh();void passiveHealthCheck();}
 q('manage-cards').onclick=()=>{if(scope==='aco'&&!customerId){note('Choose a customer first.');return;}void window.ACOProfileWorkshop?.openVault?.(request(),'cards');};
 q('manage-addresses').onclick=()=>{if(scope==='aco'&&!customerId){note('Choose a customer first.');return;}void window.ACOProfileWorkshop?.openVault?.(request(),'addresses');};
 customerProfiles.onclick=()=>void open('aco');personalProfiles.onclick=()=>void open('personal');for(const b of nav.querySelectorAll('button'))if(b!==customerProfiles&&b!==personalProfiles)b.addEventListener('click',()=>{if(!main.hidden)close();});
 function dialog(title){const wrap=d.createElement('div');wrap.className='profileLibraryModal';const body=d.createElement('div');body.className='profileLibraryDialog';const head=d.createElement('header'),close=d.createElement('button');close.type='button';close.className='btn plain';close.textContent='X';head.append(text('h2',title),close);body.append(head);wrap.append(body);d.body.append(wrap);const owner=request(),at=epoch;close.onclick=()=>{wrap.remove();void flushRefresh();};wrap.addEventListener('keydown',e=>{if(e.key==='Escape'){wrap.remove();void flushRefresh();}});return {wrap,body,owner,valid:()=>at===epoch&&!main.hidden&&wrap.isConnected,status:()=>{let el=body.querySelector('[role=status]');if(!el){el=text('p','');el.setAttribute('role','status');body.append(el);}return el;}};}
 function field(form,key,label,value,type='text'){const l=text('label',label),i=d.createElement('input');i.name=key;i.type=type;i.value=value??'';l.append(i);form.append(l);return i;}
 function formValues(data){const shipping=data.shipping||{},billing=data.billing||{},sh=Object.hasOwn(data,'cc_number');const result={label:data.profile_name||data.name||'',email:data.email||'',password:data.password||'',first:data.first_name||data.firstName||shipping.firstName||'',last:data.last_name||data.lastName||shipping.lastName||'',phone:data.phone_num||data.phoneNumber||''};for(const role of ['shipping','billing']){const source=data[role]||{};for(const [a,b]of Object.entries({first:'first_name',last:'last_name',address1:'street',address2:'street_2',city:'city',state:'state',zip:'zip_code',country:'country',phone:'phone'})){const valor={first:'firstName',last:'lastName',address1:'addressLine1',address2:'addressLine2',city:'city',state:'state',zip:'zipCode',country:'countryCode',phone:'phoneNumber'};result[role+'.'+a]=sh?data[role+'_'+b]||result[a]||'':source[valor[a]]||result[a]||'';}}return result;}
 async function edit(row){const win=dialog(customerName()+' · Edit Profile'),form=d.createElement('form'),tabs=d.createElement('div'),profile=d.createElement('section'),payment=d.createElement('section');tabs.className='profileLibraryTabs';payment.hidden=true;for(const [name,part]of [['Profile',profile],['Payment',payment]]){const b=text('button',name);b.type='button';b.className='btn secondary';b.onclick=()=>{profile.hidden=part!==profile;payment.hidden=part!==payment;};tabs.append(b);}win.body.append(tabs,form);profile.className=payment.className='workshopForm';form.append(profile,payment);const v=formValues(row.data);for(const key of ['label','email','password','first','last','phone',...['shipping','billing'].flatMap(r=>['phone','address1','address2','city','state','zip','country'].map(k=>r+'.'+k))])field(profile,key,key.replaceAll('.',' '),v[key],key==='email'?'email':key==='password'?'password':'text');profile.append(text('small','First/last name is entered once above and automatically matches shipping, billing, and the cardholder name.'));field(profile,'group','Profile group',row.group);const pay=cardFields(row.data),ex=pay.expiration.split('/');payment.append(text('small','Cardholder name follows the profile first/last name automatically.'));field(payment,'number','Card number',pay.number);field(payment,'month','Expiration month',ex[0]);field(payment,'year','Expiration year',ex[1]?.length===2?'20'+ex[1]:ex[1]);field(payment,'profileSecurityCode','Security Code (separate profile field)',row.data.profileSecurityCode||row.data.security_code||row.data.custom_security_code||row.data.card?.custom_security_code||row.data.cc_cvv||row.data.card?.cvv||'');const b=text('button','Save profile');b.type='submit';b.className='btn primary';form.append(b);form.onsubmit=async e=>{e.preventDefault();b.disabled=true;try{const values=Object.fromEntries(new FormData(form)),fields={...v};for(const k of Object.keys(v))if(Object.hasOwn(values,k))fields[k]=values[k];const previousCard={number:String(pay.number||'').replace(/\D/g,''),cardholder:String(pay.holder||''),month:String(ex[0]||'').padStart(2,'0'),year:String(ex[1]?.length===2?'20'+ex[1]:ex[1]||''),customSecurityCode:''};
 const proposedCard={number:String(values.number||'').replace(/\D/g,''),cardholder:[fields.first,fields.last].filter(Boolean).join(' ').trim(),month:String(values.month||'').padStart(2,'0'),year:String(values.year||''),customSecurityCode:''};
 const changedCard=Object.keys(previousCard).some(k=>proposedCard[k]!==previousCard[k]);
 const saveResult=await api.edit({...win.owner,profileId:row.id,revision:row.revision,fields,profileSecurityCode:values.profileSecurityCode,group:values.group,...(changedCard?{card:proposedCard}:{})});if(!win.valid())return;win.wrap.remove();await refresh();note(saveResult?.remoteSaved?'Saved on the live website and in ACO Studio.':'Saved to this encrypted local vault only (not yet linked to website).');}catch(e){win.status().textContent=e.message;b.disabled=false;}};}
 async function deleteLocal(row){if(!confirm('Delete only this exact local '+retailName[row.retailer]+' profile '+row.email+' from '+customerName()+'?'))return;try{await api.removeLocal({...request(),profileId:row.id,revision:row.revision,confirmed:true});await refresh();note('Deleted the selected local profile.');}catch(error){note(error.message);}}
 function comparisonSummary(data){const v=formValues(data),pay=cardFields(data);return ['Profile: '+(v.label||''),'Email: '+v.email,'Shipping: '+[v['shipping.first'],v['shipping.last'],v['shipping.address1'],v['shipping.address2'],v['shipping.city'],v['shipping.state'],v['shipping.zip']].filter(Boolean).join(', '),'Billing: '+[v['billing.address1'],v['billing.city'],v['billing.state'],v['billing.zip']].filter(Boolean).join(', '),'Payment: '+pay.holder+' · ending '+String(pay.number||'').replace(/\D/g,'').slice(-4)+' · '+pay.expiration].join('\n');}
 async function reviewConflict(row){const win=dialog('Compare local and website profile'),grid=d.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px';for(const [title,data]of [['ACO Studio',row.data],['Latest website / app',row.pendingWebsiteData||{}]]){const section=d.createElement('section');section.append(text('h3',title),text('pre',comparisonSummary(data)));grid.append(section);}win.body.append(grid);for(const [label,choice]of [['Use latest website values','website'],['Publish these Studio values to website','studio']]){const button=text('button',label);button.className='btn secondary';button.onclick=async()=>{if(!confirm(label+' for this exact linked profile?'))return;button.disabled=true;try{await api.resolveSourceConflict({...win.owner,profileId:row.id,revision:row.revision,choice,confirmed:true});win.wrap.remove();await refresh();note('Conflict resolved using '+choice+' values.');}catch(error){win.status().textContent=error.message;button.disabled=false;}};win.body.append(button);}}
 async function assignmentActions(row){const win=dialog('Manage exact linked retailer account');win.body.append(text('pre',comparisonSummary(row.data)));const unlink=text('button','Unlink and return this account to its retailer pool');unlink.className='btn secondary';unlink.onclick=async()=>{if(!confirm('Unlink '+row.email+' from '+customerName()+' on the website and apps? The retailer account remains in its original pool.'))return;unlink.disabled=true;try{await api.changeAssignment({...win.owner,profileId:row.id,revision:row.revision,operation:'unlink',confirmed:true});win.wrap.remove();await refresh();note('Website confirmed this account was returned to its retailer pool.');}catch(error){win.status().textContent=error.message;unlink.disabled=false;}};win.body.append(unlink);const reassignment=d.createElement('section'),target=d.createElement('select'),duration=d.createElement('select');target.append(new Option('Select receiving customer',''));for(const c of window.JigWebsiteCustomers?.list?.()||[])if(c.id!==customerId&&c.paid)target.append(new Option(c.name||c.email,c.id));for(const [value,label]of [['1_drop','One drop'],['1_week','One week'],['1_month','One month']])duration.append(new Option(label,value));const reassign=text('button','Reassign this account to selected customer');reassign.className='btn secondary';reassignment.append(text('h3','Authorized customer reassignment'),target,duration,reassign);win.body.append(reassignment);reassign.onclick=async()=>{if(!target.value||!confirm('Reassign this exact retailer account to the selected customer? The former customer’s attached addresses, billing and payment data will be removed. The receiving customer uses their own saved data and awaits activation.'))return;reassign.disabled=true;try{await api.changeAssignment({...win.owner,profileId:row.id,revision:row.revision,operation:'reassign',targetCustomerId:target.value,durationType:duration.value,confirmed:true});win.wrap.remove();await refresh();note('Website confirmed the account reassignment.');}catch(error){win.status().textContent=error.message;reassign.disabled=false;}};const load=text('button','Choose an unused replacement from this retailer bank');load.className='btn secondary';win.body.append(load);load.onclick=async()=>{load.disabled=true;try{const result=await window.desktopAPI.site.adminRead('pool',{status:'available',retailer:row.retailer,page:1});if(!win.valid())return;const part=result.items?.find(x=>x.ok);if(!part)throw Error('Unable to load the retailer bank.');const choices=part.data?.profiles||[],select=d.createElement('select');select.append(new Option('Select an unused account',''));for(const account of choices)if(account.id&&account.status==='available')select.append(new Option(account.loginEmail||account.profileName||account.id,account.id));win.body.append(select);const replace=text('button','Flag current account for repair and replace');replace.className='btn primary';replace.onclick=async()=>{if(!select.value||!confirm('Flag '+row.email+' as needs repair and replace it with the selected unused account from the same retailer bank?'))return;replace.disabled=true;try{await api.changeAssignment({...win.owner,profileId:row.id,revision:row.revision,operation:'replace',replacementId:select.value,confirmed:true});win.wrap.remove();await refresh();note('Website confirmed the selected replacement account.');}catch(error){win.status().textContent=error.message;replace.disabled=false;}};win.body.append(replace);}catch(error){win.status().textContent=error.message;load.disabled=false;}};}
 async function swapPoolEmail(row){
  if(row.sourceLinked){note('Replace this linked login through its retailer account pool.');return;}
  const inventory=await window.desktopAPI.profileWorkshop.emails({...request(),retailer:row.retailer});
  const available=(inventory.emails||[]).filter(x=>x.status==='available'&&x.source==='email'&&x.email!==row.email);
  const win=dialog('Replace profile email from unused pool'),select=d.createElement('select');select.append(new Option('Choose unused email',''));for(const entry of available)select.append(new Option(entry.email,entry.email));
  win.body.append(text('p','Current: '+row.email),select);
  const save=text('button','Use selected available email');save.type='button';save.className='btn primary';win.body.append(save);
  save.onclick=async()=>{if(!select.value)return;save.disabled=true;try{const fields={...formValues(row.data),email:select.value};await api.edit({...win.owner,profileId:row.id,revision:row.revision,fields,group:row.group,poolEmail:select.value});win.wrap.remove();await refresh();note('Email replaced using the selected available pool entry.');}catch(error){win.status().textContent=error.message;save.disabled=false;}};
 }
 async function repair(row){const win=dialog('Repair profile · '+row.email),form=d.createElement('form');win.body.append(form);form.innerHTML='<label class="check"><input type="checkbox" name="name"> Generate a new unused random name</label><label class="check"><input type="checkbox" name="email"> Replace email from this retailer’s unused bank</label><label class="check"><input type="checkbox" name="card"> Replace card from this vault’s unused cards</label><div data-card-choices></div><button type="submit" class="btn primary">Save replacements</button>';const assets=await window.desktopAPI.profileWorkshop.assets(win.owner);if(!win.valid())return;for(const card of assets.cards.filter(x=>x.unused)){const label=text('label',card.label+' · ending '+card.last4),c=d.createElement('input');c.type='checkbox';c.value=card.id;c.checked=true;label.prepend(c);form.querySelector('[data-card-choices]').append(label);}form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('[type=submit]');b.disabled=true;try{await api.repair({...win.owner,profileId:row.id,revision:row.revision,repairs:Object.fromEntries(['name','email','card'].map(k=>[k,form.elements[k].checked])),cardIds:[...form.querySelectorAll('[data-card-choices] input:checked')].map(x=>x.value)});if(!win.valid())return;win.wrap.remove();await refresh();}catch(e){win.status().textContent=e.message;b.disabled=false;}};}
 async function linkedJig(row){
 const win=dialog('Preview and publish linked profile jigs');
 try{
  const [settings,assets]=await Promise.all([api.rules({...win.owner,retailer:row.retailer}),api.jigAssets(win.owner)]);
  if(!win.valid())return;
  win.body.append(text('pre',comparisonSummary(row.data)));
  const sources=d.createElement('section');sources.append(text('h3','Saved customer addresses and cards'));
  const addressLabel=text('label','Address to jig'),addressSelect=d.createElement('select');
  addressSelect.append(new Option('Current profile address',''));
  for(const item of assets.addresses)addressSelect.append(new Option(item.label+' · '+item.summary,item.id));
  addressLabel.append(addressSelect);
  const cardLabel=text('label','Card for jigged profile'),cardSelect=d.createElement('select');
  cardSelect.append(new Option('Keep current profile card',''));
  for(const item of assets.cards)cardSelect.append(new Option(item.label+' · ending '+(item.last4||'unknown'),item.id));
  cardLabel.append(cardSelect);
  sources.append(addressLabel,cardLabel,text('small',assets.addresses.length+' saved addresses and '+assets.cards.length+' saved cards available. Both website and Studio resources are included; masked-only cards cannot be applied without complete saved details.'));
  const choices=d.createElement('section'),previews=d.createElement('section');
  groupedJigChoices(choices,settings);
  const combine=text('label','Combine selected jig styles'),combineCheck=d.createElement('input');combineCheck.type='checkbox';combine.className='check';combine.prepend(combineCheck);
  const billing=text('label','Billing same as jigged shipping address'),billingCheck=d.createElement('input');billingCheck.type='checkbox';billing.className='check';billing.prepend(billingCheck);
  const preview=text('button','Preview saved-resource jig options');preview.type='button';preview.className='btn secondary';
  win.body.append(sources,choices,combine,billing,preview,previews);
  let revision=0;
  for(const field of [addressSelect,cardSelect,combineCheck,billingCheck,...choices.querySelectorAll('input')])field.addEventListener('change',()=>{revision++;previews.replaceChildren();});
  preview.onclick=async()=>{
   preview.disabled=true;const at=revision;
   try{
    const result=await api.previewLinkedJig({...win.owner,profileId:row.id,revision:row.revision,addressSourceId:addressSelect.value,cardSourceId:cardSelect.value,ruleIds:selectedJigChoices(choices),combine:combineCheck.checked});
    if(!win.valid()||at!==revision)return;previews.replaceChildren();
    for(const candidate of result.candidates){
     const section=d.createElement('section'),publish=text('button','Publish this preview to website & apps');publish.type='button';publish.className='btn primary';
     section.append(text('pre',JSON.stringify(candidate.address,null,2)),publish);previews.append(section);
     publish.onclick=async()=>{
      if(!confirm('Publish this exact jig for '+row.email+' using the selected customer-owned resources?'))return;
      publish.disabled=true;
      try{
       await api.publishLinkedJig({...win.owner,profileId:row.id,expectedRevision:result.revision,address:candidate.address,billingSameAsShipping:billingCheck.checked,cardSourceId:cardSelect.value,confirmed:true});
       if(!win.valid())return;win.wrap.remove();await refresh();note('Website confirmed the address/card jig.');
      }catch(error){win.status().textContent=error.message;publish.disabled=false;}
     };
    }
    if(!result.candidates.length)previews.append(text('p','No different address was generated. Choose another saved address or jig rule.'));
   }catch(error){win.status().textContent=error.message;}finally{preview.disabled=false;}
  };
 }catch(error){win.status().textContent=error.message;}
}
 // Display one checkbox per transformation family. The selected family sends
 // every existing supported variant to the preview engine, which chooses
 // applicable variations per profile rather than requiring dozens of clicks.
 function jigFamily(option){
  const id=String(option.id||''),name=String(option.label||''),value=id+' '+name;
  if(/^target\.house\.fraction\./.test(id))return ['fraction-house','Fractional house numbers (1/2, 1/3, 1/4)'];
  if(/^target\.house\.hyphen\./.test(id))return ['hyphen-house','Hyphenated house numbers (-A through -H)'];
  if(/ordinal|\b(?:2nd|3rd|4th|second|third|fourth)\b|\b[234]\s*(?:→|->)\s*(?:2nd|second|3rd|third|4th|fourth)\b/i.test(value))return ['ordinals','Street ordinals (2, 2nd, second, etc.)'];
  if(/(?:compass|direction|north|south|east|west|\bnw\b|\bne\b|\bsw\b|\bse\b)/i.test(value))return ['directions','Compass directions (NW, Northwest, etc.)'];
  if(/(?:apt|apartment|suite|\bste\b|\bunit\b|\broom\b|\bfloor\b|\bcondo\b)/i.test(value))return ['units','Apartment / suite / unit labels (Apt, Ste, Unit, #, etc.)'];
  if(/(?:suffix|street type|road|avenue|lane|boulevard|drive|terrace)/i.test(value))return ['suffix','Street type spelling (St/Street, Rd/Road, etc.)'];
  return [id,name];
 }
 function groupedJigChoices(host,settings){
  const groups=new Map();
  for(const option of settings.options||[]){
   const [id,label]=jigFamily(option);
   if(!groups.has(id))groups.set(id,{label,ids:[]});
   groups.get(id).ids.push(option.id);
  }
  for(const [id,group]of groups){
   const label=text('label',group.label),box=d.createElement('input');
   label.className='check';box.type='checkbox';box.value=id;
   box.dataset.jigRuleIds=JSON.stringify(group.ids);
   box.checked=group.ids.some(value=>settings.selected.includes(value));
   label.prepend(box);host.append(label);
  }
 }
 function selectedJigChoices(host){
  return [...new Set([...host.querySelectorAll('input[data-jig-rule-ids]:checked')]
   .flatMap(input=>JSON.parse(input.dataset.jigRuleIds)))];
 }
 async function bulkJigSelected(){
  const chosen=pageRows().filter(x=>selected.has(x.id)),retailer=q('retailer').value;
  if(!chosen.length){note('Select the profiles you want to jig first.');return;}
  if(chosen.length>500){note('Select no more than 500 profiles at a time.');return;}
  try{
   const win=dialog('Jig '+chosen.length+' selected '+retailName[retailer]+' profiles'),settings=await api.rules({...win.owner,retailer});
   if(!win.valid())return;
   const info=text('p','All '+chosen.length+' selected profiles will be processed from this one review. You do not need to open them one at a time.');
   const rules=d.createElement('div');rules.className='profileJigRules';
   groupedJigChoices(rules,settings);
   const combine=text('label','Combine selected jig styles (up to 3 per profile)'),combineBox=d.createElement('input');combine.className='check';combineBox.type='checkbox';combine.prepend(combineBox);
   const billing=text('label','Use the jigged shipping address for billing address too'),billingBox=d.createElement('input');billing.className='check';billingBox.type='checkbox';billing.prepend(billingBox);
   const postalScan=text('label','Scan internet ZIP/city crossovers during preview');
   const postalScanBox=d.createElement('input');postalScan.className='check';postalScanBox.type='checkbox';postalScanBox.checked=true;postalScan.prepend(postalScanBox);
   const postalApply=text('label','Apply ZIP/state-matched alternate cities when available (not USPS delivery-point verification)');
   const postalApplyBox=d.createElement('input');postalApply.className='check';postalApplyBox.type='checkbox';postalApplyBox.checked=true;postalApply.prepend(postalApplyBox);
   const postalHelp=text('p','The lookup shares only a five-digit ZIP with the postal-city directory. It never shares names, street addresses, cards or account logins. Only matched city names can change; your ZIP and state stay the same.');
   postalScanBox.onchange=()=>{postalApplyBox.disabled=!postalScanBox.checked;};

   const reuseLabel=text('label','Allow multiple profiles to use the same saved address');
   reuseLabel.className='check';const reuseToggle=d.createElement('input');reuseToggle.type='checkbox';reuseLabel.prepend(reuseToggle);
   const reusePanel=d.createElement('section');reusePanel.className='profileJigReusePicker';reusePanel.hidden=true;
   const reuseHelp=text('p','Choose an existing Main or Jigged shipping address and how many of the selected profiles should share it. The full shipping address, including the unit, is reused exactly.');
   const reuseSelectLabel=text('label','Saved Main or Jigged address'),reuseSelect=d.createElement('select');reuseSelectLabel.append(reuseSelect);
   const reuseCountLabel=text('label','Number of profiles to reuse this address'),reuseCount=d.createElement('input');
   reuseCount.type='number';reuseCount.min='2';reuseCount.max=String(chosen.length);reuseCount.step='1';reuseCount.value=String(Math.min(2,chosen.length));reuseCountLabel.append(reuseCount);
   reusePanel.append(reuseHelp,reuseSelectLabel,reuseCountLabel);
   let reuseLoaded=false;
   const preview=text('button','Preview all '+chosen.length+' selected profiles');preview.type='button';preview.className='btn secondary';
   const save=text('button','Apply jig to all '+chosen.length+' selected profiles');save.type='button';save.className='btn primary';save.disabled=true;
   const review=d.createElement('div');let token=null;
   win.body.append(info,rules,combine,billing,postalScan,postalApply,postalHelp,reuseLabel,reusePanel,preview,save,review);
   const invalidatePreview=()=>{token=null;save.disabled=true;review.replaceChildren();};
   for(const control of [rules,combineBox,billingBox,postalScanBox,postalApplyBox,reuseSelect,reuseCount])control.addEventListener('change',invalidatePreview);
   reuseToggle.onchange=async()=>{
    invalidatePreview();reusePanel.hidden=!reuseToggle.checked;
    if(!reuseToggle.checked)return;
    if(chosen.length<2){reuseToggle.checked=false;reusePanel.hidden=true;win.status().textContent='Select at least two profiles to share an address.';return;}
    if(reuseLoaded)return;
    reuseSelect.disabled=true;win.status().textContent='Loading this vault’s Main and Jigged addresses...';
    try{
     const result=await api.reuseChoices({...win.owner});if(!win.valid())return;
     reuseSelect.replaceChildren();
     for(const type of ['main','jigged']){
      const addresses=(result.choices||[]).filter(x=>x.type===type);
      if(!addresses.length)continue;
      const group=d.createElement('optgroup');group.label=type==='main'?'Main addresses':'Previously jigged addresses';
      for(const a of addresses){const option=d.createElement('option');option.value=a.id;option.textContent=(a.label||'Saved address')+' · '+a.summary;group.append(option);}
      reuseSelect.append(group);
     }
     if(!reuseSelect.options.length)throw Error('No saved Main or Jigged shipping addresses are available in this vault.');
     reuseLoaded=true;win.status().textContent='Select the exact address and quantity, then preview each profile.';
    }catch(error){win.status().textContent=error.message||'Could not load saved addresses.';reuseToggle.checked=false;reusePanel.hidden=true;
    }finally{reuseSelect.disabled=false;}
   };
   preview.onclick=async()=>{
    preview.disabled=true;save.disabled=true;review.replaceChildren();token=null;
    try{
     const quantity=Number(reuseCount.value);
     if(reuseToggle.checked&&(!reuseLoaded||!reuseSelect.value||!Number.isSafeInteger(quantity)||quantity<2||quantity>chosen.length))
      throw Error('Choose a saved Main or Jigged address and a valid number of profiles to reuse it.');
     const reuse=reuseToggle.checked?{sourceId:reuseSelect.value,count:quantity}:null;
     win.status().textContent=postalScanBox.checked?'Checking online ZIP/city matches for selected main addresses…':'Preparing offline jig preview…';
     const result=await api.batchJigPreview({...win.owner,retailer,profileIds:chosen.map(x=>x.id),
      ruleIds:selectedJigChoices(rules),combine:combineBox.checked,
      billingSameAsShipping:billingBox.checked,postalScan:postalScanBox.checked,postalApplyCities:postalScanBox.checked&&postalApplyBox.checked,reuse});
     if(!win.valid())return;token=result.token;
     review.append(text('p',result.changed+' of '+result.count+' selected profiles will change'+(result.reused?' · '+result.reused+' profiles share the selected exact address':'')+(result.linked?' · '+result.linked+' website-linked profile(s) will sync to the website/app':'')+'.'));
     if(result.postalScanned)review.append(text('p','ZIP/city directory scanned '+result.postalScanned+' unique address(es), found '+result.postalCityCandidates+' alternate city option(s), applied '+result.postalCityApplied+'. ZIP+4 and USPS street delivery are not verified here.'));
     for(const row of result.profiles.slice(0,100)){const line=d.createElement('pre');line.textContent=(row.label||row.email)+'\n'+[row.before.address1,row.before.address2,row.before.city,row.before.state,row.before.zip,row.before.phone&&('Phone '+row.before.phone)].filter(Boolean).join(', ')+'\n→ '+[row.after.address1,row.after.address2,row.after.city,row.after.state,row.after.zip,row.after.phone&&('Phone '+row.after.phone)].filter(Boolean).join(', ');review.append(line);}
     if(result.profiles.length>100)review.append(text('p','+'+(result.profiles.length-100)+' more selected profiles included in this batch.'));
     save.disabled=false;win.status().textContent='Preview ready. One Apply action will process the whole selected set.';
    }catch(error){win.status().textContent=error.message;}finally{preview.disabled=false;}
   };
   save.onclick=async()=>{
    if(!token||!confirm('Apply the reviewed jig to all '+chosen.length+' selected profiles now?'))return;
    save.disabled=true;preview.disabled=true;
    try{
     const result=await api.batchJigCommit({token,confirmed:true});
     if(!win.valid())return;win.wrap.remove();selected.clear();await refresh();
     note('Jigged '+result.updated+' selected profile(s) in one batch'+(result.remoteSaved?' · '+result.remoteSaved+' synced to website/app':'')+'.');
    }catch(error){win.status().textContent=error.message;save.disabled=false;preview.disabled=false;}
   };
  }catch(error){note(error.message);}
 }
 function openJig(row){if(row.sourceLinked){void linkedJig(row);return;}const owner=request();close();(owner.scope==='personal'?personal:customer)?.click();setTimeout(()=>void window.ACOProfileWorkshop.openSaved({...owner,profileId:row.id}),0);}
 q('card-bank-search').oninput=()=>{visibleCardLimit=80;drawResourceBanks();};
  q('customer').onchange=()=>{epoch++;websiteLoad++;websiteVault.open=false;websiteVault.querySelector('[data-web-records]').replaceChildren();customerId=q('customer').value||null;rows=[];unusedAccounts=[];unusedConflicts=[];poolReport=null;bankAssets={addresses:[],cards:[]};selected.clear();pageIndex=0;group='all';issueView='all';q('view').value='all';drawResourceBanks();void refresh();};q('retailer').onchange=()=>{selected.clear();pageIndex=0;group='all';q('search').value='';issueView='all';q('view').value='all';unusedAccounts=[];unusedConflicts=[];poolReport=null;draw();void refresh();};q('search').oninput=()=>{selected.clear();pageIndex=0;if(q('search').value.trim())group='all';draw();};q('view').onchange=()=>{issueView=q('view').value;selected.clear();pageIndex=0;group='all';draw();note(issueView==='duplicates'?'Showing only duplicate profiles.':issueView==='issues'?'Showing only profiles that need attention.':customerName()+' · '+visible().length+' profiles');};for(const b of main.querySelectorAll('[data-stage]'))b.onclick=()=>{stage=b.dataset.stage;pageIndex=0;group='all';selected.clear();q('search').value='';issueView='all';q('view').value='all';for(const tab of main.querySelectorAll('[data-stage]'))tab.setAttribute('aria-pressed',String(tab===b));draw();};q('all').onclick=()=>{selected.clear();for(const r of pageRows())selected.add(r.id);updateSelection();};q('clear').onclick=()=>{selected.clear();updateSelection();};
 async function jigUnusedSelected(){
   const chosen=pageRows().filter(x=>selected.has(x.id));
   if(stage!=='unused'||!chosen.length){note('Select one or more unused accounts or unfinished profiles from this retailer page.');return;}
   if(chosen.length>500){note('Choose at most 500 entries.');return;}
   const drafts=chosen.filter(x=>x.kind==='saved-draft'),emails=chosen.filter(x=>x.kind==='unused-account');
   if(drafts.length&&emails.length){note('Select either unused emails OR saved unfinished profiles for this jig batch. They must be processed separately to preserve existing account data.');return;}
   if(drafts.length){return bulkJigSelected();}
   if(!window.ACOPoolCreator?.open){note('Retailer account jigging is unavailable in this app version.');return;}
   await window.ACOPoolCreator.open({...request(),retailer:q('retailer').value,emailIds:emails.map(x=>x.id)});
  }
  q('jig-selected').onclick=()=>void(stage==='unused'?jigUnusedSelected():bulkJigSelected());
 function chosenForBulk(){
  if(stage==='unused')throw Error('Unused accounts must be jigged before they can move or be deleted as profiles.');
   const retailer=q('retailer').value,selectedRows=pageRows().filter(x=>selected.has(x.id)&&x.retailer===retailer);
  if(!selectedRows.length)throw Error('Select profiles from this retailer and current tab.');
  if(selectedRows.length>500)throw Error('Select no more than 500 profiles.');
  const fromBank=stage==='live'?'live':'working';
  if(selectedRows.some(x=>(x.bank==='live'?'live':'working')!==fromBank))
   throw Error('Selection belongs to another bank. Reload and choose again.');
  return {selectedRows,retailer,fromBank};
 }
 q('bulk-move').onclick=async()=>{
  try{
   const {selectedRows,retailer,fromBank}=chosenForBulk(),toBank=fromBank==='live'?'working':'live';
   if(selectedRows.some(x=>x.sourceLinked))throw Error('Website-linked accounts cannot be moved locally; manage those through linked-account controls.');
   if(!confirm('Move '+selectedRows.length+' selected '+retailName[retailer]+' profile(s) from '+fromBank+' to '+toBank+'? No profile data or linked website account will be changed.'))return;
   const result=await api.bulkManage({...request(),operation:'move',retailer,fromBank,toBank,
    profileIds:selectedRows.map(x=>x.id),revisions:selectedRows.map(x=>x.revision||0),confirmed:true});
   selected.clear();await refresh();note('Moved '+result.count+' selected profiles into '+toBank+' for '+retailName[retailer]+'.');
  }catch(error){note('Move failed: '+error.message);}
 };
 q('bulk-delete').onclick=async()=>{
  try{
   const {selectedRows,retailer,fromBank}=chosenForBulk();
   if(selectedRows.some(x=>x.sourceLinked))throw Error('Website-linked profiles cannot be deleted locally.');
   if(!confirm('DELETE all '+selectedRows.length+' selected local '+retailName[retailer]+' profiles from '+fromBank+'? Saved customer accounts, card banks, address banks and other retailers remain intact. The encrypted recovery snapshot is created before the change.'))return;
   const result=await api.bulkManage({...request(),operation:'delete',retailer,fromBank,
    profileIds:selectedRows.map(x=>x.id),revisions:selectedRows.map(x=>x.revision||0),confirmed:true});
   selected.clear();await refresh();note('Deleted '+result.count+' selected LOCAL profiles. Use encrypted vault recovery if necessary.');
  }catch(error){note('Delete failed: '+error.message);}
 };
 q('import-history').onclick=async()=>{
  const at=epoch,owner=request();
  try{
   const {batches}=await api.importHistory(owner);if(at!==epoch||main.hidden)return;
   const win=dialog('Import History · '+customerName());
   win.body.append(text('p','Each import is recorded separately. Removing one batch deletes only profiles created by that upload. Website-linked accounts, other batches and pre-existing profiles that were updated are preserved.'));
   if(!batches.length)win.body.append(text('p','No recorded import batches yet. Older profiles remain in their original banks; they are not assigned an unverified import history.'));
   for(const batch of batches){
    const box=d.createElement('article');box.className='profileLibraryCard';
    const names=(batch.fileNames||[]).join(', ').slice(0,600);
    box.append(text('strong',new Date(batch.at).toLocaleString()+' · '+(batch.bank==='live'?'Live':'Working')+' · '+(batch.retailers||[]).map(r=>retailName[r]||r).join(', ')),
      text('p',batch.imported+' imported · '+batch.created+' newly created · '+batch.remaining+' still present'+
        (batch.updatedExisting?' · '+batch.updatedExisting+' pre-existing updated (protected)':'')),
      text('small',names||'Imported profile file'));
    if(batch.removedAt)box.append(text('small','Batch removed: '+new Date(batch.removedAt).toLocaleString()));
    else if(batch.protectedCount)box.append(text('small','Contains '+batch.protectedCount+' website-linked profiles. Unlink before removing batch.'));
    else{
     const remove=text('button','Remove this import batch');remove.type='button';remove.className='btn plain slim';
     remove.onclick=async()=>{
      if(!confirm('Remove '+batch.remaining+' remaining local profiles created by THIS exact import? '+batch.updatedExisting+
       ' previously-existing profiles updated by the import will stay. Encrypted backup snapshots preserve a recovery path.'))return;
      remove.disabled=true;
      try{
       const result=await api.removeImportBatch({...owner,batchId:batch.id,fingerprint:batch.fingerprint,confirmed:true});
       if(!win.valid())return;win.wrap.remove();selected.clear();await refresh();
       note('Removed '+result.deleted+' profiles from that import; '+result.updatedExistingPreserved+' earlier profiles preserved.');
      }catch(error){win.status().textContent=error.message;remove.disabled=false;}
     };
     box.append(remove);
    }
    win.body.append(box);
   }
  }catch(error){note('Import history unavailable: '+error.message);}
 };

 exportAllUnique.onclick=async()=>{
  if(stage==='unused'){note('Choose New, Ready for Export or Live Profiles first.');return;}
  const retailer=q('retailer').value,owner=request(),at=epoch,bank=stage;
  try{
   const mode=confirm('Skip shared complete cards too? OK = email AND card duplicates; Cancel = email duplicates only.')?'email-card':'email';
   const parameters={...owner,retailer,exportStage:bank,duplicateMode:mode,exportAllUnique:true,customerName:customerName(),exportFormat:exportType.value};
   const preview=await api.exportFile({...parameters,previewOnly:true});
   if(at!==epoch||bank!==stage||retailer!==q('retailer').value)return;
   if(!confirm('Export '+preview.count+' unique profiles from '+retailName[retailer]+' / '+bank+'?\\nScanned: '+preview.scanned+'\\nSkipped duplicate emails: '+preview.skippedEmail+'\\nSkipped duplicate cards: '+preview.skippedCard+'\\nSaved duplicates stay untouched.'))return;
   const result=await api.exportFile({...parameters,confirmedUniqueExport:true,expectedFingerprint:preview.fingerprint});
   if(result?.saved){await refresh();note('Exported '+result.count+' unique profiles · skipped '+result.skippedDuplicates+' duplicates.'+(result.markError?' Export saved, but tab status could not update: '+result.markError:''));}
  }catch(error){note('Unique export failed: '+String(error.message||error));}
 };
 q('export-archive').onclick=async()=>{try{const result=await api.exportArchive({...request(),retailer:q('retailer').value,profileIds:pageRows().filter(x=>selected.has(x.id)).map(x=>x.id),customerName:customerName()});if(result.saved)note('Saved full profile JSON ('+result.count+' profiles): '+result.name);}catch(e){note(e.message);}};
 q('export').onclick=async()=>{try{const result=await api.exportFile({...request(),retailer:q('retailer').value,profileIds:pageRows().filter(x=>selected.has(x.id)).map(x=>x.id),customerName:customerName(),exportFormat:exportType.value});if(result.saved){await refresh();note('Exported '+result.count+' profiles: '+result.name+(result.markError?' · Tab status not updated: '+result.markError:''));}}catch(e){note(e.message);}};
 q('import').onclick=()=>{if(scope==='aco'&&!customerId){note('Choose a customer first.');return;}if(stage==='live'){q('live-file').value='';q('live-file').click();return;}q('file').value='';q('file').click();};
 q('import-live').onclick=()=>{if(scope==='aco'&&!customerId){note('Choose a customer first.');return;}q('live-file').value='';q('live-file').click();};
 reconcileExistingLive.onclick=async()=>{
  if(scope==='aco'&&!customerId){note('Select the customer vault first.');return;}
  const owner=request(),at=epoch,retailer=q('retailer').value;
  reconcileExistingLive.disabled=true;
  try{
   const preview=await api.reconcileLivePreview({...owner,retailer});
   if(at!==epoch||main.hidden)return;
   const win=dialog('Reconcile existing '+retailName[retailer]+' Live profiles');
   const info=text('p',preview.liveCount+' Live · '+preview.workingCount+' non-Live · '+preview.emailMatches+
    ' exact-email matches · '+preview.cardOnlyMatches+' unique full-card matches · '+
    preview.blockedCount+' ambiguous/linked matches excluded · '+preview.unmatchedCount+' unmatched.');
   win.body.append(info,text('p','This reviews profiles ALREADY stored; do not import the same file again. Only selected non-Live records can be retired. Every retired record is archived in the same encrypted vault BEFORE removal, different original cards are preserved in its existing Card Bank, and all Live profiles stay unchanged. Matching a name or address is never enough.'));
   if(preview.blockedCount)win.body.append(text('p',preview.blockedCount+' linked or ambiguous matches must be reviewed separately and will not be changed.'));
   const candidates=preview.candidates||[];
   if(!candidates.length){win.body.append(text('p','There are no unambiguous same-retailer Live matches to retire. No records changed.'));return;}
   const controls=d.createElement('div');controls.className='buttons';
   const all=text('button','Select all confirmed matches');all.type='button';all.className='btn secondary';
   const none=text('button','Clear selection');none.type='button';none.className='btn secondary';
   controls.append(all,none);win.body.append(controls);
   const form=d.createElement('form'),entries=d.createElement('div');
   entries.style.cssText='max-height:50vh;overflow:auto;display:grid;gap:8px';
   const checkboxes=[];
   for(const match of candidates){
    const label=d.createElement('label');label.className='check';
    const input=d.createElement('input');input.type='checkbox';input.value=match.id;input.checked=true;
    const description=match.reason==='email'
     ?'Exact retailer email match'+(match.cardsDiffer?' · different card will be preserved':' · same card')
     :'FULL CARD ONLY — different login email; explicitly confirm this is an older superseded profile';
    label.append(input,text('span',match.email+' → Live '+match.liveEmail+' · '+description));
    entries.append(label);checkboxes.push(input);
   }
   all.onclick=()=>{for(const input of checkboxes)input.checked=true;};
   none.onclick=()=>{for(const input of checkboxes)input.checked=false;};
   form.append(entries);
   const confirmLabel=d.createElement('label');confirmLabel.className='check';
   const confirmed=d.createElement('input');confirmed.type='checkbox';confirmed.required=true;
   confirmLabel.append(confirmed,text('span','I reviewed the matching identities and authorize retiring ONLY my selected non-Live profiles after encrypted archival and Card Bank preservation.'));
   const submit=text('button','Archive and retire selected non-Live matches');
   submit.type='submit';submit.className='btn primary';
   form.append(confirmLabel,submit);win.body.append(form);
   form.onsubmit=async event=>{
    event.preventDefault();const selectedIds=checkboxes.filter(input=>input.checked).map(input=>input.value);
    if(!selectedIds.length){win.status().textContent='Select matching profiles before reconciling.';return;}
    submit.disabled=true;
    try{
     const result=await api.reconcileLiveCommit({token:preview.token,confirmed:confirmed.checked,selectedIds});
     if(!win.valid())return;
     win.wrap.remove();selected.clear();await refresh();
     note('Reconciled '+result.retired+' old '+retailName[retailer]+' profiles ('+
      result.matchedByEmail+' exact email, '+result.matchedByCard+' reviewed full card). '+
      result.cardsPreserved+' original cards saved; '+result.cardsAlreadySaved+
      ' already saved. Encrypted profile recovery preserved; existing Live unaffected.');
    }catch(error){win.status().textContent=error.message;submit.disabled=false;}
   };
  }catch(error){note('Live reconciliation unavailable: '+String(error.message||error));}
  finally{reconcileExistingLive.disabled=false;}
 };
 q('live-file').onchange=async()=>{
  const files=[...q('live-file').files];if(!files.length)return;const owner=request(),at=epoch;
  try{
   if(files.reduce((n,f)=>n+f.size,0)>26*1024*1024)throw Error('Choose files totaling less than 26 MB.');
   const preview=await api.importPreview({...owner,bank:'live',retailer:q('retailer').value,files:await Promise.all(files.map(async f=>({fileName:f.name,text:await f.text()})))});
   if(at!==epoch||main.hidden)return;const win=dialog('Import into Live Profiles'),form=d.createElement('form');win.body.append(form);
   form.append(text('p',preview.count+' input rows → '+(preview.effectiveCount||preview.count)+' latest unique Live profiles: '+Object.entries(preview.counts).map(([r,n])=>retailName[r]+' '+n).join(' · ')));
   form.append(text('p','These profiles stay in Live Profiles when edited or jigged. Retailer labels and filenames determine the bank; unlabeled files use the retailer selected before import. Check the assignments below. Emails not already in a PKC profile or email bank are also added to this vault’s PKC email pool.'));
   form.append(text('p','The newest imported row automatically REPLACES all older Live and Ready/Unused profiles with the SAME EMAIL in the SAME retailer and vault. '+(preview.supersedeLive||0)+' existing Live and '+(preview.supersedeNonLive||0)+' Ready/Unused profiles will be archived then removed from active lists. '+(preview.collapsedInImport||0)+' repeated email(s) inside these files will use the last imported row. Original different cards and independent references are preserved. Other retailers, customers, and unrelated emails are unchanged.'));
   if(preview.blockedLinkedCount)form.append(text('p','Warning: '+preview.blockedLinkedCount+' website-linked profile(s) require manual unlink before import; no data will be changed if you continue while they are linked.'));
   const review=d.createElement('details');review.open=true;review.append(text('summary','Review retailer assignments'));
   for(const row of preview.profiles.slice(0,100))review.append(text('p',retailName[row.retailer]+' · '+row.email+(row.duplicates.length?' · matches a stored profile':'')));
   if(preview.count>100)review.append(text('p','And '+(preview.count-100)+' more profiles included.'));form.append(review);
   const warn=text('button','Duplicates: '+(preview.duplicateCount||0)+' · Review');warn.type='button';warn.className='btn secondary';warn.onclick=()=>{review.open=true;review.replaceChildren(text('summary','Duplicate emails in this import'));for(const row of preview.profiles.filter(x=>x.duplicates.length))review.append(text('p',retailName[row.retailer]+' · '+row.email));};form.append(warn);form.append(text('p','All matched older Live and non-Live profiles are fully archived in encrypted recovery history before replacement. Different original cards are saved in your existing Card Bank first, without creating duplicate full-number entries. If preservation or writing fails, the old profiles remain active.'));
   // The newest import is authoritative for an exact same-retailer email.
   // There is no opt-out that could silently create another Live duplicate.
   const save=text('button','Import '+(preview.effectiveCount||preview.count)+' latest Live profiles');save.type='submit';save.className='btn primary';form.append(save);
   form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{const result=await api.importCommit({token:preview.token,confirmed:true});if(!win.valid())return;win.wrap.remove();stage='live';group='all';selected.clear();for(const tab of main.querySelectorAll('[data-stage]'))tab.setAttribute('aria-pressed',String(tab.dataset.stage==='live'));await refresh();issueView='all';q('view').value='all';draw();note('Imported '+result.imported+' latest Live profiles · Replaced '+(result.supersededLive||0)+' older Live and '+(result.supersededNonLive||0)+' Ready/Unused records · '+(result.collapsedInImport||0)+' repeated import rows collapsed · '+(result.cardsPreserved||0)+' original cards preserved · '+(result.cardsAlreadySaved||0)+' already saved · encrypted recovery history retained · '+result.pkcEmailsAdded+' PKC emails added.');}catch(error){win.status().textContent=error.message;save.disabled=false;}};
  }catch(error){note(error.message);}
 };
 const pasteAccountsButton=text('button','Paste accounts');
 pasteAccountsButton.type='button';pasteAccountsButton.className='btn secondary';
 q('import').after(pasteAccountsButton);
 pasteAccountsButton.onclick=()=>{
  if(scope==='aco'&&!customerId){note('Select a customer vault before importing accounts.');return;}
  const win=dialog('Paste retailer accounts');
  const form=d.createElement('form');
  const retailerLabel=text('label','Account retailer');
  const retailerSelect=d.createElement('select');
  for(const [id,name] of Object.entries(retailName))retailerSelect.append(new Option(name,id));
  retailerSelect.value=q('retailer').value;retailerLabel.append(retailerSelect);
  const pasteLabel=text('label','Paste one account per line');
  const area=d.createElement('textarea');area.rows=12;area.autocomplete='off';area.spellcheck=false;
  area.placeholder='email@example.com:password\nemail2@example.com:::password\nemail3@example.com; password';
  pasteLabel.append(area);
  const review=text('p','Choose the retailer before saving. Separate email and password with :, :::, or ;. Only accounts not already present in the selected retailer and vault will be added to Unused. Existing passwords are never overwritten.');
  const counts=text('p','No accounts parsed.');
  const submit=text('button','Review and import accounts');submit.type='submit';submit.className='btn primary';
  form.append(retailerLabel,pasteLabel,review,counts,submit);win.body.append(form);
  const parse=()=>{
   const lines=area.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
   if(lines.length>5000)throw Error('Paste at most 5000 accounts per batch.');
   const accounts=[],seen=new Set();
   for(let i=0;i<lines.length;i++){
    const match=/^([^\s@:;]+@[^\s@:;]+\.[^\s@:;]+)\s*(:::|;|:)\s*(.+)$/.exec(lines[i]);
    if(!match||!match[3].trim()||/[\x00-\x1f\x7f]/.test(match[3]))
     throw Error('Invalid account at line '+(i+1)+'. Use email:password, email:::password, or email; password.');
    const email=match[1].toLowerCase();
    if(seen.has(email))throw Error('Duplicate email on line '+(i+1)+': '+email);
    seen.add(email);accounts.push({email,password:match[3]});
   }
   return accounts;
  };
  area.oninput=()=>{try{counts.textContent=parse().length+' valid accounts to import.';}catch(error){counts.textContent=error.message;}};
  form.onsubmit=async event=>{
   event.preventDefault();let accounts;try{accounts=parse();if(!accounts.length)throw Error('Paste at least one account.');}catch(error){win.status().textContent=error.message;return;}
   if(!confirm('Import '+accounts.length+' accounts into '+customerName()+' / '+retailName[retailerSelect.value]+'? Existing accounts remain unchanged.'))return;
   submit.disabled=true;
   try{
    const result=await api.importPastedAccounts({...win.owner,retailer:retailerSelect.value,accounts,confirmed:true});
    accounts.length=0;area.value='';
    if(!win.valid())return;
    win.wrap.remove();q('retailer').value=retailerSelect.value;stage='unused';selected.clear();await refresh();draw();
    note('Imported '+result.added+' unused '+retailName[retailerSelect.value]+' accounts; '+result.skipped+' existing accounts skipped. Passwords saved in this encrypted vault.');
   }catch(error){win.status().textContent=error.message;submit.disabled=false;}
  };
 };
 q('create-pools').onclick=()=>void window.ACOPoolCreator?.open({...request(),retailer:q('retailer').value,...(stage==='unused'&&pageRows().some(x=>selected.has(x.id)&&x.kind==='unused-account')?{emailIds:pageRows().filter(x=>selected.has(x.id)&&x.kind==='unused-account').map(x=>x.id)}:{})});
 d.addEventListener('jigstudio:pools-generated',()=>{if(!main.hidden)void refresh();});
 q('file').onchange=async()=>{const file=q('file').files[0];if(!file)return;const owner=request(),at=epoch,retailer=q('retailer').value;try{if(file.size>26*1024*1024)throw Error('Choose a file smaller than 26 MB.');const preview=await api.importPreview({...owner,retailer,fileName:file.name,text:await file.text()});if(at!==epoch||main.hidden)return;const win=dialog('Review profile import'),form=d.createElement('form');win.body.append(text('p',preview.count+' profiles · '+preview.profiles.filter(x=>x.duplicates.length).length+' rows with duplicate email, name or card.'),form);for(const row of preview.profiles.filter(x=>x.duplicates.length).slice(0,80))form.append(text('p',row.email+' · Duplicate '+row.duplicates.join(', ')));form.insertAdjacentHTML('beforeend','<label class="check"><input name="name" type="checkbox" checked> Generate new names for duplicates</label><label class="check"><input name="email" type="checkbox" checked> Replace duplicate emails from this retailer’s bank</label><label class="check"><input name="card" type="checkbox" checked> Replace duplicate cards from this vault</label><label class="check"><input name="allowShared" type="checkbox"> Keep shared names/cards when their repair option is off</label><label class="check"><input name="alreadyJigged" type="checkbox" checked> Imported profiles have already been jigged / formatted</label>');field(form,'group','Group',retailName[retailer]);const choices=d.createElement('div');form.append(choices);const assets=await window.desktopAPI.profileWorkshop.assets(owner);if(!win.valid())return;for(const card of assets.cards.filter(x=>x.unused)){const label=text('label',card.label+' · ending '+card.last4),c=d.createElement('input');c.type='checkbox';c.checked=true;c.value=card.id;label.prepend(c);choices.append(label);}const b=text('button','Import reviewed profiles');b.type='submit';b.className='btn primary';form.append(b);form.onsubmit=async e=>{e.preventDefault();b.disabled=true;try{const result=await api.importCommit({token:preview.token,confirmed:true,customerName:customerName(),group:form.elements.group.value,alreadyJigged:form.elements.alreadyJigged.checked,repairs:Object.fromEntries(['name','email','card','allowShared'].map(k=>[k,form.elements[k].checked])),cardIds:[...choices.querySelectorAll('input:checked')].map(x=>x.value)});if(!win.valid())return;win.wrap.remove();await refresh();note('Imported '+result.imported+' profiles into '+customerName()+' / '+retailName[retailer]);}catch(e){win.status().textContent=e.message;b.disabled=false;}};}catch(e){note(e.message);}};
 const syncFailures=new Map();let syncChain=Promise.resolve();function syncCustomer(id,manual=false){const run=async()=>{try{const r=await api.syncCustomer({scope:'aco',customerId:id});syncFailures.delete(id);if(!main.hidden&&scope==='aco'&&customerId===id){await refresh();if(manual)note('Linked profiles: '+r.created+' created, '+r.updated+' updated, '+r.needsReview+' need review.');}}catch(e){if(manual||syncFailures.get(id)!==e.message){note('Customer synchronization failed: '+e.message);syncFailures.set(id,e.message);}}};const task=syncChain.catch(()=>{}).then(run);syncChain=task.catch(()=>{});return task;}
 q('rules').onclick=async()=>{try{const win=dialog(retailName[q('retailer').value]+' jig rules'),r=q('retailer').value,settings=await api.rules({...win.owner,retailer:r});if(!win.valid())return;const choices=d.createElement('div');groupedJigChoices(choices,settings);const save=text('button','Save rules for this vault and retailer');save.type='button';save.className='btn primary';save.onclick=async()=>{try{await api.saveRules({...win.owner,retailer:r,rules:selectedJigChoices(choices)});win.wrap.remove();note('Saved retailer jig rules for '+customerName()+'.');}catch(e){win.status().textContent=e.message;}};win.body.append(choices,save);}catch(e){note(e.message);}};
 q('pkc-reconcile').onclick=async()=>{try{if(scope!=='personal')throw Error('PKC inventory reconciliation is available only in your unlocked Personal vault.');q('retailer').value='pokemoncenter';selected.clear();group='all';await refresh();note('PKC inventory reconciled from all saved non-PKC Personal retailer emails. Review the unused-email and available-account counts above; additional emails are not automatically complete account profiles.');}catch(e){note('PKC reconciliation failed: '+String(e.message||e));}};
 q('sync').onclick=()=>customerId?void syncCustomer(customerId,true):note('Select a customer first.');
 async function flushRefresh(){if(pendingRefresh&&!editorBusy()){pendingRefresh=false;await refresh();}}
 d.addEventListener('focusout',()=>setTimeout(()=>void flushRefresh(),0));
 new MutationObserver(()=>{if(pendingRefresh&&!editorBusy())void flushRefresh();}).observe(d.body,{childList:true});
 const queuedCustomers=new Set();let autoRunning=false;async function autoSync(){for(const c of window.JigWebsiteCustomers?.list?.()||[])if(c.id&&c.paid)queuedCustomers.add(c.id);if(autoRunning)return;autoRunning=true;try{while(queuedCustomers.size){const id=queuedCustomers.values().next().value;queuedCustomers.delete(id);await syncCustomer(id);}}finally{autoRunning=false;}}
 d.addEventListener('aco-studio:edit-profile',async event=>{
  const detail=event.detail||{};
  if(!['aco','personal'].includes(detail.scope)||!detail.profileId)return;
  if(detail.scope==='aco'&&!detail.customerId)return;
  try{
   await open(detail.scope);
   if(main.hidden)return;
   if(detail.scope==='aco'){customerId=detail.customerId;q('customer').value=customerId;}
   await refresh();
   const match=rows.find(r=>r.id===detail.profileId);
   if(!match){note('This specific profile is no longer present. Choose a customer and refresh.');return;}
   q('retailer').value=match.retailer;stage=match.bank==='live'?'live':match.stage;group='all';draw();
   await edit(match);
  }catch(error){note('Unable to open this profile: '+String(error?.message||error));}
 });
 function renamePersonalJigs(){
  for(const el of d.querySelectorAll('button,a,h1,h2,strong,span'))if((el.textContent||'').trim()==='Personal Jigs')el.textContent='Jig';
  if((d.title||'').includes('Personal Jigs'))d.title=d.title.replaceAll('Personal Jigs','Jig');
 }
 renamePersonalJigs();
 new MutationObserver(renamePersonalJigs).observe(d.body,{childList:true,subtree:true});
 d.addEventListener('jigstudio:customers-updated',()=>{if(!main.hidden&&scope==='aco'&&websiteVault.open&&!d.querySelector('.profileLibraryModal'))void loadWebsiteVault();if(window.JigWebsiteCustomers?.connected?.()===false){queuedCustomers.clear();if(scope==='aco')close();return;}if(scope==='aco'&&!main.hidden&&!editorBusy())customerList();void autoSync();});d.addEventListener('jigstudio:personal-locked',()=>{if(scope==='personal')close();});d.addEventListener('jigstudio:bank-context-updated',()=>{if(!main.hidden)void refresh();});
 window.ACOProfileLibraryRefresh=Object.freeze({async all(){await autoSync();if(!main.hidden)await refresh();return {ok:true};},async current(){if(!main.hidden)await refresh();return {ok:true};}});
})();

