
 // Owner-only automatic verification UI, batched so thousands of generated
 // emails never cause a synchronous renderer repaint for every test result.
 const MAIL_TEST_CATCHALL_PREF='aco.emailgen.catchall.preferences.v1';
 const AUTO_TEST_GROUP_SIZE=25;
 const AUTO_TEST_PREFLIGHT_SIZE=3;
 const AUTO_TEST_SAVE_EVERY=75; // Persist up to 75 test results at once to keep the Mac UI responsive.
 const mailTestState={active:false,starting:false,cancel:false,profiles:[],profileCheckedAt:0,
  loadingProfiles:false,runId:'',statuses:new Map(),recent:[],total:0,done:0,passed:0,failed:0,unconfirmed:0,
  paused:false,lastRunAt:0,runTarget:'',autoPendingBatch:null,cleanupPending:0,
  selectedBatchKeys:new Set(),batchSelectionInitialized:false,selectedSenderKeys:new Set(),senderPoolInitialized:false,
  selectedReceiverTargets:new Set(),receiverPoolInitialized:false};
 let mailProgressTimer=null;
 const mailUIElement=id=>$e(id);
 function readCatchallPreferences(){
  try{
   const map=JSON.parse(localStorage.getItem(MAIL_TEST_CATCHALL_PREF)||'{}');
   return map&&typeof map==='object'&&!Array.isArray(map)?map:{};
  }catch{return {};}
 }
 function catchallForMailbox(mailbox){
  return readCatchallPreferences()[String(mailbox||'').trim().toLowerCase()]===true;
 }
 function setCatchallForMailbox(mailbox,value){
  const address=String(mailbox||'').trim().toLowerCase();
  if(!validEmail(address))return;
  const map=readCatchallPreferences();map[address]=Boolean(value);
  localStorage.setItem(MAIL_TEST_CATCHALL_PREF,JSON.stringify(map));
 }
 function mailPairKey(profile){return String(profile.mailbox||'')+'::'+String(profile.sender||'');}
 function mailProfilesFor(mailbox){
  return mailTestState.profiles.filter(p=>p.mailbox===mailbox).sort((a,b)=>
   String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
 }
 function availableSenderProfiles(mailbox){
  return mailProfilesFor(mailbox).filter(p=>mailTestState.selectedSenderKeys.has(mailPairKey(p)));
 }
 function renderMailAccountPools(){
  const senderList=mailUIElement('randomTestSenderPoolList'),receiverList=mailUIElement('randomTestReceiverPoolList');
  const pairs=mailTestState.profiles;
  const validPairs=new Set(pairs.map(mailPairKey));
  if(!mailTestState.senderPoolInitialized){
   mailTestState.selectedSenderKeys=new Set(validPairs);
   mailTestState.senderPoolInitialized=true;
  }else mailTestState.selectedSenderKeys=new Set([...mailTestState.selectedSenderKeys].filter(k=>validPairs.has(k)));
  const targets=[...new Set(pairs.map(p=>p.mailbox))].sort();
  if(!mailTestState.receiverPoolInitialized){
   mailTestState.selectedReceiverTargets=new Set(targets.slice(0,2));
   mailTestState.receiverPoolInitialized=true;
  }else mailTestState.selectedReceiverTargets=new Set([...mailTestState.selectedReceiverTargets].filter(k=>targets.includes(k)));
  if(senderList){
   senderList.replaceChildren();
   for(const p of pairs){
    const label=document.createElement('label');label.className='check';
    label.style.cssText='display:flex;gap:7px;align-items:center;margin:4px 0';
    const check=document.createElement('input');check.type='checkbox';check.value=mailPairKey(p);
    check.checked=mailTestState.selectedSenderKeys.has(check.value);check.setAttribute('data-test-sender',check.value);
    const note=document.createElement('span');note.className='tiny';note.textContent=p.sender+' → '+p.mailbox;
    label.appendChild(check);label.appendChild(note);senderList.appendChild(label);
   }
  }
  const senderStatus=mailUIElement('randomTestSenderPoolStatus');
  if(senderStatus)senderStatus.textContent=mailTestState.selectedSenderKeys.size+' of '+pairs.length+' verified sender/receiver pairs enabled. Only senders paired with an alias’s actual destination are eligible.';
  if(receiverList){
   receiverList.replaceChildren();
   for(const mailbox of targets){
    const label=document.createElement('label');label.className='check';
    label.style.cssText='display:flex;gap:7px;align-items:center;margin:4px 0';
    const check=document.createElement('input');check.type='checkbox';check.value=mailbox;
    check.checked=mailTestState.selectedReceiverTargets.has(mailbox);check.setAttribute('data-split-receiver',mailbox);
    const note=document.createElement('span');note.className='tiny';note.textContent=mailbox+' (saved IMAP credentials)';
    label.appendChild(check);label.appendChild(note);receiverList.appendChild(label);
   }
  }
 }
 function findSavedMailPair(mailbox){
  const options=mailProfilesFor(mailbox);
  const select=mailUIElement('randomMailPreset');
  const chosen=options.find(p=>mailPairKey(p)===select?.value);
  return chosen||options[0]||null;
 }
 function applyMailPairToForm(profile){
  if(!profile)return;
  mailUIElement('randomTestReceiver').value=profile.mailbox;
  mailUIElement('randomTestSender').value=profile.sender;
  mailUIElement('randomTestSmtp').value=profile.smtpHost||'smtp.gmail.com';
  mailUIElement('randomTestImap').value=profile.imapHost||'imap.gmail.com';
  mailUIElement('randomTestSenderImap').value=profile.senderImapHost||'imap.gmail.com';
  mailUIElement('randomAliasCatchAllTest').checked=catchallForMailbox(profile.mailbox);
 }
 function refreshSavedMailPairPicker(){
  const select=mailUIElement('randomMailPreset');if(!select)return;
  const old=select.value,receiver=mailUIElement('randomTestReceiver').value.trim().toLowerCase();
  const profiles=mailTestState.profiles;
  select.replaceChildren();
  const empty=document.createElement('option');empty.value='';empty.textContent='Add new sender / forwarding inbox pair';select.appendChild(empty);
  for(const profile of profiles){
   const item=document.createElement('option');
   item.value=mailPairKey(profile);
   item.textContent=profile.mailbox+' ← '+profile.sender+' (saved securely)';
   select.appendChild(item);
  }
  let chosen=profiles.find(p=>mailPairKey(p)===old)||profiles.find(p=>p.mailbox===receiver)||null;
  if(!chosen&&profiles.length===1)chosen=profiles[0];
  if(chosen){select.value=mailPairKey(chosen);applyMailPairToForm(chosen);}
  else select.value='';
  const status=mailUIElement('randomMailCredentialsStatus');
  if(status&&status.dataset.error!=='1'){
   status.textContent=profiles.length+' secure mail account pair(s) saved on this Mac. You can swap the receiver or sender without deleting the other configurations.';
  }
 }
 async function loadSavedMailPairs(force=false){
  if(!unlocked)return [];
  if(mailTestState.loadingProfiles)return mailTestState.profiles;
  if(!force&&Date.now()-mailTestState.profileCheckedAt<30000)return mailTestState.profiles;
  mailTestState.profileCheckedAt=Date.now();mailTestState.loadingProfiles=true;
  try{
   const response=await api().mailTestCredentialStatus();
   mailTestState.profiles=Array.isArray(response?.profiles)?response.profiles.filter(p=>p&&validEmail(p.mailbox)&&validEmail(p.sender)):[];
   refreshSavedMailPairPicker();
   renderMailAccountPools();
   if(mailTestState.autoPendingBatch&&!mailTestState.active){
    const pending=mailTestState.autoPendingBatch,group=emailBatchGroups().find(g=>g.key==='batch:'+pending);
    if(group&&group.rows.some(r=>mailProfilesFor(r.target).length)){
     mailTestState.autoPendingBatch=null;
     setTimeout(()=>{if(!mailTestState.active)void runAutomaticEmailTests({batchId:pending,automatic:true});},100);
    }
   }
   return mailTestState.profiles;
  }catch(error){
   const node=mailUIElement('randomMailCredentialsStatus');if(node)node.textContent='Secure mail credentials could not be accessed: '+String(error?.message||error);
   return mailTestState.profiles;
  }finally{mailTestState.loadingProfiles=false;}
 }
 function renderAutoTestProgress(){
  const total=Math.max(0,mailTestState.total),done=mailTestState.done,pass=mailTestState.passed,fail=mailTestState.failed,unknown=mailTestState.unconfirmed;
  const node=(id,text)=>{const el=mailUIElement(id);if(el)el.textContent=String(text);};
  node('randomTestProgress',done+'/'+total);
  node('randomTestPassed',pass);
  node('randomTestFailed',fail);
  node('randomTestUnconfirmed',unknown);
  const denominator=Math.max(1,total);
  const green=mailUIElement('randomTestGreenBar'),red=mailUIElement('randomTestRedBar'),amber=mailUIElement('randomTestAmberBar');
  if(green)green.style.width=(100*pass/denominator).toFixed(2)+'%';
  if(red)red.style.width=(100*fail/denominator).toFixed(2)+'%';
  if(amber)amber.style.width=(100*unknown/denominator).toFixed(2)+'%';
  const recent=mailUIElement('randomTestRecent');
  if(recent){
   recent.replaceChildren();
   for(const item of mailTestState.recent.slice(-8).reverse()){
    const p=document.createElement('p');p.style.color=item.status==='delivered'?'#40db99':item.status==='unconfirmed'?'#ffc36f':'#ff858a';
    p.style.margin='2px 0';p.textContent=item.alias+' — '+(item.status==='delivered'?'PASSED':item.status==='unconfirmed'?'NOT CONFIRMED':'FAILED');
    recent.appendChild(p);
   }
  }
 }
 function scheduleAutoTestProgress(){
  if(mailProgressTimer)return;
  mailProgressTimer=setTimeout(()=>{mailProgressTimer=null;renderAutoTestProgress();},450);
 }
 function trackTestResult(alias,status){
  if(!mailTestState.active)return;
  const key=String(alias||'').toLowerCase();
  if(!mailTestState.statuses.has(key))return;
  const previous=mailTestState.statuses.get(key);
  const finished=new Set(['delivered','unconfirmed','send_failed']);
  if(previous===status)return;
  if(finished.has(previous)){
   if(previous==='delivered')mailTestState.passed=Math.max(0,mailTestState.passed-1);
   else if(previous==='unconfirmed')mailTestState.unconfirmed=Math.max(0,mailTestState.unconfirmed-1);
   else mailTestState.failed=Math.max(0,mailTestState.failed-1);
   mailTestState.done=Math.max(0,mailTestState.done-1);
  }
  mailTestState.statuses.set(key,status);
  if(finished.has(status)){
   mailTestState.done++;
   if(status==='delivered')mailTestState.passed++;
   else if(status==='unconfirmed')mailTestState.unconfirmed++;
   else mailTestState.failed++;
   mailTestState.recent.push({alias:key,status});
   if(mailTestState.recent.length>30)mailTestState.recent.shift();
  }
  scheduleAutoTestProgress();
 }
 function handleMailTestProgress(message){
  if(!message||message.runId!==mailTestState.runId)return;
  trackTestResult(message.alias,message.status);
 }
 function createTestRunId(){
  const bytes=crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
 }
 function clearTestSecretFields(){
  mailUIElement('randomTestPassword').value='';
  mailUIElement('randomTestSenderPassword').value='';
 }
 async function saveMailPairFromForm(){
  requireOwner();
  const settings={
   mailbox:mailUIElement('randomTestReceiver').value.trim().toLowerCase(),
   sender:mailUIElement('randomTestSender').value.trim().toLowerCase(),
   password:mailUIElement('randomTestPassword').value,
   senderPassword:mailUIElement('randomTestSenderPassword').value,
   smtpHost:mailUIElement('randomTestSmtp').value.trim().toLowerCase(),
   imapHost:mailUIElement('randomTestImap').value.trim().toLowerCase(),
   senderImapHost:mailUIElement('randomTestSenderImap').value.trim().toLowerCase()
  };
  if(!validEmail(settings.mailbox)||!validEmail(settings.sender))
   throw Error('Enter the forwarding recipient and a different sending address.');
  const existingReceiver=mailProfilesFor(settings.mailbox).length>0;
  if(!settings.senderPassword||(!settings.password&&!existingReceiver))
   throw Error('Enter the sender app password. For a new receiver also enter its IMAP app password; an already-saved receiver can be reused securely.');
  settings.reuseReceiverCredentials=!settings.password&&existingReceiver;
  const result=await api().saveMailTestCredentials(settings);
  clearTestSecretFields();
  const status=mailUIElement('randomMailCredentialsStatus');
  status.dataset.error='0';status.textContent='Verified sender SMTP/IMAP and receiver IMAP. Saved securely in this Mac Keychain; existing receiver credentials were reused when available.';
  await loadSavedMailPairs(true);
  const preset=mailUIElement('randomMailPreset');preset.value=mailPairKey(result.profile);
  applyMailPairToForm(result.profile);
  // Newly generated batches waiting for this recipient resume automatically.
  const matching=emailBatchGroups().find(g=>g.key==='batch:'+mailTestState.autoPendingBatch&&g.rows.some(r=>r.target===settings.mailbox));
  if(matching&&!mailTestState.active){
   mailTestState.autoPendingBatch=null;
   setTimeout(()=>void runAutomaticEmailTests({batchId:matching.key.slice(6),automatic:true}),100);
  }
  return result;
 }
 function testRowsForSelection({batchId=null,batchKeys=null,all=false}={}){
  if(all)return records.filter(r=>r.randomGenerated===true);
  const groups=emailBatchGroups();
  if(Array.isArray(batchKeys)){
   const chosen=new Set(batchKeys);
   if(!chosen.size)return [];
   return groups.filter(g=>chosen.has(g.key)).flatMap(g=>g.rows);
  }
  const group=batchId?groups.find(g=>g.key==='batch:'+batchId):emailBatchCurrentGroup();
  return group?group.rows:[];
 }
 function collectTestCandidates({batchId=null,batchKeys=null,all=false}={}){
  return testRowsForSelection({batchId,batchKeys,all}).filter(r=>
   typeof r.alias==='string'&&validEmail(r.target)&&
   (!r.forwardingTestedAt||r.forwardingTestTarget!==r.target)&&
   (catchallForMailbox(r.target)||r.status==='live'));
 }
 async function runAutomaticEmailTests({batchId=null,batchKeys=null,all=false,automatic=false}={}){
  if(mailTestState.active||mailTestState.starting||randomGenBusy){
   if(automatic&&batchId)mailTestState.autoPendingBatch=batchId;
   else if(!automatic)mailUIElement('randomTestStatus').textContent='A test or email generation is already running. Stop or finish it before starting another batch.';
   return;
  }
  mailTestState.total=0;mailTestState.done=0;mailTestState.passed=0;mailTestState.failed=0;mailTestState.unconfirmed=0;
  mailTestState.recent=[];mailTestState.paused=false;
  renderAutoTestProgress();
  mailTestState.starting=true;
  let profileBuckets=new Map(),missing=new Set(),total=0,skippedRouting=0,skippedAlreadyVerified=0;
  try{
   requireOwner();
   if(!unlocked)return;
   await loadSavedMailPairs(true);
   const selectedRows=testRowsForSelection({batchId,batchKeys,all});
   const unverifiedAll=selectedRows.filter(r=>r.randomGenerated===true&&
    (!r.forwardingTestedAt||r.forwardingTestTarget!==r.target));
   const candidates=collectTestCandidates({batchId,batchKeys,all});
   skippedRouting=unverifiedAll.filter(r=>validEmail(r.target)&&!catchallForMailbox(r.target)&&r.status!=='live').length;
   skippedAlreadyVerified=selectedRows.filter(r=>r.randomGenerated===true&&r.forwardingTestedAt&&r.forwardingTestTarget===r.target).length;
   for(const row of candidates){
    const permitted=availableSenderProfiles(row.target);
    if(!permitted.length){missing.add(row.target);continue;}
    if(!profileBuckets.has(row.target))profileBuckets.set(row.target,{mailbox:row.target,profiles:permitted,rows:[]});
    profileBuckets.get(row.target).rows.push(row);
   }
   total=[...profileBuckets.values()].reduce((sum,bucket)=>sum+bucket.rows.length,0);
   if(!total){
    const status=mailUIElement('randomTestStatus');
    if(unverifiedAll.length){
     const targets=[...new Set(unverifiedAll.map(r=>r.target))];
     status.textContent='NO EMAILS TESTED. '+unverifiedAll.length+' unverified email(s), '+skippedRouting+
      ' draft(s) excluded because catch-all testing is not enabled for their forwarding receiver. '+
      'Choose checked batches, choose saved sending accounts for each actual receiver, and verify Cloudflare routing (catch-all covers its configured single receiver only). Inbox(es): '+targets.join(', ')+'.';
     mailUIElement('randomTestSettings').open=true;
     if(batchId)mailTestState.autoPendingBatch=batchId;
    }else status.textContent='No emails tested. All saved addresses in this selection are already delivery verified.';
    return;
   }
  }catch(error){
   const status=mailUIElement('randomTestStatus');
   if(status)status.textContent='Could not start automatic tests: '+String(error?.message||error);
   return;
  }finally{mailTestState.starting=false;}
  mailTestState.active=true;randomGenBusy=true;mailTestState.cancel=false;
  // Signal that data mutations are paused during a test run rather than silently ignoring clicks.
  for(const id of ['randomAliasCreate','randomAliasTestAll','randomAliasTestBatch','randomAliasTestMulti','randomReceiverSplitPreview','randomReceiverSplitCommit','emailBatchDeleteReview','emailBatchRemoveOneReview']){
   const button=mailUIElement(id);if(button)button.disabled=true;
  }
  mailTestState.statuses=new Map();
  mailTestState.runId=createTestRunId();mailTestState.recent=[];
  mailTestState.total=total;mailTestState.done=0;mailTestState.passed=0;mailTestState.failed=0;mailTestState.unconfirmed=0;
  mailTestState.paused=false;mailTestState.cleanupPending=0;
  for(const bucket of profileBuckets.values())for(const row of bucket.rows)mailTestState.statuses.set(String(row.alias).toLowerCase(),'pending');
  const status=mailUIElement('randomTestStatus'),stop=mailUIElement('randomAliasTestStop');
  stop.hidden=false;status.textContent='Testing '+total+' eligible addresses automatically. '+skippedRouting+
   ' draft(s) skipped because catch-all testing is not enabled; '+missing.size+' forwarding inbox(es) lack selected sender/receiver pairs. '+
   'Confirmed receipts are green; SMTP errors red; missing Inbox receipts amber. A preflight checks routing before bulk testing.';
  renderAutoTestProgress();
  const stopTest=()=>mailTestState.cancel=true;
  let pendingPersist=0;
  const routingWarnings=new Set();
  const receiptScanSummary=new Map();
  try{
   const unavailableSenders=new Set();
   let senderGroupCount=0;
   for(const bucket of profileBuckets.values()){
    if(mailTestState.cancel||mailTestState.paused)break;
    const rows=bucket.rows,mailbox=bucket.mailbox;
    let senderCursor=0;
    for(let start=0;start<rows.length;){
     if(mailTestState.cancel||mailTestState.paused)break;
     const preflight=start===0&&catchallForMailbox(mailbox);
     const set=rows.slice(start,start+(preflight?AUTO_TEST_PREFLIGHT_SIZE:AUTO_TEST_GROUP_SIZE));
     start+=set.length;
     let pendingSet=set.slice();
     while(pendingSet.length&&!mailTestState.cancel&&!mailTestState.paused){
      const options=bucket.profiles.filter(p=>!unavailableSenders.has(p.sender));
      if(!options.length){
       mailTestState.paused=true;
       status.textContent='All selected sending accounts for '+mailbox+' are unavailable or have reached provider limits. '+
        (total-mailTestState.done)+' addresses remain unverified. No further messages were sent.';
       break;
      }
      const profile=options[senderCursor%options.length];senderCursor++;senderGroupCount++;
      status.textContent='Checking '+mailbox+' with sender '+profile.sender+' (group '+senderGroupCount+') — '+
       mailTestState.done+'/'+total+' completed.';
      const response=await api().testForwarding({
       mailbox:profile.mailbox,sender:profile.sender,runId:mailTestState.runId,aliases:pendingSet.map(r=>r.alias)
      });
      if(response.receiptDiagnostics){
       const diag=response.receiptDiagnostics;
       const prior=receiptScanSummary.get(mailbox)||{folders:new Set(),matched:0,outside:0,folderErrors:0};
       for(const folder of Array.isArray(diag.folders)?diag.folders:[])prior.folders.add(String(folder));
       prior.matched+=Number(diag.exactMatches||0);
       prior.outside+=Number(diag.discoveredOutsideInbox||0);
       if(diag.folderError)prior.folderErrors++;
       receiptScanSummary.set(mailbox,prior);
       if(Number(response.sentButUnconfirmed||0)>0&&Number(response.delivered||0)===0)
        status.textContent='Sent tests were NOT CONFIRMED by exact ID in '+(diag.folders||['INBOX']).join(', ')+
         '. A message visible in Gmail may be in another folder, have a changed subject, or be delayed. Continuing the queue.';
      }
      const current=new Map(pendingSet.map(row=>[row.alias,row]));
      const seen=new Set(),retries=[];
      for(const item of response.results||[]){
       const row=current.get(String(item.alias||'').toLowerCase());
       if(!row||seen.has(row.alias))continue;
       seen.add(row.alias);
       if((item.status==='not_attempted'||item.status==='send_failed')&&response.rateLimited){
        trackTestResult(row.alias,'pending');retries.push(row);continue;
       }
       if(item.status==='delivered'){
        const now=new Date().toISOString();
        row.forwardingTestedAt=now;row.forwardingTestTarget=mailbox;
        if(catchallForMailbox(mailbox)&&row.status!=='live'){
         row.status='live';row.catchAllVerifiedAt=now;
        }
       }
       trackTestResult(row.alias,item.status==='not_attempted'?'pending':item.status);
      }
      for(const row of pendingSet)if(!seen.has(row.alias)){
       if(response.rateLimited){trackTestResult(row.alias,'pending');retries.push(row);}
       else trackTestResult(row.alias,'unconfirmed');
      }
      mailTestState.cleanupPending+=Number(response.cleanupPending||0);
      // Encrypting the entire vault and rebuilding the batch list after each
      // 25 messages caused multi-second UI stalls on 400+ alias test runs.
      // Keep the separate progress area live and persist in bounded groups.
      pendingPersist+=set.length;
      if(pendingPersist>=AUTO_TEST_SAVE_EVERY||response.rateLimited){
       if(!await store())throw Error('The encrypted Email Bank did not save test results. Stop and check your bank before retrying.');
       pendingPersist=0;
      }
      if(response.rateLimited){
       unavailableSenders.add(profile.sender);
       pendingSet=retries;
       if(!bucket.profiles.some(p=>!unavailableSenders.has(p.sender))){
        mailTestState.paused=true;
        status.textContent='Sender '+profile.sender+' hit a provider sending limit. No other selected sender for '+mailbox+
         ' is available. Unsent aliases remain unverified, and all provider quotas are respected.';
       }
      }else pendingSet=[];
      if(preflight&&!response.rateLimited&&!set.some(r=>mailTestState.statuses.get(r.alias.toLowerCase())==='delivered')){
       // Test All must not stop at 3 unconfirmed aliases. A missing receipt is
       // not a provider quota or a connection error, so keep testing the
       // remaining emails (including other receivers) at the normal rate.
       routingWarnings.add(mailbox);
       status.textContent='WARNING: no confirmed receipt for the first 3 emails to '+mailbox+
        '. Continuing the selected queue as requested. Check Cloudflare routing and Spam/All Mail. '+mailTestState.done+'/'+total+' tested.';
      }
      if(!mailTestState.paused&&!mailTestState.cancel)await new Promise(resolve=>setTimeout(resolve,800));
     }
    }
   }
   if(pendingPersist){
    if(!await store())throw Error('Could not persist the final email test results. Verify the encrypted Email Bank before retrying.');
    pendingPersist=0;
   }
   const pending=total-mailTestState.done;
   if(!mailTestState.paused){
    status.textContent=(mailTestState.cancel?'Stopped after current group. ':'Finished automated testing. ')+
      mailTestState.done+'/'+total+' completed, '+mailTestState.passed+' passed, '+mailTestState.failed+' send failed, '+mailTestState.unconfirmed+' not confirmed, '+pending+' not checked.'+
      ' Skipped '+skippedRouting+' draft(s) without catch-all testing enabled, '+skippedAlreadyVerified+' already verified.'+
      (routingWarnings.size?' WARNING: the initial 3 emails to '+[...routingWarnings].join(', ')+' had no confirmed receipts; the full queue was still processed.':'')+
      (mailTestState.cleanupPending?' '+mailTestState.cleanupPending+' confirmed test message(s) could not be moved to Trash; review cleanup permissions.':' Confirmed test messages are moved to Trash.');
   }
   if(missing.size)status.textContent+=' No saved mail account for '+[...missing].join(', ')+'.';
   if(receiptScanSummary.size){
    status.textContent+=' IMAP exact-ID scans: '+[...receiptScanSummary].map(([box,d])=>
     box+' ['+[...d.folders].join(', ')+'], '+d.matched+' confirmed'+
     (d.outside?', '+d.outside+' outside INBOX':'')+
     (d.folderErrors?', '+d.folderErrors+' folder scan error(s)':'')).join('; ')+'.';
   }
  }catch(error){
   let saveWarning='';
   if(pendingPersist){
    try{
     if(!await store())saveWarning=' Latest unsaved test results could not be persisted.';
     else pendingPersist=0;
    }catch(saveError){saveWarning=' Latest unsaved test results could not be persisted: '+String(saveError?.message||saveError);}
   }
   status.textContent='Automatic testing stopped due to an actual error: '+String(error?.message||error)+
    '. Already saved confirmations remain intact; retry remaining unverified addresses.'+saveWarning;
  }finally{
   mailTestState.active=false;randomGenBusy=false;stop.hidden=true;
   for(const id of ['randomAliasCreate','randomAliasTestAll','randomAliasTestBatch','randomAliasTestMulti','randomReceiverSplitPreview','randomReceiverSplitCommit','emailBatchDeleteReview','emailBatchRemoveOneReview']){
    const button=mailUIElement(id);if(button)button.disabled=false;
   }
   renderAutoTestProgress();
   refreshEmailBatchUI();
  }
 }
 function scheduleNewBatchAutoTest(batchId){
  if(!batchId)return;
  mailTestState.autoPendingBatch=batchId;
  setTimeout(()=>{
   if(mailTestState.active||randomGenBusy)return;
   const pending=mailTestState.autoPendingBatch;
   mailTestState.autoPendingBatch=null;
   if(pending)void runAutomaticEmailTests({batchId:pending,automatic:true});
  },120);
 }

 let receiverSplitPlan=null;
 function cancelReceiverSplitPlan(){
  receiverSplitPlan=null;
  const panel=mailUIElement('randomReceiverSplitConfirmArea');if(panel)panel.hidden=true;
  const ack=mailUIElement('randomReceiverSplitAck');if(ack)ack.checked=false;
 }
 function receiverSplitEligible(row){
  return row&&row.randomGenerated===true&&row.status==='draft'&&!row.remoteId&&
   !row.poolTarget&&!row.poolImportedAt&&!row.forwardingTestedAt&&!row.catchAllVerifiedAt;
 }
 function previewReceiverSplit(){
  requireOwner();
  if(!unlocked||randomGenBusy||mailTestState.active)throw Error('Unlock the bank and finish any active test first.');
  cancelReceiverSplitPlan();
  const batchKeys=[...mailTestState.selectedBatchKeys];
  if(!batchKeys.length)throw Error('Choose the batches to split using the checkboxes above.');
  const receivers=[...mailTestState.selectedReceiverTargets].sort();
  if(receivers.length<2)throw Error('Select at least two saved receiver inboxes.');
  const valid=new Set(mailTestState.profiles.map(p=>p.mailbox));
  if(receivers.some(x=>!valid.has(x)))throw Error('A receiver is no longer saved and IMAP verified. Refresh accounts.');
  const chosen=testRowsForSelection({batchKeys});
  const rows=chosen.filter(receiverSplitEligible).sort((a,b)=>String(a.alias).localeCompare(String(b.alias)));
  if(!rows.length)throw Error('No unpublished, unassigned drafts in the checked batches. Live, verified and imported emails were left unchanged.');
  if(rows.length>200)throw Error('This plan contains '+rows.length+' aliases; Cloudflare allows only 200 individual routing rules per domain (including existing rules). Use an Email Worker or smaller eligible selection before splitting.');
  if(new Set(rows.map(r=>r.alias)).size!==rows.length)throw Error('Duplicate aliases need review before a split.');
  const changes=rows.map((row,i)=>({row,alias:row.alias,from:row.target,to:receivers[i%receivers.length]}));
  const counts=receivers.map(r=>r+': '+changes.filter(x=>x.to===r).length).join(' · ');
  receiverSplitPlan={batchKeys:batchKeys.slice().sort(),receivers,changes,snapshot:changes.map(x=>({
   alias:x.alias,target:x.row.target,status:x.row.status,remoteId:x.row.remoteId||null,
   poolTarget:x.row.poolTarget||null,poolImportedAt:x.row.poolImportedAt||null,forwardingTestedAt:x.row.forwardingTestedAt||null
  }))};
  mailUIElement('randomReceiverSplitSummary').textContent='PREVIEW: '+changes.length+' unpublished drafts split evenly: '+counts+
   '. Only local forwarding destinations would change. Cloudflare individual rules must be published separately; current 200-rule capacity may be lower if rules already exist. No live routing changes have occurred.';
  mailUIElement('randomReceiverSplitConfirmArea').hidden=false;
 }
 async function commitReceiverSplit(){
  requireOwner();
  if(!unlocked||randomGenBusy||mailTestState.active)throw Error('Finish active testing before saving a split.');
  const plan=receiverSplitPlan;
  if(!plan||!mailUIElement('randomReceiverSplitAck').checked)throw Error('Preview and acknowledge the draft-only split first.');
  if(JSON.stringify([...mailTestState.selectedBatchKeys].sort())!==JSON.stringify(plan.batchKeys)||
     JSON.stringify([...mailTestState.selectedReceiverTargets].sort())!==JSON.stringify(plan.receivers))
   throw Error('Batch or receiver selection changed. Preview again.');
  const current=testRowsForSelection({batchKeys:plan.batchKeys}).filter(receiverSplitEligible).sort((a,b)=>String(a.alias).localeCompare(String(b.alias)));
  if(current.length!==plan.snapshot.length||current.some((row,i)=>row!==plan.changes[i].row||
     row.alias!==plan.snapshot[i].alias||row.target!==plan.snapshot[i].target||
     row.status!==plan.snapshot[i].status||(row.remoteId||null)!==plan.snapshot[i].remoteId||
     (row.poolTarget||null)!==plan.snapshot[i].poolTarget||(row.poolImportedAt||null)!==plan.snapshot[i].poolImportedAt||
     (row.forwardingTestedAt||null)!==plan.snapshot[i].forwardingTestedAt))
   throw Error('Email Bank drafts changed since preview. Review again; nothing updated.');
  const previous=localStorage.getItem(KEY);
  if(!previous)throw Error('Encrypted Email Bank unavailable. No destinations changed.');
  const entropy=crypto.getRandomValues(new Uint8Array(8));
  const backupKey=KEY+'.receiver-split-backup.'+Date.now()+'.'+Array.from(entropy,x=>x.toString(16).padStart(2,'0')).join('');
  if(localStorage.getItem(backupKey)!==null)throw Error('Encrypted backup collision. No destinations changed.');
  localStorage.setItem(backupKey,previous);
  if(localStorage.getItem(backupKey)!==previous)throw Error('Encrypted backup verification failed. No destinations changed.');
  randomGenBusy=true;
  const before=plan.changes.map(x=>({row:x.row,target:x.row.target,forwardingTestedAt:x.row.forwardingTestedAt,
   forwardingTestTarget:x.row.forwardingTestTarget,catchAllVerifiedAt:x.row.catchAllVerifiedAt}));
  try{
   for(const change of plan.changes){
    change.row.target=change.to;change.row.forwardingTestedAt=null;
    change.row.forwardingTestTarget=null;change.row.catchAllVerifiedAt=null;
   }
   if(!await store())throw Error('Encrypted save failed.');
  }catch(error){
   for(const x of before){
    x.row.target=x.target;x.row.forwardingTestedAt=x.forwardingTestedAt;
    x.row.forwardingTestTarget=x.forwardingTestTarget;x.row.catchAllVerifiedAt=x.catchAllVerifiedAt;
   }
   try{if(localStorage.getItem(KEY)!==previous)localStorage.setItem(KEY,previous);}catch{}
   throw Error('Draft receiver split was not saved. Encrypted original backup retained: '+String(error?.message||error));
  }finally{randomGenBusy=false;}
  cancelReceiverSplitPlan();
  mailUIElement('randomReceiverSplitSummary').textContent='Saved draft-only receiver allocation for '+before.length+
   ' emails. Encrypted backup preserved. NO Cloudflare routing changed, and NO email is marked verified. Publish allowed routing rules or configure a Worker, then run tests against the actual receiver.';
  refreshEmailBatchUI();refreshRandomChooser();
 }
 function setupAutoMailTests(){
  const apiMethod=api()?.onEmailTestProgress;
  if(typeof apiMethod==='function')apiMethod(handleMailTestProgress);
  const settings=mailUIElement('randomTestSettings');
  mailUIElement('randomAliasTestAll').addEventListener('click',()=>void runAutomaticEmailTests({all:true}));
  mailUIElement('randomAliasTestMulti').addEventListener('click',()=>{
   const keys=[...mailTestState.selectedBatchKeys];
   if(!keys.length){mailUIElement('randomTestStatus').textContent='Select at least one batch in the multi-batch list.';return;}
   void runAutomaticEmailTests({batchKeys:keys});
  });
  mailUIElement('randomAliasTestBatch').addEventListener('click',()=>{
   const group=emailBatchCurrentGroup();
   if(!group){mailUIElement('randomTestStatus').textContent='Choose a batch to test first.';return;}
   // The picker in the test section and the lower batch-manager picker share emailBatchState.
   // Exact generation batches use an ID; legacy time-grouped batches use the selected group.
   if(group.key.startsWith('batch:'))void runAutomaticEmailTests({batchId:group.key.slice(6)});
   else void runAutomaticEmailTests({all:false});
  });
  const senderList=mailUIElement('randomTestSenderPoolList');
  senderList.addEventListener('change',event=>{
   const check=event.target;if(!check?.matches?.('input[data-test-sender]'))return;
   if(mailTestState.active||mailTestState.starting){check.checked=!check.checked;return;}
   if(check.checked)mailTestState.selectedSenderKeys.add(check.value);
   else mailTestState.selectedSenderKeys.delete(check.value);
   renderMailAccountPools();
  });
  mailUIElement('randomTestAllSenders').addEventListener('click',()=>{
   if(mailTestState.active||mailTestState.starting)return;
   mailTestState.selectedSenderKeys=new Set(mailTestState.profiles.map(mailPairKey));renderMailAccountPools();
  });
  mailUIElement('randomTestClearSenders').addEventListener('click',()=>{
   if(mailTestState.active||mailTestState.starting)return;
   mailTestState.selectedSenderKeys.clear();renderMailAccountPools();
  });
  mailUIElement('randomTestReceiverPoolList').addEventListener('change',event=>{
   const check=event.target;if(!check?.matches?.('input[data-split-receiver]'))return;
   if(mailTestState.active||mailTestState.starting){check.checked=!check.checked;return;}
   if(check.checked)mailTestState.selectedReceiverTargets.add(check.value);
   else mailTestState.selectedReceiverTargets.delete(check.value);
   cancelReceiverSplitPlan();renderMailAccountPools();
  });
  mailUIElement('randomReceiverSplitPreview').addEventListener('click',()=>{
   try{previewReceiverSplit();}catch(error){cancelReceiverSplitPlan();mailUIElement('randomReceiverSplitSummary').textContent=String(error?.message||error);}
  });
  mailUIElement('randomReceiverSplitCommit').addEventListener('click',async()=>{
   const button=mailUIElement('randomReceiverSplitCommit');button.disabled=true;
   try{await commitReceiverSplit();}catch(error){cancelReceiverSplitPlan();mailUIElement('randomReceiverSplitSummary').textContent=String(error?.message||error);}
   finally{button.disabled=false;}
  });
  mailUIElement('randomReceiverSplitCancel').addEventListener('click',()=>{
   cancelReceiverSplitPlan();mailUIElement('randomReceiverSplitSummary').textContent='Cancelled. No destinations changed.';
  });
  mailUIElement('randomAliasTestStop').addEventListener('click',()=>{
   mailTestState.cancel=true;
   mailUIElement('randomTestStatus').textContent='Stop requested. The current group of 25 finishes safely before testing stops.';
  });
  mailUIElement('randomMailPreset').addEventListener('change',()=>{
   const key=mailUIElement('randomMailPreset').value;
   const profile=mailTestState.profiles.find(p=>mailPairKey(p)===key);
   if(profile)applyMailPairToForm(profile);
   else{clearTestSecretFields();mailUIElement('randomTestSender').value='';}
  });
  mailUIElement('randomTestReceiver').addEventListener('change',()=>{
   const receiver=mailUIElement('randomTestReceiver').value.trim().toLowerCase();
   mailUIElement('randomAliasCatchAllTest').checked=catchallForMailbox(receiver);
  });
  mailUIElement('randomAliasCatchAllTest').addEventListener('change',()=>{
   setCatchallForMailbox(mailUIElement('randomTestReceiver').value,mailUIElement('randomAliasCatchAllTest').checked);
   mailUIElement('randomMailCredentialsStatus').textContent='Catch-all test mode saved for this receiver. ACO Studio will not modify Cloudflare settings.';
  });
  mailUIElement('randomMailCredentialsSave').addEventListener('click',async()=>{
   const b=mailUIElement('randomMailCredentialsSave');b.disabled=true;
   try{await saveMailPairFromForm();}
   catch(error){
    const status=mailUIElement('randomMailCredentialsStatus');
    status.dataset.error='1';
    status.textContent='Could not verify/save accounts: '+String(error?.message||error);
   }finally{b.disabled=false;}
  });
  mailUIElement('randomMailCredentialsForget').addEventListener('click',async()=>{
   const key=mailUIElement('randomMailPreset').value;
   const profile=mailTestState.profiles.find(p=>mailPairKey(p)===key);
   if(!profile){mailUIElement('randomMailCredentialsStatus').textContent='Choose an exact saved account pair first.';return;}
   if(!confirm('Remove the saved app passwords for '+profile.sender+' → '+profile.mailbox+' from this Mac? Other saved pairs remain.'))return;
   try{await api().forgetMailTestCredentials({mailbox:profile.mailbox,sender:profile.sender});
    mailUIElement('randomMailPreset').value='';
    await loadSavedMailPairs(true);
    mailUIElement('randomMailCredentialsStatus').textContent='Selected saved pair removed. Other sending/receiving account pairs remain unchanged.';
   }catch(error){mailUIElement('randomMailCredentialsStatus').textContent=String(error?.message||error);}
  });
  renderAutoTestProgress();
  if(settings&&!mailTestState.profiles.length){
   const primary=mailUIElement('emailTarget')?.value?.trim().toLowerCase()||'';
   if(primary)mailUIElement('randomTestReceiver').value=primary;
  }
  setTimeout(()=>void loadSavedMailPairs(true),400);
 }
