 // Owner-only random Email Gen, injected inside the encrypted Email Bank closure.
 const RANDOM_RETAILERS=Object.freeze({target:'Target',walmart:'Walmart',pokemoncenter:'Pokemon Center',costco:'Costco',sams:"Sam's"});
 let randomGenBusy=false;
 // Realistic, short name-style email aliases (10 characters maximum including digits).
 // Keep secure randomness and let the creation loop reject existing aliases.
 const RANDOM_FIRST_NAMES=Object.freeze(['ava','mia','zoe','ella','emma','lily','nina','maya','luna','ruby','clara','olive','hazel','alice','sarah','grace','naomi','chloe','sadie','molly','bella','cora','lucy','iris','ivy','jane','lena','anna','aria','noah','liam','levi','owen','jack','milo','ezra','theo','luca','cole','ryan','adam','finn','jude','nate','alex','ethan','mason','logan','caleb','henry','isaac','elias','jason','dylan','felix','troy','kyle','brady','eric','max']);
 const RANDOM_LAST_NAMES=Object.freeze(['reed','ford','cole','hale','lane','hart','gray','west','park','ross','hill','king','bell','shaw','ward','ray','snow','dale','long','cook','fox','oak','rose','webb','cox','love','dean','hunt','pace','fry','rice','page','kerr','moss','tate','york','faye','dunn','moon','bush']);
 function randomLocal(){
  const bytes=crypto.getRandomValues(new Uint8Array(5));
  const name=RANDOM_FIRST_NAMES[bytes[0]%RANDOM_FIRST_NAMES.length]+RANDOM_LAST_NAMES[bytes[1]%RANDOM_LAST_NAMES.length];
  const twoDigits=name.length<=8&&bytes[2]%2===0;
  return name+String(bytes[3]%10)+(twoDigits?String(bytes[4]%10):'');
 }
 // CSV export values are an owner-requested template for external imports.
 // Forwarding aliases are not mailboxes: this password never authenticates
 // to Cloudflare, IMAP, SMTP, or the encrypted Personal email vault.
 const EMAIL_GEN_EXPORT_PASSWORD='Freeshit1!';
 // Use the 24-column schema from the owner's REAL Shikari export, not
 // the different ACO Studio internal Target export. Shikari's saved CSV has
 // index first and profile_name SECOND. Do not insert non-template fields.
 // Aliases are not verified retailer accounts; all non-alias fields stay blank.
 const SHIKARI_SEED_COLUMNS=Object.freeze([
  'index','profile_name','first_name','last_name','email','phone_num',
  'cc_number','cc_exp_month','cc_exp_year','cc_cvv',
  'shipping_street','shipping_street_2','shipping_city','shipping_state',
  'shipping_zip_code','shipping_country','billing_first_name','billing_last_name',
  'billing_street','billing_street_2','billing_city','billing_state',
  'billing_zip_code','billing_country'
 ]);
 function buildEmailGenExportCsv(source,mode='basic'){
  if(!['basic','shikari'].includes(mode))throw Error('Unknown Email Gen export format.');
  const owned=Array.isArray(source)?source.filter(row=>
   typeof row?.alias==='string'&&row.alias.toLowerCase().endsWith('@'+OWNER_DOMAIN)&&validEmail(row.alias)):[];
  const seen=new Set();
  for(const row of owned){
   const alias=row.alias.toLowerCase();
   if(seen.has(alias))throw Error('Duplicate Email Gen aliases found. Review the bank before exporting.');
   seen.add(alias);
   if(/^[=+\-@]/.test(alias))throw Error('Invalid spreadsheet-leading character in alias. Review the Email Bank before exporting.');
  }
  const headers=mode==='shikari'?SHIKARI_SEED_COLUMNS:['profile_name','email','password'];
  const cell=value=>'"'+String(value).replace(/"/g,'""')+'"';
  const csv=headers.join(',')+'\r\n'+owned.map((row,index)=>{
   const values={index:String(index),profile_name:'aco gen '+(index+1),
    email:row.alias,password:EMAIL_GEN_EXPORT_PASSWORD};
   // Match the owner's exported Shikari CSV: index is an unquoted number,
   // profile_name is the second column, and there is no password field in
   // the native Shikari profile layout. Keep passwords in Basic Email Gen CSV.
   return mode==='shikari'?headers.map(key=>String(values[key]??'')).join(','):
    headers.map(key=>cell(values[key]??'')).join(',');
  }).join('\r\n')+'\r\n';
  const expectedStart=mode==='shikari'?'index,profile_name,':'profile_name,email,password';
  if(!csv.startsWith(expectedStart)||csv.charCodeAt(0)===65279)
   throw Error('Shikari export header does not match its selected template.');
  return {count:owned.length,csv};
 }
 function downloadEmailGenExport(mode='basic',extension='csv'){
  if(!['csv','txt'].includes(extension))throw Error('Unsupported Shikari export file type.');
  requireOwner();
  if(!unlocked)throw Error('Unlock your encrypted owner Email Gen bank to export its aliases.');
  const result=buildEmailGenExportCsv(records,mode);
  if(!result.count)throw Error('Create emails in Email Gen before exporting.');
  // No UTF-8 BOM before index (Shikari) or profile_name (basic).
  // Some importers treat BOM as part of the field name.
  const blob=new Blob([result.csv],{type:extension==='txt'?'text/plain;charset=utf-8':'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  try{
   const link=document.createElement('a');
   link.href=url;
   link.download=(mode==='shikari'?'shikari-email-profile-template-':'aco-gen-emails-')+new Date().toISOString().slice(0,10)+'.'+extension;
   link.hidden=true;
   document.body.appendChild(link);
   try{link.click();}
   finally{link.remove();}
  }finally{
   setTimeout(()=>URL.revokeObjectURL(url),15000);
  }
  return result.count;
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
  const exportButton=$e('randomAliasExport'),shikariButton=$e('randomAliasExportShikari'),shikariTextButton=$e('randomAliasExportShikariTxt');
  if(!exportButton||!shikariButton||!shikariTextButton)throw Error('Email Gen and Shikari export controls are unavailable.');
  for(const [button,mode,extension] of [[exportButton,'basic','csv'],[shikariButton,'shikari','csv'],[shikariTextButton,'shikari','txt']])button.addEventListener('click',()=>{
   if(randomGenBusy)return;
   try{
    const count=downloadEmailGenExport(mode,extension);
    randomNotice('Downloaded '+count+' Email Gen row(s). '+(mode==='shikari'?
     'The actual Shikari reference layout is index,profile_name,... (24 columns), with aco gen 1 through aco gen '+count+'; all unprovided card/address fields remain empty. Shikari profile exports do NOT have a password column.':
     'Basic Email Gen CSV has profile_name,email,password with aco gen 1 through aco gen '+count+' and the requested export-only password.'),true);
   }catch(error){randomNotice(String(error?.message||error));}
  });
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
