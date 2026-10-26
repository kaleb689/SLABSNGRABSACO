 // Owner-only random Email Gen, injected inside the encrypted Email Bank closure.
 const RANDOM_RETAILERS=Object.freeze({target:'Target',walmart:'Walmart',pokemoncenter:'Pokemon Center',costco:'Costco',sams:"Sam's"});
 let randomGenBusy=false;
 function randomLocal(){
  const bytes=crypto.getRandomValues(new Uint8Array(12));
  return 'sng'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
 }
 const unassignedRandom=()=>records.filter(r=>r.randomGenerated===true&&!r.poolTarget);
 const unsyncedRandom=()=>records.filter(r=>r.randomGenerated===true&&RANDOM_RETAILERS[r.poolTarget]&&!r.poolImportedAt);
 function randomNotice(message,ok=false){alertMessage('randomAliasStatus',message,ok);}
 function refreshRandomChooser(){
  const chooser=$e('randomAliasPoolChooser');
  if(!chooser)return;
  const available=unlocked?unassignedRandom():[],unsynced=unlocked?unsyncedRandom():[];
  chooser.hidden=!unlocked||available.length===0;
  $e('randomAliasWaiting').textContent=available.length+' generated email(s) waiting for a retailer unused pool.';
  const sync=$e('randomAliasSync');sync.hidden=!unlocked||unsynced.length===0;
  sync.textContent='Publish / sync '+unsynced.length+' assigned email(s)';
  refreshDraftDestinations();
 }
 async function importLiveRandom(){
  const live=unsyncedRandom().filter(r=>r.status==='live'&&r.forwardingTestedAt&&r.forwardingTestTarget===r.target);
  if(!live.length)return {added:0,already:0};
  if(!window.JigPersonalGuard?.ensureUnlocked||!await window.JigPersonalGuard.ensureUnlocked())
   throw Error('Unlock the Personal vault before adding emails to a retailer pool.');
  const importer=window.desktopAPI?.profileWorkshop?.importEmails;
  if(typeof importer!=='function')throw Error('Personal retailer unused email pools are unavailable.');
  let added=0,already=0;
  for(const retailer of Object.keys(RANDOM_RETAILERS)){
   const batch=live.filter(r=>r.poolTarget===retailer);
   if(!batch.length)continue;
   const saved=await importer({scope:'personal',customerId:null,retailer,emails:batch.map(r=>r.alias)});
   if(saved.invalid||saved.added+saved.skipped!==batch.length)throw Error('The '+RANDOM_RETAILERS[retailer]+' pool did not confirm the import.');
   for(const row of batch)row.poolImportedAt=new Date().toISOString();
   added+=saved.added;already+=saved.skipped;
   if(!await store())throw Error('Email pool imported, but local encrypted status could not be saved. Retry sync after checking your vault.');
  }
  document.dispatchEvent(new CustomEvent('jigstudio:bank-context-updated'));
  return {added,already};
 }
 async function publishRandomAndSync(){
  requireOwner();
  const pending=unsyncedRandom();
  if(!pending.length){randomNotice('All assigned random emails are already in their unused pools.',true);return;}
  const toPublish=pending.filter(r=>r.status==='draft'||r.status==='pending').slice(0,100);
  const publishIssues=[];
  if(toPublish.length){
   const published=await api().publish(toPublish.map(({alias,target})=>({alias,target})));
   for(const result of published.items||[]){
    if(result.error)publishIssues.push(result.alias+': '+result.error);
    const row=records.find(r=>r.randomGenerated===true&&r.alias===result.alias);
    if(!row||!['draft','pending','live','paused','conflict'].includes(result.status))continue;
    row.status=result.status;row.remoteId=result.remoteId||null;
   }
   if(!await store())throw Error('Cloudflare published but the encrypted bank failed to save. Nothing was imported to a retailer pool.');
  }
  const report=await importLiveRandom(),left=unsyncedRandom();
  randomNotice(report.added+' verified live email(s) added to unused pools; '+report.already+' already present; '+left.length+' still awaiting activation, verification or review.'+
   (publishIssues.length?' Cloudflare publication issues ('+publishIssues.length+'): '+publishIssues.slice(0,3).join(' | '):''),left.length===0);
  refreshRandomChooser();
 }
 async function testAllRandomEmails(){
  requireOwner();
  const mailbox=$e('emailTarget').value.trim().toLowerCase();
  const smtpHost=$e('randomTestSmtp').value.trim().toLowerCase();
  const imapHost=$e('randomTestImap').value.trim().toLowerCase();
  const password=$e('randomTestPassword').value;
  const sender=$e('randomTestSender').value.trim().toLowerCase();
  const senderPassword=$e('randomTestSenderPassword').value;
  if(!validEmail(mailbox)||mailbox.endsWith('@'+OWNER_DOMAIN))
   throw Error('Enter the verified external forwarding inbox in the field above.');
  if(!password)throw Error('Enter the app password for your verified inbox to test delivery.');
  if(!validEmail(sender)||!senderPassword)throw Error('Enter a separate sending account and its app password. Keep the forwarding inbox unchanged.');
  const selected=records.filter(r=>r.randomGenerated===true&&r.target===mailbox);
  if(!selected.length)throw Error('No generated aliases forward to this inbox.');
  const live=selected.filter(r=>r.status==='live');
  if(!live.length)throw Error('Publish and activate forwarding first, then test delivery.');
  const verify=api()?.testForwarding;
  if(typeof verify!=='function')throw Error('This build is missing the end-to-end SMTP/IMAP test service.');
  let passed=0,failed=0,attempted=0;
  for(let index=0;index<live.length;index+=100){
   const batch=live.slice(index,index+100);
   $e('randomTestStatus').textContent='Sending test messages and checking inbox delivery: '+attempted+'/'+live.length+' tested.';
   const result=await verify({mailbox,sender,senderPassword,smtpHost,imapHost,password,aliases:batch.map(r=>r.alias)});
   for(const item of result.results||[]){
    const row=batch.find(r=>r.alias===item.alias);
    if(!row)continue;
    if(item.status==='delivered'){
     row.forwardingTestedAt=new Date().toISOString();row.forwardingTestTarget=mailbox;passed++;
    }else{
     row.forwardingTestedAt=null;row.forwardingTestTarget=null;failed++;
    }
   }
   attempted+=batch.length;
   if(!await store())throw Error('Mailbox tests completed but results could not be saved in the encrypted Email Bank.');
  }
  const noRule=selected.length-live.length,added=await importLiveRandom();
  $e('randomTestStatus').textContent='Delivery tests: '+passed+' PASSED (received in IMAP), '+failed+' not confirmed, '+noRule+' awaiting active Cloudflare routing. '+added.added+' verified emails imported to unused retailer pools. No failed test was marked usable.';
  randomNotice(passed+' forwarded addresses confirmed by a real inbox receipt; '+failed+' failed/unconfirmed.',failed===0&&noRule===0);
  refreshRandomChooser();
 }
 // Changing the top forwarding field only affects NEW aliases. This
 // owner-only flow changes already-saved, unpublished RANDOM DRAFTS explicitly.
 // Active/pending/remote/imported/manual entries must never be changed here.
 const eligibleRandomDraft=r=>r.randomGenerated===true&&r.status==='draft'&&!r.remoteId&&!r.poolImportedAt;
 function draftDestinationPlan(source,destination){
  requireOwner();
  source=String(source||'').trim().toLowerCase();destination=String(destination||'').trim().toLowerCase();
  if(!validEmail(source)||!validEmail(destination)||destination.endsWith('@'+OWNER_DOMAIN))
   throw Error('Choose an existing draft destination and enter a verified external forwarding inbox.');
  if(source===destination)throw Error('The new inbox is already the saved destination. Nothing changed.');
  const matches=records.filter(r=>eligibleRandomDraft(r)&&r.target===source);
  if(!matches.length)throw Error('No unpublished random drafts use that inbox. Existing live/assigned aliases were not changed.');
  if(new Set(matches.map(x=>x.alias)).size!==matches.length)
   throw Error('Duplicate alias records require review before changing any destination.');
  return {source,destination,entries:matches.map(r=>({alias:r.alias,target:r.target,status:r.status,poolTarget:r.poolTarget||null,
   remoteId:r.remoteId||null,poolImportedAt:r.poolImportedAt||null}))};
 }
 async function changeDraftDestinations(plan){
  requireOwner();
  if(!plan?.entries?.length||!plan?.source||!plan?.destination)
   throw Error('Review the destination change first.');
  const fresh=draftDestinationPlan(plan.source,plan.destination);
  if(fresh.entries.length!==plan.entries.length||
     fresh.entries.some((x,i)=>JSON.stringify(x)!==JSON.stringify(plan.entries[i])))
   throw Error('The Email Bank changed since preview. Review the change again; no aliases were modified.');
  // The existing ciphertext is a REQUIRED verified backup; never back up
  // plaintext aliases, passwords, or Cloudflare tokens.
  const previous=localStorage.getItem(KEY);
  if(!previous)throw Error('No saved encrypted Email Bank was found. Nothing changed.');
  const entropy=crypto.getRandomValues(new Uint8Array(8));
  const backupKey=KEY+'.destination-backup.'+Date.now()+'.'+Array.from(entropy,x=>x.toString(16).padStart(2,'0')).join('');
  if(localStorage.getItem(backupKey)!==null)throw Error('Encrypted backup collision. Nothing changed.');
  localStorage.setItem(backupKey,previous);
  if(localStorage.getItem(backupKey)!==previous)
   throw Error('Encrypted backup verification failed. No drafts were changed.');
  const selected=new Set(plan.entries.map(x=>x.alias));
  const before=records.filter(r=>selected.has(r.alias)).map(r=>({
   row:r,target:r.target,forwardingTestedAt:r.forwardingTestedAt,
   forwardingTestTarget:r.forwardingTestTarget
  }));
  try{
   for(const x of before){
    x.row.target=plan.destination;
    x.row.forwardingTestedAt=null;x.row.forwardingTestTarget=null;
   }
   if(!await store())throw Error('The encrypted Email Bank could not be saved.');
  }catch(error){
   for(const x of before){
    x.row.target=x.target;x.row.forwardingTestedAt=x.forwardingTestedAt;
    x.row.forwardingTestTarget=x.forwardingTestTarget;
   }
   // Preserve the verified backup in every case, including storage failure.
   // Restore the original ciphertext if store() had partially written it.
   try{if(localStorage.getItem(KEY)!==previous)localStorage.setItem(KEY,previous);}catch{}
   throw Error('Destination change was not completed: '+String(error?.message||error)+'. The original encrypted backup was retained.');
  }
  return {changed:before.length,from:plan.source,to:plan.destination,encryptedBackupPreserved:true};
 }
 function refreshDraftDestinations(){
  const dropdown=$e('randomDestinationOld');if(!dropdown)return;
  const current=dropdown.value,counts=new Map();
  for(const row of unlocked?records:[])if(eligibleRandomDraft(row)){
   counts.set(row.target,(counts.get(row.target)||0)+1);
  }
  dropdown.replaceChildren(new Option('Choose destination...',''));
  for(const [mailbox,count] of [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])))
   dropdown.add(new Option(mailbox+' ('+count+' drafts)',mailbox));
  if(counts.has(current))dropdown.value=current;
 }
 function setupDraftDestinationControls(){
  const preview=$e('randomDestinationPreview'),commit=$e('randomDestinationConfirm'),cancel=$e('randomDestinationCancel');
  if(!preview||!commit||!cancel)throw Error('Existing draft destination controls are missing.');
  let plan=null;
  const panel=$e('randomDestinationConfirmArea'),notice=$e('randomDestinationStatus');
  const reset=()=>{plan=null;panel.hidden=true;$e('randomDestinationAcknowledged').checked=false;};
  const chooseTo=()=>String($e('randomDestinationNew').value||'').trim().toLowerCase();
  const chooseFrom=()=>String($e('randomDestinationOld').value||'').trim().toLowerCase();
  const changed=()=>{reset();notice.textContent='Destination selection changed. Preview again before saving.';};
  $e('randomDestinationOld').addEventListener('change',changed);
  $e('randomDestinationNew').addEventListener('input',changed);
  preview.addEventListener('click',()=>{
   if(randomGenBusy)return;
   try{
    const to=chooseTo()||String($e('emailTarget').value||'').trim().toLowerCase();
    if(!$e('randomDestinationNew').value.trim())$e('randomDestinationNew').value=to;
    plan=draftDestinationPlan(chooseFrom(),to);
    $e('randomDestinationSummary').textContent='Change '+plan.entries.length+' existing RANDOM DRAFT aliases from '+plan.source+' to '+plan.destination+'?';
    $e('randomDestinationAcknowledged').checked=false;panel.hidden=false;
    notice.textContent='Preview only: no saved aliases, Cloudflare rules or retailer pools have changed.';
   }catch(error){reset();notice.textContent=String(error?.message||error);}
  });
  cancel.addEventListener('click',()=>{reset();notice.textContent='Canceled. No aliases were changed.';});
  commit.addEventListener('click',async()=>{
   if(randomGenBusy)return;
   if(!plan||panel.hidden||!$e('randomDestinationAcknowledged').checked){
    notice.textContent='Preview the draft destinations and check the confirmation box first.';return;
   }
   randomGenBusy=true;commit.disabled=true;
   try{
    if(chooseFrom()!==plan.source||chooseTo()!==plan.destination)
     throw Error('The destination changed since preview. Review again.');
    const result=await changeDraftDestinations(plan);
    reset();render();refreshDraftDestinations();
    notice.textContent='Updated '+result.changed+' existing random DRAFT aliases to '+result.to+'; verified original encrypted backup preserved. No new addresses generated and no Cloudflare rules published. You can now Publish / sync the assigned drafts.';
   }catch(error){reset();notice.textContent=String(error?.message||error);}
   finally{commit.disabled=false;randomGenBusy=false;}
  });
  refreshDraftDestinations();
 }
 function setupRandomEmailGen(){
  const create=$e('randomAliasCreate'),assign=$e('randomAliasAssign'),sync=$e('randomAliasSync');
  if(!create||!assign||!sync)throw Error('Random Email Gen controls are unavailable.');
  create.addEventListener('click',async()=>{
   if(randomGenBusy)return;randomGenBusy=true;create.disabled=true;
   try{
    requireOwner();
    const count=Number($e('randomAliasCount').value),target=$e('emailTarget').value.trim().toLowerCase();
    if(!Number.isSafeInteger(count)||count<1||count>100)throw Error('Choose 1–100 random forwarding emails.');
    if(!validEmail(target)||target.endsWith('@'+OWNER_DOMAIN))throw Error('Enter your verified external IMAP inbox in the forwarding destination field above.');
    if(records.length+count>10000)throw Error('Encrypted Email Bank capacity would be exceeded.');
    const existing=new Set(records.map(r=>r.alias)),batch=[];
    for(let i=0;i<count;i++){
     let local,alias,attempts=0;
     do{
      if(++attempts>100)throw Error('Could not produce a unique email address.');
      local=randomLocal();alias=local+'@'+OWNER_DOMAIN;
     }while(existing.has(alias));
     existing.add(alias);
     const row=makeAlias('Random '+local,local,target,currentDomain());
     row.randomGenerated=true;row.poolTarget=null;row.poolImportedAt=null;batch.push(row);
    }
    records.push(...batch);
    if(!await store()){
     for(const row of batch){const index=records.indexOf(row);if(index>=0)records.splice(index,1);}
     render();throw Error('The encrypted bank did not save. No addresses were retained.');
    }
    randomNotice('Created '+batch.length+' random @'+OWNER_DOMAIN+' email drafts. All will forward to '+target+' once Cloudflare is live. Choose the unused retailer pool below.',true);
    refreshRandomChooser();
   }catch(error){randomNotice(String(error.message||error));}
   finally{randomGenBusy=false;create.disabled=false;}
  });
  assign.addEventListener('click',async()=>{
   if(randomGenBusy)return;randomGenBusy=true;assign.disabled=true;
   try{
    requireOwner();
    const retailer=$e('randomAliasPool').value;
    if(!RANDOM_RETAILERS[retailer])throw Error('Choose an unused retailer pool.');
    const batch=unassignedRandom();
    if(!batch.length)throw Error('Generate random emails first.');
    for(const row of batch)row.poolTarget=retailer;
    if(!await store()){
     for(const row of batch)row.poolTarget=null;
     throw Error('Pool selection could not be encrypted. No pool was changed.');
    }
    refreshRandomChooser();
    await publishRandomAndSync();
   }catch(error){randomNotice(String(error.message||error));}
   finally{randomGenBusy=false;assign.disabled=false;refreshRandomChooser();}
  });
  sync.addEventListener('click',async()=>{
   if(randomGenBusy)return;randomGenBusy=true;sync.disabled=true;
   try{await publishRandomAndSync();}
   catch(error){randomNotice(String(error.message||error));}
   finally{randomGenBusy=false;sync.disabled=false;refreshRandomChooser();}
  });
  const testAll=$e('randomAliasTestAll');
  if(!testAll)throw Error('Test All Emails button is missing.');
  testAll.addEventListener('click',async()=>{
   if(randomGenBusy)return;randomGenBusy=true;testAll.disabled=true;
   try{await testAllRandomEmails();}
   catch(error){$e('randomTestStatus').textContent='Delivery test did not pass: '+String(error?.message||error)+'. No unverified email was imported.';}
   finally{$e('randomTestPassword').value='';$e('randomTestSenderPassword').value='';testAll.disabled=false;randomGenBusy=false;refreshRandomChooser();}
  });
  refreshRandomChooser();
  setupDraftDestinationControls();
 }
