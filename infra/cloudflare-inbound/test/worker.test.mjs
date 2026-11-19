import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadableStream} from 'node:stream/web';
import handler, {aliasOf, markerOf, tokenEqual} from '../src/worker.mjs';

const marker = 'ACO Studio forwarding test ' + 'a'.repeat(24);
const alias = 'test-user@sng.sarl';

function environment() {
  const writes = [];
  const queued = [];
  const records = [];
  const env = {
    ADMIN_API_TOKEN: 'x'.repeat(48),
    RAW_MAIL: {
      async put(key, body, opts) {
        assert.ok(key.startsWith('incoming/'));
        assert.ok(body instanceof ReadableStream);
        assert.equal(opts.httpMetadata.contentType,'message/rfc822');
        writes.push(key);
      },
      async head(key) { return writes.includes(key) ? {key} : null; },
    },
    INBOUND_QUEUE: {async send(body){queued.push(body);}},
    RECEIPTS: {
      prepare(sql) { return {
        bind(...args) { return {
          async run(){records.push({sql,args});},
          async first(){
            if(sql.includes('COUNT(*)'))return {total:records.length};
            const found=records.find(x=>x.args?.[1]===args[1] && x.args?.[2]===args[2] && x.args?.[3]>=args[3]);
            return found?{receivedMs:found.args[3]}:null;
          },
        };},
      };},
    },
  };
  return {env,writes,queued,records};
}

test('strictly accepts business-domain aliases and exact test markers',()=>{
  assert.equal(aliasOf('NAME@SNG.SARL'),'name@sng.sarl');
  assert.equal(aliasOf('name@elsewhere.test'),'');
  assert.equal(aliasOf('name@sng.sarl.attacker.test'),'');
  assert.equal(markerOf(new Headers({'subject':'Fwd: '+marker})),marker.toLowerCase());
  assert.equal(markerOf(new Headers({'subject':'random unrelated mail'})),'');
  assert.equal(tokenEqual('a'.repeat(40),'a'.repeat(40)),true);
  assert.equal(tokenEqual('a'.repeat(40),'a'.repeat(39)+'b'),false);
});

test('email handler durably stages MIME and queues only metadata',async()=>{
  const {env,writes,queued}=environment();
  const raw=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('Test email'));controller.close();}});
  await handler.email({to:alias.toUpperCase(),rawSize:10,raw,headers:new Headers({'subject':marker})},env);
  assert.equal(writes.length,1);
  assert.equal(queued.length,1);
  assert.equal(queued[0].alias,alias);
  assert.equal(queued[0].marker,marker.toLowerCase());
  assert.equal(queued[0].key,writes[0]);
  assert.equal('raw' in queued[0],false);
});

test('rejects out-of-domain and oversized messages without queuing',async()=>{
  const {env,writes,queued}=environment();
  const refused=[];
  await handler.email({to:'bad@other.test',rawSize:5,setReject:v=>refused.push(v)},env);
  await handler.email({to:alias,rawSize:26*1024*1024,setReject:v=>refused.push(v)},env);
  assert.equal(refused.length,2);
  assert.equal(writes.length,0);
  assert.equal(queued.length,0);
});

test('queue stores idempotent receipt metadata and acknowledges valid events',async()=>{
  const {env,writes,queued,records}=environment();
  const raw=new ReadableStream({start(c){c.close();}});
  await handler.email({to:alias,rawSize:0,raw,headers:new Headers({'x-aco-test-id':marker})},env);
  let acked=0;
  await handler.queue({messages:[{body:queued[0],ack:()=>acked++,retry:()=>assert.fail('unexpected retry')}]},env);
  assert.equal(acked,1);
  assert.equal(records.length,1);
  assert.match(records[0].sql,/INSERT OR IGNORE/);
});

test('invalid messages are retried rather than acknowledged',async()=>{
  const {env}=environment();let retry=0;
  await handler.queue({messages:[{body:{id:'fake'},ack:()=>assert.fail('unexpected ack'),retry:()=>retry++}]},env);
  assert.equal(retry,1);
});

test('health and receipt APIs require an admin token',async()=>{
  const {env}=environment();
  const unauth=await handler.fetch(new Request('https://worker.example/v1/health'),env);
  assert.equal(unauth.status,401);
  const auth={'Authorization':'Bearer '+env.ADMIN_API_TOKEN};
  const health=await handler.fetch(new Request('https://worker.example/v1/health',{headers:auth}),env);
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{ok:true,receivedLastHour:0});
  const receipt=await handler.fetch(new Request('https://worker.example/v1/receipt?alias='+encodeURIComponent(alias)+'&marker='+encodeURIComponent(marker),{headers:auth}),env);
  assert.equal(receipt.status,200);
  assert.equal((await receipt.json()).verified,false);
});
