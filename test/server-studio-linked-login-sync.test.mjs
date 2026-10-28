import test from 'node:test';
import assert from 'node:assert/strict';
import {registerStudioLinkedLoginSync} from '../server-studio-linked-login-sync.js';

function harness(){
 let handler,events=[],saves=0;
 let accounts=[
  {id:'managed-1',credentials:JSON.stringify({walmart:{username:'old@example.test',password:'keep-password'},target:{username:'target@example.test',password:'keep-target'}}),updatedAt:'managed-v1'},
  {id:'managed-2',credentials:JSON.stringify({walmart:{username:'other@example.test',password:'other-password'}})}
 ];
 const free=[
  {managedAccountId:'managed-1',customerAccountId:'customer-a',assignmentRetailer:'walmart',updatedAt:'assign-v1',active:true},
  {managedAccountId:'managed-2',customerAccountId:'customer-b',assignmentRetailer:'walmart',updatedAt:'assign-v2',active:true}
 ];
 registerStudioLinkedLoginSync({
  app:{post:(path,...fns)=>{assert.match(path,/linked-retailer-login/);handler=fns.at(-1);}},
  requireAdmin:()=>{},serialize:()=>{},
  getManagedAccounts:async()=>accounts,saveManagedAccounts:async next=>{accounts=next;saves++;},
  getAssignments:async type=>type==='free'?free:[],
  normalizeRetailerCredentials:credentials=>structuredClone(credentials),
  encryptJson:x=>JSON.stringify(x),decryptJson:JSON.parse,
  managedAssignmentIsLinked:a=>a.active===true&&!!a.customerAccountId,
  broadcastLiveDataChange:e=>events.push(e)
 });
 async function request(body,params={type:'free',id:'managed-1'}){
  const response={code:200,headers:{},set(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},
   json(result){this.body=result;return result;}};
  await handler({body,params},response);return response;
 }
 const valid={confirmed:true,retailer:'walmart',expectedCustomerAccountId:'customer-a',expectedUpdatedAt:'assign-v1',expectedEmail:'old@example.test',newEmail:'new@example.test'};
 return {request,valid,free,events,get accounts(){return accounts;},get saves(){return saves;}};
}
test('exact linked Walmart account corrects retailer login while preserving other data and broadcasting to site/app',async()=>{
 const h=harness(),response=await h.request(h.valid);
 assert.equal(response.code,200);assert.equal(response.body.saved,true);
 assert.equal(response.body.newEmail,'new@example.test');
 assert.ok(!JSON.stringify(response.body).includes('keep-password'));
 assert.equal(h.saves,1);assert.deepEqual(h.events,['linked-retailer-login-corrected']);
 const current=JSON.parse(h.accounts[0].credentials);
 assert.equal(current.walmart.username,'new@example.test');
 assert.equal(current.walmart.password,'keep-password');
 assert.equal(current.target.username,'target@example.test');
 assert.equal(h.free[0].customerAccountId,'customer-a');
 assert.equal(JSON.parse(h.accounts[1].credentials).walmart.username,'other@example.test');
});
test('wrong customer, stale assignment, wrong retailer and mismatched old email fail without changing records',async()=>{
 for(const change of [
  {expectedCustomerAccountId:'customer-b'},
  {expectedUpdatedAt:'stale'},
  {retailer:'target'},
  {expectedEmail:'incorrect@example.test'}
 ]){
  const h=harness(),before=JSON.stringify(h.accounts);
  const response=await h.request({...h.valid,...change});
  assert.equal(response.code,409);
  assert.equal(h.saves,0);assert.equal(JSON.stringify(h.accounts),before);
 }
});
test('cannot take a retailer login already stored on another account',async()=>{
 const h=harness();
 const response=await h.request({...h.valid,newEmail:'other@example.test'});
 assert.equal(response.code,409);assert.equal(h.saves,0);
});
test('cannot change an account without explicit confirmed old/new email and exact assignment ID',async()=>{
 const h=harness();
 for(const [body,params] of [[{...h.valid,confirmed:false},undefined],[{...h.valid,newEmail:'x'},undefined],[h.valid,{type:'free',id:'nonexistent'}]]){
  const result=await h.request(body,params);
  assert.ok(result.code>=400);
 }
 assert.equal(h.saves,0);
});
test('optional explicit password update never changes unrelated encrypted retailer credentials',async()=>{
 const h=harness();const response=await h.request({...h.valid,newPassword:'replacement-pass'});
 assert.equal(response.code,200);assert.equal(JSON.parse(h.accounts[0].credentials).walmart.password,'replacement-pass');
 assert.equal(JSON.parse(h.accounts[0].credentials).target.password,'keep-target');
});
