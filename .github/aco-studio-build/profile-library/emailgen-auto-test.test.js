'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),app=fs.readFileSync(path.join(root,'app.js'),'utf8'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const begin=app.indexOf(" const MAIL_TEST_CATCHALL_PREF="),end=app.indexOf(" function addEvents(){",begin);
test('Expanded right Email Bank owns the entire saved-credential and automated testing interface',()=>{
 assert.ok(begin>0&&end>begin,'auto worker injected into encrypted owner closure');
 assert.ok(html.indexOf('id="emailBatchManager"')<html.indexOf('id="randomAliasTestArea"'));
 assert.ok(html.indexOf('id="randomAliasTestArea"')<html.indexOf('id="bankSearch"'));
 assert.equal((html.match(/id="randomAliasTestArea"/g)||[]).length,1);
 for(const id of ['randomTestProgress','randomTestPassed','randomTestFailed','randomTestUnconfirmed','randomTestGreenBar','randomTestAmberBar','randomTestRedBar','randomTestRecent',
 'randomAliasTestAll','randomAliasTestBatch','randomAliasTestStop','randomTestSettings','randomMailPreset','randomTestReceiver',
 'randomTestSender','randomTestSenderPassword','randomTestPassword','randomTestSenderImap','randomMailCredentialsSave',
 'randomMailCredentialsForget','randomAliasCatchAllTest'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(app,/scheduleNewBatchAutoTest\(batchId\)/);
 assert.match(app,/AUTO_TEST_GROUP_SIZE=25/);
 assert.match(app,/AUTO_TEST_PREFLIGHT_SIZE=3/);
 assert.match(app,/mailTestState\.active=true/);
 assert.match(app,/mailTestState\.cancel=true/);
 assert.match(app,/if\(response\.rateLimited\)/);
 assert.match(app,/onEmailTestProgress/);
 assert.match(app,/forgetMailTestCredentials/);
 assert.match(app,/saveMailTestCredentials\(settings\)/);
 assert.doesNotMatch(app.slice(begin,end),/api\(\)\.publish/,'tests must not publish Cloudflare rules');
});
function elem(value=''){
 return {value,textContent:'',dataset:{},style:{},disabled:false,hidden:false,checked:false,open:false,
  children:[],replaceChildren(){this.children=[];},appendChild(child){this.children.push(child);},
  setAttribute(){},addEventListener(){}};
}
function harness(rows,profiles,{forceNoDelivery=false,rateLimitSender=null}={}){
 const widgets=new Map(),get=id=>{if(!widgets.has(id))widgets.set(id,elem());return widgets.get(id);};
 const inbox=rows[0]?.target||'';
 get('randomTestReceiver').value=inbox;
 const receiverFlags=Object.fromEntries([...new Set(rows.map(x=>x.target))].map(x=>[x,true]));
 const state=new Map([['aco.emailgen.catchall.preferences.v1',JSON.stringify(receiverFlags)]]);
 const calls=[],saved=[],rendered=[];
 const ctx={records:rows,unlocked:true,randomGenBusy:false,requireOwner(){},validEmail:v=>/^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(v),
  crypto:{getRandomValues:buffer=>{buffer.fill(2);return buffer;}},Uint8Array,Date,Map,Set,
  localStorage:{getItem:key=>state.get(key)||null,setItem:(key,value)=>state.set(key,value)},
  api:()=>({mailTestCredentialStatus:async()=>({saved:profiles.length>0,profiles}),
   testForwarding:async request=>{
    calls.push(request);
    const results=request.aliases.map((alias,i)=>({alias,status:request.sender===rateLimitSender?(i===0?'send_failed':'not_attempted'):forceNoDelivery||alias.startsWith('bad')?'unconfirmed':'delivered'}));
    return {results,delivered:results.filter(x=>x.status==='delivered').length,sentButUnconfirmed:results.filter(x=>x.status==='unconfirmed').length,rateLimited:request.sender===rateLimitSender,cleanupPending:0};
   }}),
  $e:get,document:{createElement:tag=>elem(tag)},setTimeout:(fn)=>{fn();return 1;},
  emailBatchGroups:()=>[{key:'batch:batch-1',rows}],emailBatchCurrentGroup:()=>({key:'batch:batch-1',rows}),
  store:async()=>{saved.push(rows.filter(x=>x.forwardingTestedAt).length);return true;},
  refreshEmailBatchUI:()=>{rendered.push(1);},refreshRandomChooser:()=>{},KEY:'email.bank'};
 vm.createContext(ctx);vm.runInContext(app.slice(begin,end)+';this.run=runAutomaticEmailTests;this.testState=mailTestState;this.loadPairs=loadSavedMailPairs;this.previewSplit=previewReceiverSplit;this.commitSplit=commitReceiverSplit;',ctx);
 return {ctx,calls,saved,rendered,widgets,get};
}
test('One automatic run loops through all 57 aliases and correctly selects two saved recipient/sender pairs without hand-clicking',async()=>{
 const rows=Array.from({length:57},(_,i)=>({alias:(i===56?'bad':'a')+i+'@sng.sarl',randomGenerated:true,
  batchId:'batch-1',target:i<35?'one@gmail.com':'two@gmail.com',status:'draft',poolTarget:null}));
 const profiles=[
  {mailbox:'one@gmail.com',sender:'send1@gmail.com',smtpHost:'smtp.gmail.com',imapHost:'imap.gmail.com',senderImapHost:'imap.gmail.com',updatedAt:'2026-11-12T12:00:00Z'},
  {mailbox:'two@gmail.com',sender:'send2@gmail.com',smtpHost:'smtp.gmail.com',imapHost:'imap.gmail.com',senderImapHost:'imap.gmail.com',updatedAt:'2026-11-12T12:01:00Z'}
 ];
 const h=harness(rows,profiles);await h.ctx.run({all:true});
 assert.deepEqual(h.calls.map(call=>call.aliases.length),[3,25,7,3,19]);
 assert.deepEqual(h.calls.map(call=>[call.mailbox,call.sender]),[
  ['one@gmail.com','send1@gmail.com'],['one@gmail.com','send1@gmail.com'],['one@gmail.com','send1@gmail.com'],
  ['two@gmail.com','send2@gmail.com'],['two@gmail.com','send2@gmail.com']]);
 assert.equal(h.ctx.testState.passed,56);
 assert.equal(h.ctx.testState.failed,0);
 assert.equal(h.ctx.testState.unconfirmed,1);
 assert.equal(h.ctx.testState.done,57);
 assert.equal(h.ctx.testState.active,false);
 assert.equal(rows.filter(row=>row.status==='live'&&row.forwardingTestedAt).length,56);
 assert.equal(rows.find(row=>row.alias.startsWith('bad')).status,'draft');
 assert.ok(rows.every(row=>!row.poolTarget));
 assert.equal(h.saved.length,1,'only one encrypted save for 57 results; no synchronous full table redraw per group');
 assert.equal(h.rendered.length,1,'heavy Email Bank table refreshed only once after the run finishes');
 assert.equal(h.get('randomTestProgress').textContent,'57/57');
 assert.equal(h.get('randomTestPassed').textContent,'56');
 assert.equal(h.get('randomTestFailed').textContent,'0');
 assert.equal(h.get('randomTestUnconfirmed').textContent,'1');
});
test('Missing sender/receiver passwords never marks drafts working and invites secure setup',async()=>{
 const rows=[{alias:'unused@sng.sarl',target:'different@gmail.com',randomGenerated:true,status:'draft'}];
 const h=harness(rows,[]);await h.ctx.run({all:true});
 assert.equal(h.calls.length,0);
 assert.equal(h.ctx.testState.passed,0);
 assert.equal(rows[0].status,'draft');
 assert.match(h.get('randomTestStatus').textContent,/NO EMAILS TESTED/);
 assert.equal(h.get('randomTestSettings').open,true);
});

test('Test All Unverified continues past 3 unconfirmed receipts without freezing or falsely marking delivery',async()=>{
 const rows=Array.from({length:405},(_,i)=>({alias:'draft'+i+'@sng.sarl',randomGenerated:true,target:'inbox@gmail.com',status:'draft',poolTarget:null}));
 const profiles=[{mailbox:'inbox@gmail.com',sender:'sender@gmail.com',smtpHost:'smtp.gmail.com',imapHost:'imap.gmail.com',senderImapHost:'imap.gmail.com'}];
 const h=harness(rows,profiles,{forceNoDelivery:true});
 await h.ctx.run({all:true});
 assert.equal(h.calls[0].aliases.length,3,'small preflight remains as a routing warning');
 assert.equal(h.calls.reduce((n,call)=>n+call.aliases.length,0),405,'a failed preflight does not prevent testing the remaining 402');
 assert.equal(h.ctx.testState.done,405);
 assert.equal(h.ctx.testState.unconfirmed,405);
 assert.equal(h.ctx.testState.failed,0);
 assert.equal(h.ctx.testState.passed,0);
 assert.equal(h.ctx.testState.paused,false);
 assert.equal(rows.filter(r=>r.status==='draft').length,405);
 assert.ok(h.saved.length<=6,'encryption writes batched rather than performed after every 25 messages');
 assert.equal(h.rendered.length,1,'one heavy Email Bank redraw for the entire run');
 assert.match(h.get('randomTestStatus').textContent,/full queue was still processed/);
 assert.match(h.get('randomTestStatus').textContent,/405\/405 completed/);
});
test('New 400-alias batch is tested independently of a previously failing older email',async()=>{
 const older={alias:'old-bad@sng.sarl',randomGenerated:true,batchId:'old',target:'inbox@gmail.com',status:'draft'};
 const newRows=Array.from({length:400},(_,i)=>({alias:'new'+i+'@sng.sarl',randomGenerated:true,batchId:'new',target:'inbox@gmail.com',status:'draft'}));
 const rows=[older,...newRows],profiles=[{mailbox:'inbox@gmail.com',sender:'sender@gmail.com'}];
 const h=harness(rows,profiles);
 h.ctx.emailBatchGroups=()=>[{key:'batch:new',rows:newRows},{key:'batch:old',rows:[older]}];
 await h.ctx.run({batchId:'new'});
 assert.equal(h.ctx.testState.total,400);
 assert.equal(h.ctx.testState.passed,400);
 assert.equal(h.ctx.testState.done,400);
 assert.equal(older.forwardingTestedAt,undefined,'older failed record untouched');
 assert.ok(h.calls.every(call=>call.aliases.every(alias=>alias.startsWith('new'))));
});
test('Unconfigured draft aliases do not reuse last progress or falsely report success',async()=>{
 const rows=[{alias:'new@sng.sarl',randomGenerated:true,batchId:'batch-1',target:'inbox@gmail.com',status:'draft'}];
 const profiles=[{mailbox:'inbox@gmail.com',sender:'sender@gmail.com'}];
 const h=harness(rows,profiles);
 h.ctx.localStorage.setItem('aco.emailgen.catchall.preferences.v1','{}');
 h.ctx.testState.total=1;h.ctx.testState.done=1;h.ctx.testState.failed=1;
 await h.ctx.run({all:true});
 assert.equal(h.calls.length,0);
 assert.equal(h.ctx.testState.total,0);
 assert.equal(h.ctx.testState.done,0);
 assert.equal(h.ctx.testState.failed,0);
 assert.match(h.get('randomTestStatus').textContent,/NO EMAILS TESTED/);
 assert.match(h.get('randomTestStatus').textContent,/catch-all/);
});
test('Testing controls include a direct batch chooser',()=>{
 assert.match(html,/id="randomTestBatchSelect"/);
 assert.match(html,/id="emailBatchRemoveOneReview"/);
 assert.match(html,/id="emailBatchRemoveOneConfirm"/);
 assert.match(app,/batchId:group\.key\.slice\(6\)/);
});

test('Two checked batches are tested together, without including unchecked batch or prior failed address',async()=>{
 const a=Array.from({length:20},(_,i)=>({alias:'multi-a'+i+'@sng.sarl',randomGenerated:true,batchId:'a',target:'inbox@gmail.com',status:'draft'}));
 const b=Array.from({length:15},(_,i)=>({alias:'multi-b'+i+'@sng.sarl',randomGenerated:true,batchId:'b',target:'inbox@gmail.com',status:'draft'}));
 const older=[{alias:'older@sng.sarl',randomGenerated:true,batchId:'older',target:'inbox@gmail.com',status:'draft'}];
 const h=harness([...a,...b,...older],[{mailbox:'inbox@gmail.com',sender:'sender@gmail.com'}]);
 h.ctx.emailBatchGroups=()=>[{key:'batch:a',rows:a},{key:'batch:b',rows:b},{key:'batch:older',rows:older}];
 await h.ctx.run({batchKeys:['batch:a','batch:b']});
 assert.equal(h.ctx.testState.total,35);
 assert.equal(h.ctx.testState.passed,35);
 assert.equal(older[0].forwardingTestedAt,undefined);
 assert.ok(h.calls.every(c=>c.aliases.every(x=>x.startsWith('multi-'))));
});
test('A rate-limited sender is retired and untested aliases rotate to another selected verified sender',async()=>{
 const rows=Array.from({length:7},(_,i)=>({alias:'quota'+i+'@sng.sarl',randomGenerated:true,batchId:'batch-1',target:'inbox@gmail.com',status:'draft'}));
 const h=harness(rows,[
  {mailbox:'inbox@gmail.com',sender:'first@gmail.com',updatedAt:'2026-11-15T12:00:00Z'},
  {mailbox:'inbox@gmail.com',sender:'second@gmail.com',updatedAt:'2026-11-14T12:00:00Z'}
 ],{rateLimitSender:'first@gmail.com'});
 await h.ctx.run({all:true});
 assert.equal(h.ctx.testState.total,7);
 assert.equal(h.ctx.testState.passed,7);
 assert.equal(h.ctx.testState.paused,false);
 assert.equal(h.calls[0].sender,'first@gmail.com');
 assert.ok(h.calls.slice(1).every(x=>x.sender==='second@gmail.com'));
 assert.ok(rows.every(row=>row.forwardingTestedAt),'all aliases confirmed by actual test results');
});
test('Receiver split only changes unpublished, unassigned drafts after acknowledgement and preserves other fields',async()=>{
 const rows=[
  {alias:'split-a@sng.sarl',randomGenerated:true,batchId:'batch-1',target:'old@gmail.com',status:'draft',card:{last4:'1234'},profileSecurityCode:'005'},
  {alias:'split-b@sng.sarl',randomGenerated:true,batchId:'batch-1',target:'old@gmail.com',status:'draft',card:{last4:'9876'},profileSecurityCode:'003'},
  {alias:'live@sng.sarl',randomGenerated:true,batchId:'batch-1',target:'old@gmail.com',status:'live',remoteId:'published'},
  {alias:'linked@sng.sarl',randomGenerated:true,batchId:'batch-1',target:'old@gmail.com',status:'draft',poolTarget:'target'}
 ];
 const h=harness(rows,[
  {mailbox:'one@gmail.com',sender:'sender1@gmail.com'},
  {mailbox:'two@gmail.com',sender:'sender2@gmail.com'}
 ]);
 await h.ctx.loadPairs(true);
 h.ctx.testState.selectedBatchKeys=new Set(['batch:batch-1']);
 h.ctx.testState.selectedReceiverTargets=new Set(['one@gmail.com','two@gmail.com']);
 h.ctx.localStorage.setItem('email.bank','encrypted-old');
 h.ctx.previewSplit();
 assert.equal(h.get('randomReceiverSplitConfirmArea').hidden,false);
 assert.match(h.get('randomReceiverSplitSummary').textContent,/2 unpublished drafts/);
 h.get('randomReceiverSplitAck').checked=true;
 await h.ctx.commitSplit();
 assert.deepEqual(rows.slice(0,2).map(r=>r.target).sort(),['one@gmail.com','two@gmail.com']);
 assert.equal(rows[2].target,'old@gmail.com');
 assert.equal(rows[3].target,'old@gmail.com');
 assert.equal(rows[0].profileSecurityCode,'005');
 assert.equal(rows[1].profileSecurityCode,'003');
 assert.ok(!rows[0].forwardingTestedAt);
 assert.equal(h.calls.length,0,'no Cloudflare/SMTP calls from local split');
});
test('Receiver split refuses >200 unpublished aliases without route capacity or Worker',async()=>{
 const rows=Array.from({length:201},(_,i)=>({alias:'over'+i+'@sng.sarl',randomGenerated:true,batchId:'batch-1',target:'old@gmail.com',status:'draft'}));
 const h=harness(rows,[{mailbox:'one@gmail.com',sender:'send1@gmail.com'},{mailbox:'two@gmail.com',sender:'send2@gmail.com'}]);
 await h.ctx.loadPairs(true);
 h.ctx.testState.selectedBatchKeys=new Set(['batch:batch-1']);
 assert.throws(()=>h.ctx.previewSplit(),/200 individual routing rules/);
 assert.ok(rows.every(r=>r.target==='old@gmail.com'));
});

test('Single failed email does not interrupt the remaining batches or sender rotation',async()=>{
 const rows=[{alias:'bad0@sng.sarl',randomGenerated:true,batchId:'old',target:'inbox@gmail.com',status:'draft'},
  ...Array.from({length:100},(_,i)=>({alias:'works'+i+'@sng.sarl',randomGenerated:true,batchId:'new',target:'inbox@gmail.com',status:'draft'}))];
 const h=harness(rows,[{mailbox:'inbox@gmail.com',sender:'sender@gmail.com'}]);
 await h.ctx.run({all:true});
 assert.equal(h.ctx.testState.total,101);
 assert.equal(h.ctx.testState.done,101);
 assert.equal(h.ctx.testState.unconfirmed,1);
 assert.equal(h.ctx.testState.passed,100);
 assert.equal(rows[0].forwardingTestedAt,undefined);
 assert.ok(rows.slice(1).every(r=>r.forwardingTestedAt));
 assert.equal(h.rendered.length,1);
});
