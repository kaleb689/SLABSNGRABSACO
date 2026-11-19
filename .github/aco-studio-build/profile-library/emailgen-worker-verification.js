'use strict';
// Owner-only Cloudflare D1 receipt verification. The token is read exclusively
// from the existing encrypted Cloudflare owner session in Electron main.
// No raw email, credentials, or Cloudflare API token reach the renderer.
const crypto=require('node:crypto');
const {makeMailTestStore}=require('./emailgen-mail-test-store');
const PREFIX='ACO Studio forwarding test ';
const MAX_BATCH=25;
const POLL_MS=3000;
const WAIT_MS=60000;
const ACCOUNT_ID=/^[a-f0-9]{32}$/i;
const EMAIL=/^[a-z0-9][a-z0-9._+-]{0,62}@sng\.sarl$/i;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function credentialsFor(event,{sessions,requireOwner,requireCloudflareSession}){
 requireOwner(event);
 requireCloudflareSession(event);
 const cfg=sessions?.get(event.sender.id)?.config;
 if(!cfg?.token||!ACCOUNT_ID.test(cfg.accountId||''))
  throw Error('Reconnect the saved Cloudflare owner login to verify receipts securely.');
 return cfg;
}
async function cfRequest(cfg,path,options={},request=globalThis.fetch){
 const result=await request('https://api.cloudflare.com/client/v4'+path,{
  method:options.method||'GET',
  headers:{Authorization:'Bearer '+cfg.token,'Content-Type':'application/json'},
  ...(options.body?{body:JSON.stringify(options.body)}:{})
 });
 let data={};
 try{data=await result.json();}catch{}
 if(!result.ok||data.success!==true){
  const codes=(data.errors||[]).map(e=>e.code).join(',');
  if([401,403].includes(result.status))
   throw Error('Cloudflare owner token lacks D1 read access for this account. Reauthorize ACO Studio once with a token that includes Account > D1 > Read. No email marked verified.');
  throw Error('Cloudflare receipt index unavailable (HTTP '+result.status+', codes '+codes+'). No email marked verified.');
 }
 return data.result;
}
async function database(cfg,request=globalThis.fetch){
 const rows=await cfRequest(cfg,'/accounts/'+cfg.accountId+'/d1/database?per_page=100',{},request);
 const selected=Array.isArray(rows)?rows.find(x=>x.name==='sng-inbound-index'):null;
 const id=selected?.uuid||selected?.id;
 if(!ACCOUNT_ID.test(id||''))throw Error('sng-inbound-index was not found in this Cloudflare account. No email marked verified.');
 return id;
}
async function readReceipts(cfg,dbId,tests,after,request=globalThis.fetch){
 if(tests.length<1||tests.length>MAX_BATCH)throw Error('Invalid Cloudflare receipt lookup batch.');
 const markers=tests.map(x=>x.marker.toLowerCase());
 const sql='SELECT alias,marker,received_ms FROM inbound_receipts WHERE marker IN ('+
  tests.map(()=>'?').join(',')+') AND received_ms>=? LIMIT 100';
 const response=await cfRequest(cfg,'/accounts/'+cfg.accountId+'/d1/database/'+dbId+'/query',
  {method:'POST',body:{sql,params:[...markers,after]}},request);
 const rows=Array.isArray(response)?response.flatMap(x=>Array.isArray(x.results)?x.results:[]):[];
 const expected=new Set(tests.map(x=>x.alias+'|'+x.marker.toLowerCase()));
 return new Set(rows.filter(r=>expected.has(String(r.alias||'').toLowerCase()+'|'+String(r.marker||'').toLowerCase()))
  .map(x=>String(x.alias||'').toLowerCase()));
}
async function verifyBatch(config,{request=globalThis.fetch,mail=require('nodemailer'),delay=sleep,now=Date.now,onProgress=()=>{},waitMs=WAIT_MS}={}){
 const aliases=config?.aliases;
 if(!Array.isArray(aliases)||aliases.length<1||aliases.length>MAX_BATCH ||
    aliases.some(a=>!EMAIL.test(a))||new Set(aliases.map(a=>a.toLowerCase())).size!==aliases.length)
  throw Error('Select 1–25 distinct @sng.sarl email aliases for each verification group.');
 if(!config.senderConfig?.sender||!config.senderConfig?.senderPassword)
  throw Error('Save a verified sending account once in Email Gen Mail accounts.');
 const {sender,senderPassword,smtpHost}=config.senderConfig;
 const cfg=config.cloudflare;
 const dbId=await database(cfg,request); // MUST authorize D1 before sending even one test.
 const transport=mail.createTransport({
  host:smtpHost||'smtp.gmail.com',port:465,secure:true,pool:true,maxConnections:1,maxMessages:MAX_BATCH,
  rateDelta:1000,rateLimit:2,auth:{user:sender,pass:senderPassword},
  connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000,tls:{rejectUnauthorized:true}
 });
 const started=now(),tests=aliases.map(a=>({alias:a.toLowerCase(),marker:PREFIX+crypto.randomBytes(12).toString('hex'),sent:false,attempted:false,received:false}));
 let rateLimited=false;
 try{
  for(const item of tests){
   if(rateLimited)break;
   item.attempted=true;
   try{
    await transport.sendMail({from:sender,to:item.alias,subject:item.marker,
      headers:{'X-ACO-Test-ID':item.marker,'X-ACO-Test-Recipient':item.alias},
      text:'Owner-requested SLABSNGRABSACO Email Gen receipt verification. Marker: '+item.marker});
    item.sent=true;
    try{onProgress({alias:item.alias,status:'sent'});}catch{}
   }catch(error){
    const summary=String(error?.responseCode||'')+' '+String(error?.code||'')+' '+String(error?.response||'')+' '+String(error?.message||'');
    if(/\b(421|429|450|451|452|454|4\.7\.|5\.4\.5|quota|rate.?limit|too many|daily limit|temporar)/i.test(summary))rateLimited=true;
    try{onProgress({alias:item.alias,status:'send_failed'});}catch{}
   }
  }
  const sent=tests.filter(t=>t.sent),deadline=now()+Math.min(90000,Math.max(5000,waitMs));
  if(sent.length){
   do{
    const seen=await readReceipts(cfg,dbId,sent,started-30000,request);
    for(const item of sent){if(seen.has(item.alias))item.received=true;}
    if(sent.every(x=>x.received)||now()>=deadline)break;
    await delay(POLL_MS);
   }while(true);
  }
 }finally{try{transport.close();}catch{}}
 return {
  provider:'cloudflare-d1',total:tests.length,delivered:tests.filter(x=>x.received).length,
  sentButUnconfirmed:tests.filter(x=>x.sent&&!x.received).length,
  sendFailed:tests.filter(x=>x.attempted&&!x.sent).length,
  skipped:tests.filter(x=>!x.attempted).length,
  rateLimited,cleanupPending:0,
  results:tests.map(t=>({alias:t.alias,status:t.received?'delivered':t.sent?'unconfirmed':t.attempted?'send_failed':'not_attempted'}))
 };
}
function register({ipcMain,requireOwner,requireCloudflareSession,sessions,baseDir,safeStorage,platform=process.platform}){
 const store=makeMailTestStore({baseDir,safeStorage,platform});
 ipcMain.handle('email:worker:status',async event=>{
  const cfg=credentialsFor(event,{sessions,requireOwner,requireCloudflareSession});
  const id=await database(cfg);
  // This is NOT proof of an active catch-all: no real message is received here.
  await cfRequest(cfg,'/accounts/'+cfg.accountId+'/d1/database/'+id+'/query',
    {method:'POST',body:{sql:'SELECT COUNT(*) AS count FROM inbound_receipts LIMIT 1',params:[]}});
  return {storageReady:true,liveRoutingVerified:false,provider:'cloudflare-d1'};
 });
 ipcMain.handle('email:worker:verify',async(event,payload)=>{
  const cfg=credentialsFor(event,{sessions,requireOwner,requireCloudflareSession});
  const mailbox=String(payload?.mailbox||'').trim().toLowerCase(),sender=String(payload?.sender||'').trim().toLowerCase();
  const saved=store.read({mailbox,sender});
  if(!saved)throw Error('Choose a saved sending account in Email Gen before automatic verification. Existing Keychain credentials were not modified.');
  const runId=typeof payload.runId==='string'&&/^[a-z0-9-]{8,90}$/i.test(payload.runId)?payload.runId:'';
  return verifyBatch({cloudflare:cfg,senderConfig:saved,aliases:payload.aliases},{
   onProgress:progress=>{
    if(runId&&!event.sender.isDestroyed?.())event.sender.send('email:test:progress',{runId,...progress});
   }
  });
 });
}
module.exports={register,verifyBatch,readReceipts,database,cfRequest,PREFIX};
