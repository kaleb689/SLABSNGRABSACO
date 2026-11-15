'use strict';
// SMTP -> alias -> destination IMAP tests. Only exact, nonce-marked ACO test
// messages are moved to Trash after receipt. Never touch other customer mail.
const crypto=require('node:crypto');
const {makeMailTestStore,normalizeConfig}=require('./emailgen-mail-test-store');
const VALID_ALIAS=/^[a-z0-9][a-z0-9._-]{0,63}@sng\.sarl$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST=/^[a-z0-9](?:[a-z0-9.-]{1,248})[a-z0-9]$/i;
const PREFIX='ACO Studio forwarding test ';
const IMAP_RECEIPT_WAIT_MS=15000;
const IMAP_POLL_MS=3000;
const MAX_RECEIPT_CANDIDATES=250;
function fallbackBoxes(boxes){
 const available=(Array.isArray(boxes)?boxes:[]).filter(b=>typeof b?.path==='string'&&b.path);
 const all=available.find(b=>String(b.specialUse||'').toLowerCase().endsWith('all'))||
  available.find(b=>String(b.path).toLowerCase().endsWith('all mail'));
 const spam=available.find(b=>String(b.specialUse||'').toLowerCase().endsWith('junk'))||
  available.find(b=>String(b.path).toLowerCase().endsWith('spam'));
 return [...new Set([all?.path,spam?.path].filter(path=>path&&path.toUpperCase()!=='INBOX'))];
}
// A reliable receipt must contain the exact 96-bit marker. Never infer
// delivery merely because SMTP accepted a send, or a message arrived.
const RECEIPT_SCAN_LOOKBACK_MS=5*60*1000;
const MAX_RECEIPT_SCAN_IDS=160;
const MAX_RECEIPT_SOURCE_BYTES=65536;
const BOUNCE_SUBJECT=/(?:delivery (?:failure|status|notification)|undeliverable|mail delivery (?:failed|subsystem)|message (?:rejected|not delivered))/i;
const BOUNCE_SENDER=/(?:mailer-daemon|postmaster|bounce|delivery-status)/i;
function isDeliveryFailure(message,parsed){
 const subject=String(message.envelope?.subject||parsed?.subject||'');
 const from=(message.envelope?.from||[]).map(p=>p.address||'').join(' ');
 return BOUNCE_SUBJECT.test(subject)||BOUNCE_SENDER.test(from);
}
function matchExactMarker(subject,raw,expected,parsed){
 const normalized=String(subject||'').trim().replace(/^(?:(?:re|fw|fwd):\s*)+/i,'');
 const direct=expected.get(normalized);
 if(direct)return {item:direct,method:'subject'};
 const source=Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw||'');
 for(const item of expected.values()){
  if(source.includes(item.marker))return {item,method:'source'};
 }
 if(parsed){
  const content=[parsed.subject,parsed.text,parsed.html,
   parsed.headers?.get?.('x-aco-test-id'),parsed.headers?.get?.('x-aco-forwarding-test')].filter(Boolean).join('\n');
  for(const item of expected.values())if(content.includes(item.marker))
   return {item,method:'decoded-body'};
 }
 return null;
}
async function scanCurrentMailboxForExactMarkers(imap,sent,{started,now,onProgress,folder,diagnostics,parseSource}){
 // SEARCH SUBJECT previously returned zero for delivered aliases whose
 // forwarded subject had been rewritten. Search recent UIDs instead, then
 // verify an exact nonce locally. UID/sampling limits bound IMAP work.
 const ids=await imap.search({since:new Date(started-RECEIPT_SCAN_LOOKBACK_MS)},{uid:true});
 const recent=Array.isArray(ids)?ids.slice(-MAX_RECEIPT_SCAN_IDS):[];
 diagnostics.scans++;diagnostics.candidates+=recent.length;
 if(!diagnostics.checkedUids)diagnostics.checkedUids=new Map();
 const checked=diagnostics.checkedUids.get(folder)||new Set();
 diagnostics.checkedUids.set(folder,checked);
 const unexamined=recent.filter(uid=>!checked.has(uid));
 const expected=new Map(sent.filter(x=>!x.received).map(item=>[item.marker,item]));
 if(!unexamined.length||!expected.size)return;
 const query={envelope:true,internalDate:true,source:{start:0,maxLength:MAX_RECEIPT_SOURCE_BYTES}};
 for await(const message of imap.fetch(unexamined,query,{uid:true})){
  if(Number.isSafeInteger(message.uid))checked.add(message.uid);
  const stamp=message.internalDate?new Date(message.internalDate).getTime():NaN;
  if(!Number.isFinite(stamp)||stamp<started-RECEIPT_SCAN_LOOKBACK_MS||stamp>now()+60000)continue;
  diagnostics.recentCount=(diagnostics.recentCount||0)+1;
  // Do not treat bounce/error notifications that quote the test ID as proof.
  if(isDeliveryFailure(message))continue;
  const source=Buffer.isBuffer(message.source)?message.source:null;
  let match=matchExactMarker(message.envelope?.subject,source,expected);
  if(!match&&source&&typeof parseSource==='function'){
   try{
    const parsed=await parseSource(source);
    if(!isDeliveryFailure(message,parsed))
     match=matchExactMarker(message.envelope?.subject,source,expected,parsed);
   }catch{diagnostics.parseFailures=(diagnostics.parseFailures||0)+1;}
  }
  if(!match||match.item.received)continue;
  match.item.received=true;match.item.receivedFolder=folder;
  if(Number.isSafeInteger(message.uid))match.item.receivedUid=message.uid;
  expected.delete(match.item.marker);
  diagnostics.exactMatches++;
  diagnostics.matchMethods=diagnostics.matchMethods||{subject:0,source:0,'decoded-body':0};
  diagnostics.matchMethods[match.method]=(diagnostics.matchMethods[match.method]||0)+1;
  try{onProgress({alias:match.item.alias,status:'delivered'});}catch{}
 }
}
function mailboxIdentity(address){
 const [local,domain]=address.split('@');
 return ['gmail.com','googlemail.com'].includes(domain)
  ?local.split('+')[0].replace(/\./g,'')+'@gmail.com':address;
}
function validate(input){
 if(!input||typeof input!=='object')throw Error('Mail test settings are required.');
 const mailbox=String(input.mailbox||'').trim().toLowerCase();
 const pass=String(input.password||'');
 const sender=String(input.sender||'').trim().toLowerCase();
 const senderPass=String(input.senderPassword||'');
 const smtpHost=String(input.smtpHost||'').trim().toLowerCase();
 const imapHost=String(input.imapHost||'').trim().toLowerCase();
 const senderImapHost=String(input.senderImapHost||'').trim().toLowerCase();
 const aliases=input.aliases;
 if(!EMAIL.test(mailbox)||!pass||pass.length>256)throw Error('Enter a verified inbox and its mail app password.');
 if(!EMAIL.test(sender)||!senderPass||senderPass.length>256)
  throw Error('Enter a separate sending account and its app password.');
 if(mailboxIdentity(sender)===mailboxIdentity(mailbox)||sender.endsWith('@sng.sarl'))
  throw Error('Use a different sending mailbox, not the forwarding destination or an @sng.sarl alias. Gmail may suppress messages sent back to the same mailbox.');
 for(const host of [smtpHost,imapHost,...(senderImapHost?[senderImapHost]:[])]){
  if(!HOST.test(host)||!host.includes('.')||
     /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(host))
   throw Error('Use valid public SMTP and IMAP hostnames.');
 }
 if(!Array.isArray(aliases)||aliases.length<1||aliases.length>25)throw Error('Test 1–25 aliases per automatic batch.');
 const seen=new Set(),addresses=[];
 for(const item of aliases){
  const alias=String(item||'').trim().toLowerCase();
  if(!VALID_ALIAS.test(alias)||alias.includes('..')||seen.has(alias))
   throw Error('Aliases must be unique addresses on the verified business domain.');
  seen.add(alias);addresses.push(alias);
 }
 return {mailbox,pass,sender,senderPass,smtpHost,imapHost,senderImapHost,aliases:addresses};
}
function transport(mail,cfg){
 return mail.createTransport({
  host:cfg.smtpHost,port:465,secure:true,pool:true,maxConnections:1,maxMessages:25,
  // Throttle to avoid fast bursts; provider daily quotas remain authoritative.
  rateDelta:1000,rateLimit:2,
  auth:{user:cfg.sender,pass:cfg.senderPass},
  connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000,
  tls:{rejectUnauthorized:true}
 });
}
function imapClient(IMAP,host,user,password){
 const client=new IMAP({
  host,port:993,secure:true,auth:{user,pass:password},
  logger:false,disableAutoIdle:true,connectionTimeout:15000,
  socketTimeout:30000,tls:{rejectUnauthorized:true}
 });
 client.on?.('error',()=>{}); // Never log connection details or credentials.
 return client;
}
function specialBox(boxes,flag){
 return boxes.find(box=>box?.specialUse===flag&&typeof box.path==='string'&&box.path.length>0);
}
function matchedMarkers(tests){
 return new Map(tests.filter(t=>t.received).map(t=>[t.marker,t]));
}
async function moveExactTestsToTrash(imap,box,tests,{now=Date.now,started=0}={}){
 const matched=matchedMarkers(tests);
 if(!matched.size)return 0;
 if(typeof imap.list!=='function'||typeof imap.messageMove!=='function')return 0;
 const boxes=await imap.list(),trash=specialBox(boxes,'\\Trash');
 if(!trash||trash.path===box)return 0;
 // Only exact nonces minted during this test call are eligible for cleanup.
 const ids=await imap.search({subject:PREFIX},{uid:true});
 const candidates=Array.isArray(ids)?ids.slice(-MAX_RECEIPT_CANDIDATES):[];
 const selected=new Set(tests.filter(t=>t.receivedFolder===box&&Number.isSafeInteger(t.receivedUid)&&t.receivedUid>0).map(t=>t.receivedUid));
 if(candidates.length){
  for await(const message of imap.fetch(candidates,{envelope:true,internalDate:true},{uid:true})){
   const stamp=message.internalDate?new Date(message.internalDate).getTime():NaN;
   if(!Number.isFinite(stamp)||stamp<started-30000||stamp>now()+30000)continue;
   const marker=String(message.envelope?.subject||'');
   if(matched.has(marker)&&Number.isSafeInteger(message.uid)&&message.uid>0)
    selected.add(message.uid);
  }
 }
 if(!selected.size)return 0;
 const moved=await imap.messageMove([...selected],trash.path,{uid:true});
 return moved===false?0:selected.size;
}
async function cleanSentCopies(cfg,tests,{IMAP,now,started}){
 if(!cfg.senderImapHost||!tests.some(t=>t.received))return {moved:0,available:false};
 const senderImap=imapClient(IMAP,cfg.senderImapHost,cfg.sender,cfg.senderPass);
 let connected=false,lock=null;
 try{
  await senderImap.connect();connected=true;
  if(typeof senderImap.list!=='function')return {moved:0,available:false};
  const boxes=await senderImap.list();
  const sent=specialBox(boxes,'\\Sent'),trash=specialBox(boxes,'\\Trash');
  if(!sent||!trash)return {moved:0,available:false};
  lock=await senderImap.getMailboxLock(sent.path);
  const expected=matchedMarkers(tests);
  const ids=await senderImap.search({subject:PREFIX},{uid:true});
  const candidates=Array.isArray(ids)?ids.slice(-MAX_RECEIPT_CANDIDATES):[],uids=new Set();
  if(candidates.length){
   for await(const message of senderImap.fetch(candidates,{envelope:true,internalDate:true},{uid:true})){
    const stamp=message.internalDate?new Date(message.internalDate).getTime():NaN;
    if(!Number.isFinite(stamp)||stamp<started-30000||stamp>now()+30000)continue;
    if(expected.has(String(message.envelope?.subject||''))&&Number.isSafeInteger(message.uid)&&message.uid>0)
     uids.add(message.uid);
   }
  }
  if(!uids.size)return {moved:0,available:true};
  const moved=await senderImap.messageMove([...uids],trash.path,{uid:true});
  return {moved:moved===false?0:uids.size,available:true};
 }catch{
  return {moved:0,available:false};
 }finally{
  try{lock?.release();}catch{}
  if(connected)try{await senderImap.logout();}catch{}
 }
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function testForwarding(input,{mail=require('nodemailer'),IMAP=require('imapflow').ImapFlow,delay=sleep,now=Date.now,onProgress=()=>{},parseSource=source=>require('mailparser').simpleParser(source,{skipImageLinks:true})}={}){
 const cfg=validate(input),started=now();
 const transporter=transport(mail,cfg);
 const imap=imapClient(IMAP,cfg.imapHost,cfg.mailbox,cfg.pass);
 const tests=cfg.aliases.map(alias=>({alias,marker:PREFIX+crypto.randomBytes(12).toString('hex'),sent:false,received:false,attempted:false}));
 let connected=false,lock=null,receiverMoved=0,rateLimited=false;
 const receiptDiagnostics={scans:0,candidates:0,exactMatches:0,recentCount:0,matchMethods:{subject:0,source:0,'decoded-body':0},folders:[],waitMs:0};
 try{
  await imap.connect();connected=true;
  lock=await imap.getMailboxLock('INBOX');
  for(const item of tests){
   item.attempted=true;
   try{
    await transporter.sendMail({from:cfg.sender,to:item.alias,subject:item.marker,
     headers:{'X-ACO-Test-ID':item.marker,'X-ACO-Test-Recipient':item.alias},
     text:'Owner-requested ACO Studio forwarding test. Unique test ID: '+item.marker});
    item.sent=true;
    try{onProgress({alias:item.alias,status:'sent'});}catch{}
   }catch(error){
    item.sent=false;
    if(/\b(421|429|450|451|452|454|4\.7\.|5\.4\.5|quota|rate.?limit|too many|daily limit|temporar)/i.test(String(error?.responseCode||'')+' '+String(error?.code||'')+' '+String(error?.response||'')+' '+String(error?.message||'')))rateLimited=true;
    try{onProgress({alias:item.alias,status:'send_failed'});}catch{}
    if(rateLimited)break; // Stop on provider quotas rather than flooding retries.
   }
  }
  const sent=tests.filter(t=>t.sent);
  if(sent.length){
   const receiptStart=now(),deadline=receiptStart+IMAP_RECEIPT_WAIT_MS;
   let scanFolders=['INBOX'];
   if(typeof imap.list==='function'){
    try{scanFolders=[...new Set(['INBOX',...fallbackBoxes(await imap.list())])];}
    catch{receiptDiagnostics.folderError=true;}
   }
   let folder='INBOX';
   do{
    for(const nextFolder of scanFolders){
     if(sent.every(x=>x.received))break;
     if(nextFolder!==folder){
      try{lock?.release();}catch{} lock=null;
      try{lock=await imap.getMailboxLock(nextFolder);folder=nextFolder;}
      catch{receiptDiagnostics.folderError=true;continue;}
     }
     if(!receiptDiagnostics.folders.includes(nextFolder))receiptDiagnostics.folders.push(nextFolder);
     try{
      await scanCurrentMailboxForExactMarkers(imap,sent,{
       started,now,onProgress,folder:nextFolder,diagnostics:receiptDiagnostics,parseSource
      });
     }catch{receiptDiagnostics.folderError=true;}
    }
    if(sent.every(x=>x.received)||now()>=deadline)break;
    await delay(IMAP_POLL_MS);
   }while(true);
   receiptDiagnostics.waitMs=Math.max(0,now()-receiptStart);
  }
  // Clean up ONLY exact Inbox matches. All Mail/Spam are read-only.
  try{
   if(lock){try{lock.release();}catch{}lock=null;}
   lock=await imap.getMailboxLock('INBOX');
   receiverMoved=await moveExactTestsToTrash(imap,'INBOX',tests.filter(t=>t.receivedFolder==='INBOX'),{now,started});
  }catch{receiverMoved=0;}
  for(const item of tests)if(item.sent&&!item.received){
   try{onProgress({alias:item.alias,status:'unconfirmed'});}catch{}
  }
 }finally{
  try{lock?.release();}catch{}
  if(connected)try{await imap.logout();}catch{}
  try{transporter.close();}catch{}
 }
 // Sender Sent cleanup is independent. A failure never invalidates a confirmed receipt.
 const sentCleanup=await cleanSentCopies(cfg,tests,{IMAP,now,started});
 const received=tests.filter(t=>t.received).length;
 return {total:tests.length,delivered:received,receiverMovedToTrash:receiverMoved,
  senderMovedToTrash:sentCleanup.moved,senderCleanupAvailable:sentCleanup.available,
  cleanupPending:Math.max(0,tests.filter(t=>t.received&&t.receivedFolder==='INBOX').length-receiverMoved),rateLimited,
  receiptDiagnostics:{scans:receiptDiagnostics.scans,candidates:receiptDiagnostics.candidates,
   recentCount:receiptDiagnostics.recentCount,exactMatches:receiptDiagnostics.exactMatches,matchMethods:receiptDiagnostics.matchMethods,
   parseFailures:receiptDiagnostics.parseFailures||0,folders:receiptDiagnostics.folders,
   waitMs:receiptDiagnostics.waitMs,folderError:receiptDiagnostics.folderError===true,
   discoveredOutsideInbox:tests.filter(t=>t.received&&t.receivedFolder!=='INBOX').length},
  sentButUnconfirmed:tests.filter(t=>t.sent&&!t.received).length,
  sendFailed:tests.filter(t=>t.attempted&&!t.sent).length,
  skipped:tests.filter(t=>!t.attempted).length,
  results:tests.map(t=>({alias:t.alias,status:t.received?'delivered':t.sent?'unconfirmed':t.attempted?'send_failed':'not_attempted'}))};
}
async function verifyMailLogins(config,{mail=require('nodemailer'),IMAP=require('imapflow').ImapFlow}={}){
 const cfg=normalizeConfig(config);
 const sender=transport(mail,{...cfg,senderPass:cfg.senderPassword});
 const receiver=imapClient(IMAP,cfg.imapHost,cfg.mailbox,cfg.password);
 const sentBox=imapClient(IMAP,cfg.senderImapHost,cfg.sender,cfg.senderPassword);
 let recvConnected=false,sentConnected=false;
 try{
  if(typeof sender.verify==='function')await sender.verify();
  await receiver.connect();recvConnected=true;
  await sentBox.connect();sentConnected=true;
  return cfg;
 }catch{throw Error('Mail account connection failed. Check both account addresses, app passwords and IMAP access; credentials were not saved.');}
 finally{
  try{sender.close();}catch{}
  if(recvConnected)try{await receiver.logout();}catch{}
  if(sentConnected)try{await sentBox.logout();}catch{}
 }
}
function reuseSavedReceiverCredentials(config,store){
 if(config?.reuseReceiverCredentials!==true||String(config.password||'').trim())return config;
 // Owner-only: the stored IMAP secret stays inside the main process and can
 // only be reused for this EXACT receiver, never another destination.
 const original=store.read({mailbox:config.mailbox});
 if(!original)throw Error('No saved receiver credentials match this inbox. Enter and verify its app password first.');
 return {...config,password:original.password,imapHost:original.imapHost};
}
function register({ipcMain,requireOwner,requireCloudflareSession,baseDir,safeStorage,platform=process.platform}){
 const store=makeMailTestStore({baseDir,safeStorage,platform});
 const authorize=event=>{requireOwner(event);requireCloudflareSession(event);};
 // Saved Mac Keychain metadata is local owner data. Its read-only status
 // MUST NOT depend on the separate Cloudflare login being active after restart.
 ipcMain.handle('email:test:credentials:status',event=>{requireOwner(event);return store.status();});
 ipcMain.handle('email:test:credentials:backups',event=>{requireOwner(event);return store.backupStatus();});
 ipcMain.handle('email:test:credentials:restore-missing',(event,request)=>{
  requireOwner(event);return store.restoreMissingFromBackup(request);
 });
 ipcMain.handle('email:test:credentials:forget',(event,selection)=>{authorize(event);return store.forget(selection);});
 ipcMain.handle('email:test:credentials:save',async(event,config)=>{
  authorize(event);
  const verified=await verifyMailLogins(reuseSavedReceiverCredentials(config,store));
  return store.save(verified);
 });
 ipcMain.handle('email:forwarding-test',async(event,request)=>{
  authorize(event);
  const mailbox=String(request?.mailbox||'').trim().toLowerCase();
  const sender=String(request?.sender||'').trim().toLowerCase();
  const config=store.read({mailbox,sender});
  if(!config)throw Error('No secure mail-test account matches '+mailbox+(sender?' with sender '+sender:'')+'. Save the sending/receiving account pair first.');
  const runId=typeof request.runId==='string'&&/^[a-z0-9-]{8,90}$/i.test(request.runId)?request.runId:null;
  return testForwarding({...config,aliases:request.aliases},{
   onProgress:progress=>{
    if(runId&&!event.sender.isDestroyed?.())event.sender.send('email:test:progress',{runId,...progress});
   }
  });
 });
 return {store};
}
module.exports={validate,testForwarding,verifyMailLogins,register,moveExactTestsToTrash,cleanSentCopies,reuseSavedReceiverCredentials,fallbackBoxes,IMAP_RECEIPT_WAIT_MS,matchExactMarker,scanCurrentMailboxForExactMarkers};
