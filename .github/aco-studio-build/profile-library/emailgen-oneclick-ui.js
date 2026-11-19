
 // Simplified owner Email Gen workflow: one click saves a unique batch and
 // starts bounded, receipt-verified testing through Cloudflare's R2/D1 path.
 // No catch-all routing rules are edited from the app and SMTP acceptance
 // is NEVER treated as successful delivery.
 const CLOUD_EMAIL_PREF='aco.emailgen.cloud-receipts.v1';
 function cloudOneClickEnabled(){
  try{return localStorage.getItem(CLOUD_EMAIL_PREF)!=='legacy';}catch{return true;}
 }
 function cloudSenderProfiles(){
  return mailTestState.profiles.filter(p=>mailTestState.selectedSenderKeys.has(mailPairKey(p))||
   (!mailTestState.senderPoolUserCustomized&&!mailTestState.selectedSenderKeys.size));
 }
 function cloudFallbackDestination(){
  const field=mailUIElement('emailTarget');
  const entered=String(field?.value||'').trim().toLowerCase();
  if(validEmail(entered)&&!entered.endsWith('@'+OWNER_DOMAIN))return entered;
  const saved=cloudSenderProfiles().find(p=>validEmail(p.mailbox)&&!p.mailbox.endsWith('@'+OWNER_DOMAIN));
  return saved?.mailbox||'';
 }
 async function runCloudReceiptTests({batchId=null,batchKeys=null,all=false,automatic=false,limit=null}={}){
  if(mailTestState.active||mailTestState.starting||randomGenBusy){
   if(automatic&&batchId)mailTestState.autoPendingBatch=batchId;
   return;
  }
  const status=mailUIElement('randomTestStatus'),quick=mailUIElement('randomOneClickStatus');
  const say=message=>{if(status)status.textContent=message;if(quick)quick.textContent=message;};
  mailTestState.starting=true;
  mailTestState.total=0;mailTestState.done=0;mailTestState.passed=0;mailTestState.failed=0;
  mailTestState.unconfirmed=0;mailTestState.paused=false;mailTestState.recent=[];renderAutoTestProgress();
  let rows=[],senders=[];
  try{
   requireOwner();
   if(!unlocked)throw Error('Unlock the encrypted Email Bank first; saved emails were not changed.');
   const selected=testRowsForSelection({batchId,batchKeys,all});
   rows=selected.filter(r=>r.randomGenerated===true&&r.deliveryMode==='cloudflare-inbound'&&
    (!r.forwardingTestedAt||r.forwardingTestTarget!==r.target));
   if(Number.isSafeInteger(limit)&&limit>0)rows=rows.slice(0,limit);
   if(!rows.length){say('No unverified Cloudflare-receiver emails in this selection. Existing verified emails were left untouched.');return;}
   const native=api();
   if(typeof native?.inboundWorkerStatus!=='function'||typeof native?.testInboundWorker!=='function')
    throw Error('This ACO Studio version cannot verify Cloudflare Worker receipts; update the desktop app.');
   await loadSavedMailPairs(true);
   senders=cloudSenderProfiles();
   if(!senders.length)throw Error('Save and select a verified sending account once under Mail accounts & forwarding settings. Receiver IMAP is not used for Cloudflare receipt verification.');
   const ready=await native.inboundWorkerStatus();
   if(!ready?.storageReady)throw Error('Cloudflare receipt storage is not accessible. Existing routing was not changed.');
  }catch(error){
   say('Cloudflare automatic verification NOT STARTED: '+String(error?.message||error)+
    ' Generated aliases remain saved as unverified. Reconnect Cloudflare with D1 Read access if needed.');
   return;
  }finally{mailTestState.starting=false;}
  mailTestState.active=true;randomGenBusy=true;mailTestState.cancel=false;mailTestState.paused=false;
  mailTestState.runId=createTestRunId();mailTestState.statuses=new Map(rows.map(r=>[r.alias.toLowerCase(),'pending']));
  mailTestState.total=rows.length;
  const stop=mailUIElement('randomAliasTestStop');
  if(stop)stop.hidden=false;
  for(const id of ['randomAliasCreate','randomAliasTestAll','randomAliasTestBatch','randomAliasTestMulti','randomAliasTestOne','emailBatchDeleteReview','emailBatchRemoveOneReview']){
   const button=mailUIElement(id);if(button)button.disabled=true;
  }
  say('Cloudflare receiver index is accessible. Sending three test messages first; only exact real Cloudflare receipts will be verified. This does not switch live routing.');
  let completed=0,dirty=0,senderCursor=0,preflightPassed=false;
  try{
   for(let i=0;i<rows.length;){
    if(mailTestState.cancel||mailTestState.paused)break;
    const preflight=i===0;
    const group=rows.slice(i,i+(preflight?Math.min(3,rows.length):AUTO_TEST_GROUP_SIZE));
    const sender=senders[senderCursor%senders.length];senderCursor++;
    let result;
    try{
     result=await api().testInboundWorker({
      aliases:group.map(r=>r.alias),mailbox:sender.mailbox,sender:sender.sender,runId:mailTestState.runId
     });
    }catch(error){
     mailTestState.paused=true;
     say('Cloudflare verification paused without changing remaining aliases: '+String(error?.message||error)+
      '. Retry this batch after confirming routing, account permissions and sender limits.');
     break;
    }
    if(result?.provider!=='cloudflare-d1'||!Array.isArray(result.results))
     throw Error('Cloudflare returned an invalid receipt response. No unconfirmed aliases were marked live.');
    const current=new Map(group.map(row=>[row.alias.toLowerCase(),row]));
    const seen=new Set();
    for(const item of result.results){
     const row=current.get(String(item.alias||'').toLowerCase());
     if(!row||seen.has(row.alias))continue;
     seen.add(row.alias);
     const state=item.status==='delivered'?'delivered':
      item.status==='send_failed'?'send_failed':item.status==='not_attempted'?'pending':'unconfirmed';
     if(state==='delivered'){
      const stamp=new Date().toISOString();
      row.forwardingTestedAt=stamp;row.forwardingTestTarget=row.target;
      row.catchAllVerifiedAt=stamp;row.verificationSource='cloudflare-d1';
      row.status='live';
     }
     trackTestResult(row.alias,state);
    }
    for(const row of group)if(!seen.has(row.alias))trackTestResult(row.alias,'unconfirmed');
    i+=group.length;completed+=group.length;dirty+=group.length;
    say('Cloudflare receipt checks: '+mailTestState.done+'/'+rows.length+' checked; '+mailTestState.passed+
     ' confirmed, '+mailTestState.unconfirmed+' awaiting delivery, '+mailTestState.failed+' SMTP failures.');
    if(dirty>=50){if(!await store())throw Error('The encrypted Email Bank did not save receipt results. Stop and inspect the bank.');dirty=0;}
    if(preflight){
     preflightPassed=group.some(row=>!!row.forwardingTestedAt&&row.verificationSource==='cloudflare-d1');
     if(!preflightPassed){
      mailTestState.paused=true;
      say('SAFE STOP: none of the first '+group.length+
       ' generated emails reached Cloudflare. No further test messages were sent. Your existing catch-all still needs a verified routing cutover; all other addresses remain unverified.');
      break;
     }
    }
    if(result.rateLimited){
     mailTestState.paused=true;
     say('Sending provider rate limit reached. Stopped safely; untested aliases remain saved and unverified.');
     break;
    }
   }
   if(dirty&&!await store())throw Error('The encrypted Email Bank could not save verified receipts; retry after checking the vault.');
   if(!mailTestState.paused)say('Cloudflare run finished: '+mailTestState.passed+' verified by actual stored receipts, '+
    mailTestState.unconfirmed+' not confirmed, '+mailTestState.failed+' send failures, '+
    (rows.length-mailTestState.done)+' not attempted. You may retry only the remaining unverified emails.');
  }catch(error){
   try{if(dirty)await store();}catch{}
   say('Cloudflare verification stopped: '+String(error?.message||error)+
    '. Never treat SMTP send success as delivered. Confirm the saved bank before retrying.');
  }finally{
   mailTestState.active=false;randomGenBusy=false;if(stop)stop.hidden=true;
   for(const id of ['randomAliasCreate','randomAliasTestAll','randomAliasTestBatch','randomAliasTestMulti','randomAliasTestOne','emailBatchDeleteReview','emailBatchRemoveOneReview']){
    const button=mailUIElement(id);if(button)button.disabled=false;
   }
   renderAutoTestProgress();refreshEmailBatchUI();refreshRandomChooser();
  }
 }
 function setupOneClickEmailGen(){
  const enabled=mailUIElement('randomCloudReceiptMode'),indicator=mailUIElement('randomOneClickStatus'),create=mailUIElement('randomAliasCreate');
  if(!enabled||!indicator||!create)throw Error('Email Gen one-click Cloudflare controls are missing.');
  enabled.checked=cloudOneClickEnabled();
  const render=()=>{
   create.textContent=enabled.checked?'Generate & Auto-Verify':'Generate Only — Save Emails';
   indicator.textContent=enabled.checked
    ?'Cloudflare mode: Generate saves the addresses, then sends a 3-email receipt preflight and continues only after real delivery proof. The staging Worker is not yet connected to the live sng.sarl catch-all. Pending emails remain unverified.'
    :'Legacy mode: Generate saves addresses and can use previously saved IMAP inbox tests.';
  };
  enabled.addEventListener('change',()=>{
   localStorage.setItem(CLOUD_EMAIL_PREF,enabled.checked?'cloudflare':'legacy');
   render();
  });
  render();
  const refresh=mailUIElement('randomCloudCheckStatus');
  if(refresh)refresh.addEventListener('click',async()=>{
   const old=indicator.textContent;refresh.disabled=true;indicator.textContent='Checking Cloudflare receipt database access...';
   try{
    const result=await api().inboundWorkerStatus();
    indicator.textContent=result?.storageReady
     ?'Cloudflare D1 receipt database accessible. This alone does not prove live Email Routing; the 3-message preflight confirms actual delivery.'
     :'Cloudflare receipt database is not ready; existing aliases remain unchanged.';
   }catch(error){indicator.textContent='Cloudflare check failed: '+String(error?.message||error)+'. No aliases changed.';}
   finally{refresh.disabled=false;}
  });
 }
