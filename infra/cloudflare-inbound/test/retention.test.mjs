import test from 'node:test';
import assert from 'node:assert/strict';
import handler, {retentionFor,retentionSettings,expireBatch} from '../src/worker.mjs';

const HOUR=3600000;
const alias='someperson@sng.sarl';
const token='secret'.repeat(10);
function harness(now=Date.now()){
 const objects=new Map(),receipts=new Map(),retention=new Map(),sent=[];
 let failDelete=false;
 const env={
  ADMIN_API_TOKEN:token,
  RAW_MAIL:{
   async put(key,raw){objects.set(key,raw)},
   async head(key){return objects.has(key)?{key}:null},
   async get(key){return objects.has(key)?{body:new Blob(['sample original MIME']).stream()}:null},
   async delete(key){if(failDelete)throw Error('R2 temporary failure');objects.delete(key)}
  },
  INBOUND_QUEUE:{async send(entry){sent.push(entry)}},
  RECEIPTS:{prepare(sql){return {bind(...args){
   return {
    async run(){
     if(sql.includes('INSERT OR IGNORE INTO inbound_receipts')){
      const [id,alias,marker,receivedMs,sizeBytes,key]=args;
      if(!receipts.has(id))receipts.set(id,{id,alias,marker,received_ms:receivedMs,size_bytes:sizeBytes,r2_key:key});
     }else if(sql.includes('INSERT OR IGNORE INTO inbound_retention')){
      const [id,kind,expiresMs]=args;
      if(!retention.has(id))retention.set(id,{id,kind,expires_ms:expiresMs});
     }else if(sql.includes('DELETE FROM inbound_retention'))retention.delete(args[0]);
     else if(sql.includes('DELETE FROM inbound_receipts'))receipts.delete(args[0]);
     else throw Error('Unexpected mutation '+sql);
    },
    async first(){
     if(sql.includes('COUNT(*)'))return {total:receipts.size};
     if(sql.includes('WHERE r.id=?')){
      const r=receipts.get(args[0]),t=retention.get(args[0]);
      if(!r || (t?.expires_ms??r.received_ms+args[1])<=args[2])return null;
      return {id:r.id,r2_key:r.r2_key};
     }
     return null;
    },
    async all(){
     if(sql.includes('ORDER BY r.received_ms ASC LIMIT ?')){
      const [fallback,at,limit]=args;
      return {results:[...receipts.values()].filter(r=>
       (retention.get(r.id)?.expires_ms??r.received_ms+fallback)<=at)
       .sort((a,b)=>a.received_ms-b.received_ms).slice(0,limit).map(x=>({id:x.id,r2_key:x.r2_key}))};
     }
     if(sql.includes('WHERE r.alias=?')){
      const [fallback,who,,at]=args;
      return {results:[...receipts.values()].filter(r=>r.alias===who&&
       (retention.get(r.id)?.expires_ms??r.received_ms+fallback)>at)
       .sort((a,b)=>b.received_ms-a.received_ms)
       .slice(0,50).map(r=>({id:r.id,alias:r.alias,receivedMs:r.received_ms,
        sizeBytes:r.size_bytes,kind:retention.get(r.id)?.kind||'other',
        expiresMs:retention.get(r.id)?.expires_ms??r.received_ms+fallback}))};
     }
     throw Error('Unexpected select '+sql);
    }
   };
  }}}}
 };
 return {env,objects,receipts,retention,sent,setFail(v){failDelete=v}};
}
async function ingest(h,subject){
 const raw=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('Message'));controller.close()}});
 const header=new Headers({'subject':subject});
 await handler.email({to:alias,rawSize:7,raw,headers:header},h.env);
 let acknowledged=0,retried=0;
 await handler.queue({messages:[{body:h.sent.at(-1),ack(){acknowledged++},retry(){retried++}}]},h.env);
 assert.equal(acknowledged,1);assert.equal(retried,0);
 return h.sent.at(-1);
}
test('Verification email expires in 24h by default; other messages retain for 7d',()=>{
 const at=1700000000000;
 assert.deepEqual(retentionSettings({}),{codeHours:24,otherHours:168});
 const a=retentionFor(new Headers({subject:'Your Target verification code'}),{},at);
 const b=retentionFor(new Headers({subject:'Order receipt'}),{},at);
 assert.equal(a.kind,'verification');assert.equal(a.expiresMs,at+24*HOUR);
 assert.equal(b.kind,'other');assert.equal(b.expiresMs,at+168*HOUR);
});
test('Supported settings can shorten verification retention without changing unrelated mail',()=>{
 const at=1700000000000,env={CODE_RETENTION_HOURS:'6',OTHER_RETENTION_HOURS:'72'};
 assert.equal(retentionFor(new Headers({subject:'Use this sign-in code'}),env,at).expiresMs,at+6*HOUR);
 assert.equal(retentionFor(new Headers({subject:'Weekly report'}),env,at).expiresMs,at+72*HOUR);
 assert.deepEqual(retentionSettings({CODE_RETENTION_HOURS:'0',OTHER_RETENTION_HOURS:'999'}),{codeHours:24,otherHours:168});
});
test('An owner can list received mail, fetch the original MIME, and TTL removes contents and index',async()=>{
 const h=harness(),item=await ingest(h,'Your verification code');
 assert.equal(h.receipts.size,1);assert.equal(h.retention.size,1);assert.equal(h.objects.size,1);
 assert.equal(h.retention.get(item.id).kind,'verification');
 const auth={authorization:'Bearer '+token};
 const without=await handler.fetch(new Request('https://worker.example/v1/inbox?alias='+alias),h.env);
 assert.equal(without.status,401);
 const listed=await handler.fetch(new Request('https://worker.example/v1/inbox?alias='+alias,{headers:auth}),h.env);
 assert.equal(listed.status,200);
 const data=await listed.json();
 assert.equal(data.messages.length,1);assert.equal(data.messages[0].kind,'verification');
 assert.ok(!JSON.stringify(data).includes('sample original MIME'));
 const raw=await handler.fetch(new Request('https://worker.example/v1/message?id='+item.id,{headers:auth}),h.env);
 assert.equal(raw.status,200);assert.equal(raw.headers.get('content-type'),'message/rfc822');
 assert.equal(await raw.text(),'sample original MIME');
 const notYet=await expireBatch(h.env,item.receivedMs+23*HOUR);
 assert.equal(notYet.deleted,0);
 const expired=await expireBatch(h.env,item.expiresMs+1);
 assert.equal(expired.deleted,1);assert.equal(expired.failed,0);
 assert.equal(h.objects.size,0);assert.equal(h.receipts.size,0);assert.equal(h.retention.size,0);
 const missing=await handler.fetch(new Request('https://worker.example/v1/message?id='+item.id,{headers:auth}),h.env);
 assert.equal(missing.status,404);
});
test('Failed R2 delete cannot silently erase receipt metadata; next hourly cleanup retries',async()=>{
 const h=harness(),item=await ingest(h,'Verification code');
 h.setFail(true);
 const failed=await expireBatch(h.env,item.expiresMs+1);
 assert.equal(failed.failed,1);assert.equal(failed.deleted,0);
 assert.equal(h.receipts.size,1);assert.equal(h.objects.size,1);
 h.setFail(false);
 const retry=await expireBatch(h.env,item.expiresMs+2);
 assert.equal(retry.deleted,1);
 assert.equal(h.receipts.size,0);assert.equal(h.objects.size,0);
});
test('Inbox access cannot be obtained with a mismatched alias or expired message ID',async()=>{
 const h=harness();const item=await ingest(h,'Order receipt');
 const auth={authorization:'Bearer '+token};
 const bad=await handler.fetch(new Request('https://worker.example/v1/inbox?alias=attacker.test',{headers:auth}),h.env);
 assert.equal(bad.status,400);
 const missing=await handler.fetch(new Request('https://worker.example/v1/message?id=not-a-uuid',{headers:auth}),h.env);
 assert.equal(missing.status,400);
 const removed=await handler.fetch(new Request('https://worker.example/v1/message?id='+item.id,{method:'DELETE',headers:auth}),h.env);
 assert.equal(removed.status,200);
 assert.equal(h.receipts.size,0);assert.equal(h.objects.size,0);
});
