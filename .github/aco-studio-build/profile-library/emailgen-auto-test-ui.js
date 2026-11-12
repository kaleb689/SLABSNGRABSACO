
 // Owner-only automatic verification UI, batched so thousands of generated
 // emails never cause a synchronous renderer repaint for every test result.
 const MAIL_TEST_CATCHALL_PREF='aco.emailgen.catchall.preferences.v1';
 const AUTO_TEST_GROUP_SIZE=25;
 const AUTO_TEST_PREFLIGHT_SIZE=3;
 const mailTestState={active:false,starting:false,cancel:false,profiles:[],profileCheckedAt:0,
  loadingProfiles:false,runId:'',statuses:new Map(),recent:[],total:0,done:0,passed:0,failed:0,unconfirmed:0,
  paused:false,lastRunAt:0,runTarget:'',autoPendingBatch:null,cleanupPending:0};
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
  mailProgressTimer=setTimeout(()=>{mailProgressTimer=null;renderAutoTestProgress();},180);
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
  if(!settings.password||!settings.senderPassword)
   throw Error('Enter both app passwords to verify and securely save this sender/receiver pair.');
  const result=await api().saveMailTestCredentials(settings);
  clearTestSecretFields();
  const status=mailUIElement('randomMailCredentialsStatus');
  status.dataset.error='0';status.textContent='Verified SMTP and both IMAP logins. Sender and receiver app passwords are saved encrypted on this Mac.';
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
 function collectTestCandidates({batchId=null,all=false}={}){
  const rows=records.filter(r=>r.randomGenerated===true);
  const group=batchId?emailBatchGroups().find(g=>g.key==='batch:'+batchId):
   !all?emailBatchCurrentGroup():null;
  if(batchId&&!group)return [];
  const possible=group?group.rows:rows;
  return possible.filter(r=>typeof r.alias==='string'&&validEmail(r.target)&&
    (!r.forwardingTestedAt||r.forwardingTestTarget!==r.target)&&
    (catchallForMailbox(r.target)||r.status==='live'));
 }
 async function runAutomaticEmailTests({batchId=null,all=false,automatic=false}={}){
  if(mailTestState.active||mailTestState.starting||randomGenBusy){
   if(automatic&&batchId)mailTestState.autoPendingBatch=batchId;
   return;
  }
  mailTestState.starting=true;
  let profileBuckets=new Map(),missing=new Set(),total=0;
  try{
   requireOwner();
   if(!unlocked)return;
   await loadSavedMailPairs(true);
   const batch=batchId?emailBatchGroups().find(g=>g.key==='batch:'+batchId):!all?emailBatchCurrentGroup():null;
   const unverifiedAll=(batch?batch.rows:records).filter(r=>r.randomGenerated===true&&
    (!r.forwardingTestedAt||r.forwardingTestTarget!==r.target));
   const candidates=collectTestCandidates({batchId,all});
   for(const row of candidates){
    const selected=findSavedMailPair(row.target);
    if(!selected){missing.add(row.target);continue;}
    const key=mailPairKey(selected);
    if(!profileBuckets.has(key))profileBuckets.set(key,{profile:selected,rows:[]});
    profileBuckets.get(key).rows.push(row);
   }
   total=[...profileBuckets.values()].reduce((sum,group)=>sum+group.rows.length,0);
   if(!total){
    const status=mailUIElement('randomTestStatus');
    if(unverifiedAll.length){
     const targets=[...new Set(unverifiedAll.map(r=>r.target))];
     status.textContent='Automatic test pending for '+unverifiedAll.length+' emails. Save a matching sender and receiver app-password pair and confirm catch-all forwarding for draft addresses. Inbox(es): '+targets.join(', ')+'.';
     mailUIElement('randomTestSettings').open=true;
     if(batchId)mailTestState.autoPendingBatch=batchId;
    }else status.textContent='All eligible saved addresses are already delivery verified.';
    return;
   }
  }catch(error){
   const status=mailUIElement('randomTestStatus');
   if(status)status.textContent='Could not start automatic tests: '+String(error?.message||error);
   return;
  }finally{mailTestState.starting=false;}
  mailTestState.active=true;randomGenBusy=true;mailTestState.cancel=false;
  // Signal that data mutations are paused during a test run rather than silently ignoring clicks.
  for(const id of ['randomAliasCreate','randomAliasTestAll','randomAliasTestBatch','emailBatchDeleteReview']){
   const button=mailUIElement(id);if(button)button.disabled=true;
  }
  mailTestState.statuses=new Map();
  mailTestState.runId=createTestRunId();mailTestState.recent=[];
  mailTestState.total=total;mailTestState.done=0;mailTestState.passed=0;mailTestState.failed=0;mailTestState.unconfirmed=0;
  mailTestState.paused=false;mailTestState.cleanupPending=0;
  for(const bucket of profileBuckets.values())for(const row of bucket.rows)mailTestState.statuses.set(String(row.alias).toLowerCase(),'pending');
  const status=mailUIElement('randomTestStatus'),stop=mailUIElement('randomAliasTestStop');
  stop.hidden=false;status.textContent='Testing '+total+' addresses automatically. Confirmed receipts are green; SMTP send errors are red; messages not found in Inbox are amber. A short preflight checks routing before bulk testing.';
  renderAutoTestProgress();
  const stopTest=()=>mailTestState.cancel=true;
  try{
   for(const bucket of profileBuckets.values()){
    if(mailTestState.cancel||mailTestState.paused)break;
    const profile=bucket.profile,rows=bucket.rows;
    for(let start=0;start<rows.length;){
     if(mailTestState.cancel||mailTestState.paused)break;
     const preflight=start===0&&catchallForMailbox(profile.mailbox);
     const set=rows.slice(start,start+(preflight?AUTO_TEST_PREFLIGHT_SIZE:AUTO_TEST_GROUP_SIZE));
     start+=set.length;
     status.textContent='Checking '+profile.mailbox+' using sender '+profile.sender+' — '+mailTestState.done+'/'+total+' completed. Tests move into Trash after confirmed receipt.';
     const response=await api().testForwarding({
      mailbox:profile.mailbox,sender:profile.sender,runId:mailTestState.runId,aliases:set.map(r=>r.alias)
     });
     const unique=new Set();
     for(const item of response.results||[]){
      const row=set.find(r=>r.alias===item.alias);
      if(!row||unique.has(row.alias))continue;
      unique.add(row.alias);
      if(item.status==='delivered'){
       const now=new Date().toISOString();
       row.forwardingTestedAt=now;row.forwardingTestTarget=profile.mailbox;
       if(catchallForMailbox(profile.mailbox)&&row.status!=='live'){
        row.status='live';row.catchAllVerifiedAt=now;
       }
      }
      trackTestResult(item.alias,item.status);
     }
     for(const row of set)if(!unique.has(row.alias))trackTestResult(row.alias,'unconfirmed');
     mailTestState.cleanupPending+=Number(response.cleanupPending||0);
     if(!await store())throw Error('The encrypted Email Bank did not save test results. Stop and check your bank before retrying.');
     // Persist after each 25; do not rebuild the 10,000-row bank table on each result.
     refreshEmailBatchUI();
     if(preflight&&Number(response.delivered||0)===0&&Number(response.sentButUnconfirmed||0)>0){
      mailTestState.paused=true;
      status.textContent='Paused after '+set.length+' preflight messages: NONE reached '+profile.mailbox+' Inbox. '+
       'Check Cloudflare catch-all is Active, with Send to an email and destination '+profile.mailbox+'. '+
       'Check Gmail Spam/All Mail too: the verifier currently searches Inbox only. The remaining addresses were not tested.';
      break;
     }
     if(response.rateLimited){
      mailTestState.paused=true;
      status.textContent='Email provider limit reached. Paused after '+mailTestState.done+'/'+total+' results; remaining addresses stay unverified. Try again when the provider allows more messages.';
      break;
     }
     // Allow the browser to paint/accept input and avoid sending tight SMTP bursts.
     await new Promise(resolve=>setTimeout(resolve,800));
    }
   }
   const pending=total-mailTestState.done;
   if(!mailTestState.paused){
    status.textContent=(mailTestState.cancel?'Stopped after current group. ':'Finished automated testing. ')+
      mailTestState.done+'/'+total+' completed, '+mailTestState.passed+' passed, '+mailTestState.failed+' send failed, '+mailTestState.unconfirmed+' not confirmed, '+pending+' not checked.'+
      (mailTestState.cleanupPending?' '+mailTestState.cleanupPending+' confirmed test message(s) could not be moved to Trash; review cleanup permissions.':' Confirmed test messages are moved to Trash.');
   }
   if(missing.size)status.textContent+=' No saved mail account for '+[...missing].join(', ')+'.';
  }catch(error){
   status.textContent='Automatic testing stopped: '+String(error?.message||error)+'. Verified records already saved remain intact. Other addresses remain unverified.';
  }finally{
   mailTestState.active=false;randomGenBusy=false;stop.hidden=true;
   for(const id of ['randomAliasCreate','randomAliasTestAll','randomAliasTestBatch','emailBatchDeleteReview']){
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
 function setupAutoMailTests(){
  const apiMethod=api()?.onEmailTestProgress;
  if(typeof apiMethod==='function')apiMethod(handleMailTestProgress);
  const settings=mailUIElement('randomTestSettings');
  mailUIElement('randomAliasTestAll').addEventListener('click',()=>void runAutomaticEmailTests({all:true}));
  mailUIElement('randomAliasTestBatch').addEventListener('click',()=>{
   const group=emailBatchCurrentGroup();
   if(!group)return;
   // Legacy time-based batches are addressed by the current selection.
   void runAutomaticEmailTests({all:false});
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
