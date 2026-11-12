'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),app=fs.readFileSync(path.join(root,'app.js'),'utf8'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const start=app.indexOf(' const emailBatchState='),end=app.indexOf(' function refreshEmailBatchUI(){',start);
const helper=app.slice(start,end);
test('Email Bank right panel has live/verified totals, created batches, selection, export and confirmation',()=>{
 assert.ok(start>0&&end>start,'batch manager injected inside owner encrypted closure');
 for(const id of ['emailBankTotalCount','emailBankLiveCount','emailBankVerifiedCount','emailBankPendingCount',
  'emailBatchSelect','emailBatchMeta','emailBatchRows','emailBatchSelectVerified','emailBatchSelectAll',
  'emailBatchClear','emailBatchSelectReady','emailBatchSearch','emailBatchFilter','emailBatchPrev','emailBatchNext',
  'emailBatchSelectedCount','emailBatchExportFormat','emailBatchExport','emailBatchRetailer',
  'emailBatchPoolReview','emailBatchPoolConfirmArea','emailBatchPoolConfirm','emailBatchPoolCancel'])
  assert.ok(html.includes('id="'+id+'"'),id);
 assert.ok(html.indexOf('id="emailBatchManager"')<html.indexOf('id="bankSearch"'),'dashboard precedes old bank table');
 assert.match(app,/setupEmailBatchUI\(\)/);
 assert.match(app,/refreshEmailBatchUI\(\)/);
 assert.match(app,/batchId:typeof r\.batchId/);
 assert.match(app,/batchCreatedAt:typeof r\.batchCreatedAt/);
 assert.match(app,/chooser\.hidden=true/,'legacy assign all disabled');
 assert.match(app,/sync\.hidden=true/,'legacy publish all disabled');
});
test('Old 500 generated emails are one creation-date batch, with stable numbering and no mutation',()=>{
 const old=Array.from({length:500},(_,i)=>({alias:'email'+i+'@sng.sarl',randomGenerated:true,createdAt:new Date(Date.parse('2026-11-12T15:00:00Z')+i*18).toISOString(),status:'draft',poolTarget:null}));
 const newest=Array.from({length:20},(_,i)=>({alias:'next'+i+'@sng.sarl',randomGenerated:true,batchId:'generation2',batchCreatedAt:'2026-11-12T15:30:00Z',createdAt:'2026-11-12T15:30:00Z',status:'draft'}));
 const original=JSON.stringify([...old,...newest]);
 const ctx={records:[...old,...newest],RANDOM_RETAILERS:{target:'Target'}};
 vm.createContext(ctx);vm.runInContext(helper+';this.groups=emailBatchGroups();',ctx);
 const first=ctx.groups.find(g=>g.rows.length===500),second=ctx.groups.find(g=>g.rows.length===20);
 assert.equal(first.name,'11-12 Batch 1 (500)');
 assert.equal(second.name,'11-12 Batch 2 (20)');
 assert.equal(first.rows[0].alias,'email0@sng.sarl');
 assert.equal(JSON.stringify(ctx.records),original,'reading and grouping never rewrites old bank entries');
});
test('New creation batches have stable IDs; manual aliases never appear as generated batches',()=>{
 const ctx={records:[{alias:'manual@sng.sarl',status:'live'},
  {alias:'a@sng.sarl',randomGenerated:true,batchId:'batch-1',batchCreatedAt:'2026-11-12T15:00:00Z',status:'draft'},
  {alias:'b@sng.sarl',randomGenerated:true,batchId:'batch-1',batchCreatedAt:'2026-11-12T15:00:00Z',status:'draft'}]};
 vm.createContext(ctx);vm.runInContext(helper+';this.groups=emailBatchGroups();',ctx);
 assert.equal(ctx.groups.length,1);
 assert.equal(ctx.groups[0].rows.length,2);
 assert.equal(ctx.groups[0].name,'11-12 Batch 1 (2)');
});
test('Reviewed pool import refuses any unverified selected email; imports only confirmed exact aliases',async()=>{
 const target='owner@example.com',createdAt='2026-11-12T15:00:00Z';
 const records=[{alias:'verified@sng.sarl',randomGenerated:true,batchId:'batch-a',batchCreatedAt:createdAt,target,
   status:'live',forwardingTestedAt:createdAt,forwardingTestTarget:target,poolTarget:null,poolImportedAt:null},
  {alias:'draft@sng.sarl',randomGenerated:true,batchId:'batch-a',batchCreatedAt:createdAt,target,status:'draft',poolTarget:null,poolImportedAt:null}];
 const controls=Object.fromEntries(['emailBatchPoolConfirmArea','emailBatchPoolSummary','emailBatchActionStatus','emailBatchPoolConfirm']
  .map(id=>[id,{hidden:true,textContent:'',disabled:false}]));
 controls.emailBatchRetailer={value:'target'};
 let importCalls=0,saved=0;
 const ctx={records,unlocked:true,randomGenBusy:false,requireOwner(){},RANDOM_RETAILERS:{target:'Target'},
  $e:id=>controls[id]||null,window:{JigPersonalGuard:{ensureUnlocked:async()=>true},
   desktopAPI:{profileWorkshop:{importEmails:async payload=>{
    importCalls++;
    assert.equal(payload.scope,'personal');assert.equal(payload.customerId,null);
    assert.equal(payload.retailer,'target');assert.deepEqual([...payload.emails],['verified@sng.sarl']);
    return {added:1,skipped:0,invalid:0};
   }}}},store:async()=>{saved++;return true;},Date,Set,
  document:{dispatchEvent:()=>{}},CustomEvent:class{}};
 vm.createContext(ctx);
 const fullEnd=app.indexOf(' function setupEmailBatchUI(){',start);
 vm.runInContext(app.slice(start,fullEnd)+';refreshEmailBatchUI=()=>{};emailBatchState.key="batch:batch-a";emailBatchState.selected=new Set(["verified@sng.sarl","draft@sng.sarl"]);',ctx);
 assert.throws(()=>vm.runInContext('emailBatchReviewPool()',ctx),/unverified emails/);
 assert.equal(importCalls,0);assert.equal(records[0].poolTarget,null);
 vm.runInContext('emailBatchState.selected=new Set(["verified@sng.sarl"]);emailBatchReviewPool();',ctx);
 assert.equal(controls.emailBatchPoolConfirmArea.hidden,false);
 await vm.runInContext('emailBatchConfirmPool()',ctx);
 assert.equal(importCalls,1);assert.equal(saved,1);
 assert.equal(records[0].poolTarget,'target');assert.ok(records[0].poolImportedAt);
 assert.equal(records[1].poolTarget,null);assert.equal(records[1].status,'draft');
 assert.match(controls.emailBatchActionStatus.textContent,/No unverified emails or other batches were added/);
});
test('Export only uses explicit selection; no Cloudflare publish or silent pool action',()=>{
 const source=app.slice(start,app.indexOf(' function setupEmailBatchUI(){',start));
 assert.match(source,/chosen=emailBatchSelectedRows\(group\)/);
 assert.match(source,/buildEmailGenExportCsv\(chosen,mode\)/);
 assert.match(source,/emailBatchReviewPool\(\)/);
 assert.match(source,/emailBatchConfirmPool\(\)/);
 assert.doesNotMatch(source,/api\(\)\.publish/);
 assert.match(source,/if\(chosen\.some\(r=>!batchVerified\(r\)\)\)/);
 assert.match(source,/importEmails/);
});


test('Only the exact chosen batch is deleted after typed confirmation and verified ciphertext backup',async()=>{
 const rows=[
  {alias:'one@sng.sarl',randomGenerated:true,batchId:'batch-delete',batchCreatedAt:'2026-11-12T15:00:00Z',status:'draft',poolTarget:null},
  {alias:'two@sng.sarl',randomGenerated:true,batchId:'batch-delete',batchCreatedAt:'2026-11-12T15:00:00Z',status:'live',remoteId:'cloudflare-id',poolTarget:null},
  {alias:'untouched@sng.sarl',randomGenerated:true,batchId:'batch-keep',batchCreatedAt:'2026-11-12T15:30:00Z',status:'draft'},
  {alias:'manual@sng.sarl',randomGenerated:false,status:'live'}
 ];
 const encrypted='ciphertext-only-contents',storage=new Map([['email.bank',encrypted]]);
 const controls=new Map(),get=id=>{
  if(!controls.has(id))controls.set(id,{textContent:'',hidden:false,checked:false,value:''});
  return controls.get(id);
 };
 const ctx={records:rows,randomGenBusy:false,unlocked:true,mailTestState:{active:false},requireOwner(){},Date,Set,Map,KEY:'email.bank',
  crypto:{getRandomValues:b=>{b.fill(7);return b;}},localStorage:{getItem:k=>storage.has(k)?storage.get(k):null,setItem:(k,v)=>storage.set(k,v)},
  $e:get,refreshEmailBatchUI:()=>{},RANDOM_RETAILERS:{target:'Target'},store:async()=>{storage.set('email.bank','new-encrypted-bank');return true;}};
 vm.createContext(ctx);
 const end=app.indexOf(' function setupEmailBatchUI(){',start);
 vm.runInContext(app.slice(start,end)+";refreshEmailBatchUI=()=>{};emailBatchState.key='batch:batch-delete';this.review=reviewEmailBatchDeletion;this.deleteBatch=confirmEmailBatchDeletion;",ctx);
 ctx.review();
 assert.equal(get('emailBatchDeleteConfirmArea').hidden,false);
 assert.match(get('emailBatchDeleteSummary').textContent,/Cloudflare/);
 assert.equal(rows.length,4,'preview never deletes');
 await assert.rejects(ctx.deleteBatch(),/Type DELETE/);
 get('emailBatchDeleteTyped').value='DELETE';
 get('emailBatchDeleteAcknowledge').checked=true;
 await ctx.deleteBatch();
 assert.deepEqual(rows.map(x=>x.alias),['untouched@sng.sarl','manual@sng.sarl']);
 assert.ok([...storage.keys()].some(key=>key.startsWith('email.bank.batch-delete-backup.')));
 assert.ok([...storage.values()].includes(encrypted));
 assert.match(get('emailBatchActionStatus').textContent,/Cloudflare/);
});
test('Batch deletion refuses retailer-assigned records even if they are generated',()=>{
 assert.match(html,/id="emailBatchDeleteReview"/);
 assert.match(html,/id="emailBatchDeleteTyped"/);
 assert.match(html,/id="emailBatchDeleteAcknowledge"/);
 assert.match(app,/group\.rows\.filter\(r=>Boolean\(r\.poolTarget\)\|\|Boolean\(r\.poolImportedAt\)\)/);
 assert.match(app,/if\(mailTestState\.active\|\|randomGenBusy\)/);
 assert.match(app,/localStorage\.setItem\(backupKey,previous\)/);
 assert.doesNotMatch(app.slice(app.indexOf(' function reviewEmailBatchDeletion'),app.indexOf(' function setupEmailBatchUI')),/api\(\)\.publish/);
});
