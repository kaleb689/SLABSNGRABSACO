'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {verifyBatch,readReceipts,database}=require('../emailgen-worker-verification');
const cfg={accountId:'a'.repeat(32),token:'PRIVATE-TEST-TOKEN'};
const senderConfig={mailbox:'owner@example.net',sender:'sender@example.net',senderPassword:'SECRET-TEST-ONLY',smtpHost:'smtp.example.net'};
function mock({receive=true,db=true,rateLimit=false}={}){
 const messages=[],requests=[],raw=[];
 const request=async(url,opts={})=>{
  requests.push({url,method:opts.method||'GET',authorization:opts.headers?.Authorization,body:opts.body});
  let success=true,result=[];
  if(url.includes('/d1/database?'))result=db?[{name:'sng-inbound-index',uuid:'b'.repeat(32)}]:[];
  else if(url.includes('/d1/database/')&&url.endsWith('/query')){
   const body=JSON.parse(opts.body||'{}');
   if(body.sql.includes('SELECT alias,marker')){
    const markers=new Set(body.params.slice(0,-1));
    result=[{results:receive?messages.filter(x=>markers.has(x.subject.toLowerCase())).map(x=>({alias:x.to,marker:x.subject.toLowerCase(),received_ms:Date.now()})):[]}];
   }else result=[{results:[{count:0}]}];
  }
  else throw Error('Unexpected Cloudflare API path');
  return {ok:true,status:200,json:async()=>({success,result})};
 };
 const mail={createTransport:options=>{
  assert.equal(options.auth.pass,senderConfig.senderPassword);
  return {
   async sendMail(message){
    if(rateLimit)throw Object.assign(Error('Provider rate limit 452'),{responseCode:452});
    messages.push(message);raw.push(message);
    return {accepted:[message.to]};
   },close(){}
  };
 }};
 return {request,mail,requests,messages};
}
test('Cloudflare batch verifies only D1-stored exact alias and 96-bit nonce, never SMTP alone',async()=>{
 const h=mock();
 const result=await verifyBatch({cloudflare:cfg,senderConfig,aliases:['one@sng.sarl','two@sng.sarl']},
  {request:h.request,mail:h.mail,delay:async()=>{},now:(()=>{let v=Date.now();return ()=>v+=30000})()});
 assert.equal(result.delivered,2);
 assert.deepEqual(result.results.map(x=>x.status),['delivered','delivered']);
 assert.equal(h.messages.length,2);
 assert.ok(h.messages.every(x=>x.subject.startsWith('ACO Studio forwarding test ')));
 assert.ok(h.requests.every(x=>x.authorization==='Bearer '+cfg.token));
 assert.ok(!JSON.stringify(result).includes(senderConfig.senderPassword));
});
test('SMTP accepted but no Cloudflare receipt stays unconfirmed',async()=>{
 const h=mock({receive:false});
 const result=await verifyBatch({cloudflare:cfg,senderConfig,aliases:['one@sng.sarl']},
  {request:h.request,mail:h.mail,delay:async()=>{},now:(()=>{let v=Date.now();return ()=>v+=70000})()});
 assert.equal(result.delivered,0);
 assert.equal(result.sentButUnconfirmed,1);
 assert.equal(result.results[0].status,'unconfirmed');
});
test('Missing Cloudflare D1 index prevents sending any test emails',async()=>{
 const h=mock({db:false});
 await assert.rejects(verifyBatch({cloudflare:cfg,senderConfig,aliases:['one@sng.sarl']},
  {request:h.request,mail:h.mail}),/sng-inbound-index was not found/);
 assert.equal(h.messages.length,0);
});
test('Rate limited sender stops additional sends without marking aliases as delivered',async()=>{
 const h=mock({rateLimit:true});
 const result=await verifyBatch({cloudflare:cfg,senderConfig,aliases:['one@sng.sarl','two@sng.sarl']},
  {request:h.request,mail:h.mail});
 assert.equal(result.rateLimited,true);
 assert.deepEqual(result.results.map(x=>x.status),['send_failed','not_attempted']);
 assert.equal(result.delivered,0);
});
test('Query joins exact aliases, exact markers and a recent timestamp via parameters',async()=>{
 const h=mock();
 const rows=await readReceipts(cfg,'b'.repeat(32),[{alias:'one@sng.sarl',marker:'ACO Studio forwarding test '+'a'.repeat(24)}],Date.now()-1000,h.request);
 assert.equal(rows.size,0);
 const q=h.requests.find(x=>x.method==='POST');
 assert.match(q.body,/"params"/);
 assert.ok(JSON.parse(q.body).sql.includes('WHERE marker IN (?) AND received_ms>=?'));
});
test('One-click mode is wired into actual Email Gen desktop UI and cannot auto-approve staged emails',()=>{
 const root=path.resolve(__dirname,'..');
 const panel=fs.readFileSync(path.join(root,'emailgen-random-panel.html'),'utf8');
 const ui=fs.readFileSync(path.join(root,'emailgen-oneclick-ui.js'),'utf8');
 const auto=fs.readFileSync(path.join(root,'emailgen-auto-test-ui.js'),'utf8');
 const app=fs.readFileSync(path.join(root,'apply.cjs'),'utf8');
 for(const id of ['randomCloudReceiptMode','randomOneClickStatus','randomCloudCheckStatus'])assert.ok(panel.includes('id="'+id+'"'));
 assert.match(ui,/SAFE STOP: none of the first/);
 assert.match(ui,/row\.verificationSource='cloudflare-d1'/);
 assert.match(ui,/result\?\.provider!=='cloudflare-d1'/);
 assert.match(auto,/runCloudReceiptTests\(/);
 assert.match(app,/inboundWorkerStatus:.*email:worker:status/);
 assert.match(app,/setupOneClickEmailGen\(\)/);
 assert.doesNotMatch(ui,/api\(\)\.publish/);
});
