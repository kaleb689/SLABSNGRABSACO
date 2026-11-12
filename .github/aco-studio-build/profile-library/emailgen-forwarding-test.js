'use strict';
// SMTP -> alias -> destination IMAP tests. Only exact, nonce-marked ACO test
// messages are moved to Trash after receipt. Never touch other customer mail.
const crypto=require('node:crypto');
const {makeMailTestStore,normalizeConfig}=require('./emailgen-mail-test-store');
const VALID_ALIAS=/^[a-z0-9][a-z0-9._-]{0,63}@sng\.sarl$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST=/^[a-z0-9](?:[a-z0-9.-]{1,248})[a-z0-9]$/i;
const PREFIX='ACO Studio forwarding test ';
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
 const candidates=Array.isArray(ids)?ids.slice(-500):[];
 const selected=new Set();
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
  const candidates=Array.isArray(ids)?ids.slice(-500):[],uids=new Set();
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
async function testForwarding(input,{mail=require('nodemailer'),IMAP=require('imapflow').ImapFlow,delay=sleep,now=Date.now,onProgress=()=>{}}={}){
 const cfg=validate(input),started=now();
 const transporter=transport(mail,cfg);
 const imap=imapClient(IMAP,cfg.imapHost,cfg.mailbox,cfg.pass);
 const tests=cfg.aliases.map(alias=>({alias,marker:PREFIX+crypto.randomBytes(12).toString('hex'),sent:false,received:false}));
 let connected=false,lock=null,receiverMoved=0,rateLimited=false;
 try{
  await imap.connect();connected=true;
  lock=await imap.getMailboxLock('INBOX');
  for(const item of tests){
   try{
    await transporter.sendMail({from:cfg.sender,to:item.alias,subject:item.marker,
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
   const deadline=now()+90000;
   do{
    const ids=await imap.search({subject:PREFIX},{uid:true});
    if(ids.length){
     const recent=ids.slice(-500);
     for await(const message of imap.fetch(recent,{envelope:true,internalDate:true},{uid:true})){
      const stamp=message.internalDate?new Date(message.internalDate).getTime():NaN;
      if(!Number.isFinite(stamp)||stamp<started-30000)continue;
      const subject=String(message.envelope?.subject||'');
      for(const item of sent)if(!item.received&&subject===item.marker){
       item.received=true;
       try{onProgress({alias:item.alias,status:'delivered'});}catch{}
      }
     }
    }
    if(sent.every(x=>x.received)||now()>=deadline)break;
    await delay(4000);
   }while(true);
  }
  for(const item of tests)if(item.sent&&!item.received){
   try{onProgress({alias:item.alias,status:'unconfirmed'});}catch{}
  }
  // Move only the exact delivered test nonces out of INBOX to Trash.
  // If Trash is unavailable, leave mail alone and report incomplete cleanup.
  try{receiverMoved=await moveExactTestsToTrash(imap,'INBOX',tests,{now,started});}
  catch{receiverMoved=0;}
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
  cleanupPending:Math.max(0,received-receiverMoved),rateLimited,
  sentButUnconfirmed:tests.filter(t=>t.sent&&!t.received).length,
  sendFailed:tests.filter(t=>!t.sent).length,
  results:tests.map(t=>({alias:t.alias,status:t.received?'delivered':t.sent?'unconfirmed':'send_failed'}))};
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
function register({ipcMain,requireOwner,requireCloudflareSession,baseDir,safeStorage,platform=process.platform}){
 const store=makeMailTestStore({baseDir,safeStorage,platform});
 const authorize=event=>{requireOwner(event);requireCloudflareSession(event);};
 ipcMain.handle('email:test:credentials:status',event=>{authorize(event);return store.status();});
 ipcMain.handle('email:test:credentials:forget',(event,selection)=>{authorize(event);return store.forget(selection);});
 ipcMain.handle('email:test:credentials:save',async(event,config)=>{
  authorize(event);
  const verified=await verifyMailLogins(config);
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
module.exports={validate,testForwarding,verifyMailLogins,register,moveExactTestsToTrash,cleanSentCopies};
