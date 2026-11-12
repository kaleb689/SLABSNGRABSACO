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
function harness(rows,profiles,{forceNoDelivery=false}={}){
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
    const results=request.aliases.map(alias=>({alias,status:forceNoDelivery||alias.startsWith('bad')?'unconfirmed':'delivered'}));
    return {results,delivered:results.filter(x=>x.status==='delivered').length,sentButUnconfirmed:results.filter(x=>x.status==='unconfirmed').length,rateLimited:false,cleanupPending:0};
   }}),
  $e:get,document:{createElement:tag=>elem(tag)},setTimeout:(fn)=>{fn();return 1;},
  emailBatchGroups:()=>[{key:'batch:batch-1',rows}],emailBatchCurrentGroup:()=>({key:'batch:batch-1',rows}),
  store:async()=>{saved.push(rows.filter(x=>x.forwardingTestedAt).length);return true;},
  refreshEmailBatchUI:()=>{rendered.push(1);}};
 vm.createContext(ctx);vm.runInContext(app.slice(begin,end)+';this.run=runAutomaticEmailTests;this.testState=mailTestState;',ctx);
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
 assert.equal(h.saved.length,5,'encrypted bank saved once per preflight/group, never once per message');
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
 assert.match(h.get('randomTestStatus').textContent,/Automatic test pending/);
 assert.equal(h.get('randomTestSettings').open,true);
});

test('Catch-all preflight stops after 3 unconfirmed messages and leaves all other aliases untouched',async()=>{
 const rows=Array.from({length:405},(_,i)=>({alias:'draft'+i+'@sng.sarl',randomGenerated:true,target:'inbox@gmail.com',status:'draft',poolTarget:null}));
 const profiles=[{mailbox:'inbox@gmail.com',sender:'sender@gmail.com',smtpHost:'smtp.gmail.com',imapHost:'imap.gmail.com',senderImapHost:'imap.gmail.com'}];
 const h=harness(rows,profiles,{forceNoDelivery:true});
 await h.ctx.run({all:true});
 assert.deepEqual(h.calls.map(call=>call.aliases.length),[3],'no mass testing when first 3 do not reach Inbox');
 assert.equal(h.ctx.testState.done,3);
 assert.equal(h.ctx.testState.unconfirmed,3);
 assert.equal(h.ctx.testState.failed,0);
 assert.equal(h.ctx.testState.paused,true);
 assert.equal(h.ctx.testState.passed,0);
 assert.equal(rows.filter(r=>r.status==='draft').length,405);
 assert.equal(h.saved.length,1);
 assert.match(h.get('randomTestStatus').textContent,/Cloudflare catch-all is Active/);
 assert.match(h.get('randomTestStatus').textContent,/Spam\/All Mail/);
 assert.equal(h.get('randomTestUnconfirmed').textContent,'3');
 assert.equal(h.get('randomTestFailed').textContent,'0');
});
