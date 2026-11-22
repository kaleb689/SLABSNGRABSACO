'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {listArchive,normalizeAlias}=require('../emailgen-archive');
const config={accountId:'a'.repeat(32),token:'OWNER-TEST-TOKEN'};
function mock(result=[{results:[{id:'a'.repeat(8)+'-1111-4111-8111-'+'b'.repeat(12),alias:'example@sng.sarl',received_ms:1795000000000,size_bytes:7217,kind:'other',expires_ms:1797592000000}]}]){
 const calls=[];
 const request=async(url,init)=>{calls.push({url,init});return {ok:true,status:200,json:async()=>({success:true,result:url.includes('/query')?result:[{name:'sng-inbound-index',uuid:'b'.repeat(32)}]})};};
 return {request,calls};
}
test('lists owner D1 receipts with bounded request and no email bodies',async()=>{
 const {request,calls}=mock();
 const result=await listArchive(config,{limit:10000},request);
 assert.equal(result.provider,'cloudflare-d1');
 assert.equal(result.messages.length,1);
 assert.equal(result.messages[0].alias,'example@sng.sarl');
 assert.equal(result.messages[0].sizeBytes,7217);
 assert.ok(!('body' in result.messages[0]));
 assert.equal(JSON.parse(calls[1].init.body).params.at(-1),100);
});
test('filters by exact validated alias using SQL parameters',async()=>{
 const {request,calls}=mock();
 await listArchive(config,{alias:'Example@sng.sarl',limit:25},request);
 const query=JSON.parse(calls[1].init.body);
 assert.match(query.sql,/WHERE r.alias=\?/);
 assert.deepEqual(query.params,['example@sng.sarl',25]);
 assert.throws(()=>normalizeAlias("a@sng.sarl' OR 1=1 --"),/complete/);
});
test('limits excessive input and redacts arbitrary D1 columns',async()=>{
 const {request,calls}=mock([{results:[{id:'not-a-uuid',alias:'example@sng.sarl',token:'DO-NOT-LEAK'}]}]);
 const result=await listArchive(config,{limit:999},request);
 assert.equal(result.messages.length,0);
 assert.equal(JSON.parse(calls[1].init.body).params[0],100);
});
