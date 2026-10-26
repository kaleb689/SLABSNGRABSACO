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
 }
 async function importLiveRandom(){
  const live=unsyncedRandom().filter(r=>r.status==='live');
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
  if(toPublish.length){
   const published=await api().publish(toPublish.map(({alias,target})=>({alias,target})));
   for(const result of published.items||[]){
    const row=records.find(r=>r.randomGenerated===true&&r.alias===result.alias);
    if(!row||!['draft','pending','live','paused','conflict'].includes(result.status))continue;
    row.status=result.status;row.remoteId=result.remoteId||null;
   }
   if(!await store())throw Error('Cloudflare published but the encrypted bank failed to save. Nothing was imported to a retailer pool.');
  }
  const report=await importLiveRandom(),left=unsyncedRandom();
  randomNotice(report.added+' verified live email(s) added to unused pools; '+report.already+' already present; '+left.length+' still awaiting activation, verification or review.',left.length===0);
  refreshRandomChooser();
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
  refreshRandomChooser();
 }
