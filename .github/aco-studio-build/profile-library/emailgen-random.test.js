'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
test('Quantity-only random Email Gen offers all five Personal unused retailer pools after creation',()=>{
 for(const id of ['randomAliasCount','randomAliasCreate','randomAliasPoolChooser','randomAliasPool','randomAliasAssign','randomAliasSync','randomAliasStatus','randomAliasTestAll','randomTestStatus'])
  assert.match(html,new RegExp('id="'+id+'"'));
 for(const retailer of ['target','walmart','pokemoncenter','costco','sams'])
  assert.match(html,new RegExp('<option value="'+retailer+'">'));
 assert.ok(html.indexOf('id="randomAliasCreate"')<html.indexOf('id="randomAliasPoolChooser"'));
 assert.match(html,/verified external IMAP inbox entered above/);
});
test('Random local parts use secure randomness; duplicates are checked without requesting names',()=>{
 const start=app.indexOf(' function randomLocal(){'),end=app.indexOf(' const unassignedRandom=',start);
 assert.ok(start>=0&&end>start);
 const script=app.slice(start,end);
 const crypt={getRandomValues:array=>{for(let i=0;i<array.length;i++)array[i]=i;return array;}};
 const value=vm.runInNewContext(script+'\nrandomLocal()', {crypto:crypt,Uint8Array,Array});
 assert.equal(value,'sng000102030405060708090a0b');
 assert.match(app,/new Set\(records\.map\(r=>r\.alias\)\)/);
 assert.match(app,/if\(\+\+attempts>100\)/);
 assert.match(app,/count<1\|\|count>100/);
 assert.match(app,/makeAlias\('Random '\+local,local,target,currentDomain\(\)\)/);
});
test('Encrypted Email Bank retains pool assignment and delivery test provenance across reload',()=>{
 for(const field of ['randomGenerated:r.randomGenerated===true','poolTarget:','poolImportedAt:','forwardingTestedAt:','forwardingTestTarget:'])assert.ok(app.includes(field),field);
 assert.match(app,/if\(!await store\(\)\)/);
 assert.match(app,/for\(const row of batch\)row\.poolTarget=retailer/);
 assert.match(app,/for\(const row of batch\)row\.poolTarget=null/);
});
test('Cloudflare live AND exact mailbox receipt are mandatory before Personal unused-pool import',()=>{
 assert.match(app,/unsyncedRandom\(\)\.filter\(r=>r\.status==='live'&&r\.forwardingTestedAt&&r\.forwardingTestTarget===r\.target\)/);
 assert.match(app,/profileWorkshop\?\.importEmails/);
 assert.match(app,/scope:'personal',customerId:null,retailer,emails:batch\.map\(r=>r\.alias\)/);
 assert.match(app,/JigPersonalGuard\?\.ensureUnlocked/);
 assert.match(app,/await api\(\)\.publish\(toPublish\.map/);
 assert.match(app,/api\(\)\?\.testForwarding/);
 assert.match(app,/forwardingTestedAt=new Date\(\)\.toISOString\(\)/);
});
test('Mail test credentials are temporary and never written to the encrypted Email Bank',()=>{
 assert.match(html,/id="randomTestPassword" type="password" autocomplete="off"/);
 assert.match(app,/\$e\('randomTestPassword'\)\.value=''/);
 assert.ok(!app.includes('poolTestPassword:'));
 assert.match(app,/No failed test was marked usable/);
});

test('Owner can preview bulk destination change for previously generated drafts without altering other aliases',()=>{
 for(const id of ['randomDestinationOld','randomDestinationNew','randomDestinationPreview','randomDestinationConfirmArea','randomDestinationSummary','randomDestinationAcknowledged','randomDestinationConfirm','randomDestinationCancel','randomDestinationStatus'])
  assert.match(html,new RegExp('id="'+id+'"'));
 const snippet=app.slice(app.indexOf(' const eligibleRandomDraft='),app.indexOf(' function refreshDraftDestinations(){'));
 assert.ok(snippet.startsWith(' const eligibleRandomDraft='));
 const rows=Array.from({length:100},(_,i)=>({alias:'alias'+i+'@sng.sarl',randomGenerated:true,status:'draft',target:'old@gmail.com',poolTarget:'target',poolImportedAt:null}));
 rows.push({alias:'manual@sng.sarl',randomGenerated:false,status:'draft',target:'old@gmail.com'});
 rows.push({alias:'live@sng.sarl',randomGenerated:true,status:'live',target:'old@gmail.com'});
 rows.push({alias:'pending@sng.sarl',randomGenerated:true,status:'pending',target:'old@gmail.com'});
 rows.push({alias:'imported@sng.sarl',randomGenerated:true,status:'draft',target:'old@gmail.com',poolImportedAt:new Date().toISOString()});
 const ctx={records:rows,requireOwner(){},validEmail:v=>/^[^@]+@[^@]+\.[^@]+$/.test(v),OWNER_DOMAIN:'sng.sarl'};
 vm.createContext(ctx);vm.runInContext(snippet,ctx);
 const plan=vm.runInContext("draftDestinationPlan('old@gmail.com','slabsaco@gmail.com')",ctx);
 assert.equal(plan.entries.length,100);
 assert.equal(rows.filter(x=>x.target==='old@gmail.com').length,104);
 assert.equal(plan.entries[0].poolTarget,'target');
 assert.throws(()=>vm.runInContext("draftDestinationPlan('old@gmail.com','old@gmail.com')",ctx),/already/);
});
test('Confirmed destination change creates a verified encrypted backup before touching the 100 existing drafts',async()=>{
 const rows=Array.from({length:100},(_,i)=>({alias:'alias'+i+'@sng.sarl',randomGenerated:true,status:'draft',target:'old@gmail.com',poolTarget:'target',poolImportedAt:null,forwardingTestedAt:null,forwardingTestTarget:null}));
 rows.push({alias:'manual@sng.sarl',randomGenerated:false,status:'draft',target:'old@gmail.com'});
 rows.push({alias:'live@sng.sarl',randomGenerated:true,status:'live',target:'old@gmail.com'});
 const KEY='owner.encrypted.email.bank',storage=new Map([[KEY,'encrypted-original-ciphertext']]);
 const ctx={records:rows,KEY,OWNER_DOMAIN:'sng.sarl',requireOwner(){},validEmail:v=>/^[^@]+@[^@]+\.[^@]+$/.test(v),
  crypto:{getRandomValues:a=>{a.fill(5);return a;}},Uint8Array,Date,
  localStorage:{getItem:k=>storage.has(k)?storage.get(k):null,setItem:(k,v)=>{storage.set(k,v);}},
  store:async()=>{assert.equal([...storage.keys()].filter(k=>k.includes('.destination-backup.')).length,1);
   assert.ok(rows.filter(x=>x.randomGenerated&&x.status==='draft').every(x=>x.target==='slabsaco@gmail.com'));
   storage.set(KEY,'encrypted-updated-ciphertext');return true;}};
 const snippet=app.slice(app.indexOf(' const eligibleRandomDraft='),app.indexOf(' function refreshDraftDestinations(){'));
 vm.createContext(ctx);vm.runInContext(snippet,ctx);
 const result=await vm.runInContext("changeDraftDestinations(draftDestinationPlan('old@gmail.com','slabsaco@gmail.com'))",ctx);
 assert.equal(result.changed,100);assert.equal(rows.filter(x=>x.target==='slabsaco@gmail.com').length,100);
 assert.equal(rows[0].alias,'alias0@sng.sarl');assert.equal(rows[0].poolTarget,'target');
 assert.equal(rows[100].target,'old@gmail.com');assert.equal(rows[101].target,'old@gmail.com');
 assert.equal([...storage.values()].filter(v=>v==='encrypted-original-ciphertext').length,1);
 assert.equal(storage.get(KEY),'encrypted-updated-ciphertext');
});
test('Failed encryption write and stale previews never lose the original encrypted bank or aliases',async()=>{
 const KEY='owner.encrypted.email.bank',rows=[{alias:'first@sng.sarl',randomGenerated:true,status:'draft',target:'old@gmail.com',poolTarget:'target',poolImportedAt:null}];
 const storage=new Map([[KEY,'old-encrypted-ciphertext']]),snippet=app.slice(app.indexOf(' const eligibleRandomDraft='),app.indexOf(' function refreshDraftDestinations(){'));
 const ctx={records:rows,KEY,OWNER_DOMAIN:'sng.sarl',requireOwner(){},validEmail:v=>/^[^@]+@[^@]+\.[^@]+$/.test(v),
  Uint8Array,Date,crypto:{getRandomValues:a=>{a.fill(9);return a;}},
  localStorage:{getItem:k=>storage.has(k)?storage.get(k):null,setItem:(k,v)=>storage.set(k,v)},
  store:async()=>{storage.set(KEY,'failed-partial-save');return false;}};
 vm.createContext(ctx);vm.runInContext(snippet,ctx);
 const plan=vm.runInContext("draftDestinationPlan('old@gmail.com','slabsaco@gmail.com')",ctx);
 await assert.rejects(vm.runInContext('changeDraftDestinations(plan)',Object.assign(ctx,{plan})),/not completed/);
 assert.equal(storage.get(KEY),'old-encrypted-ciphertext');assert.equal(rows[0].target,'old@gmail.com');
 assert.ok([...storage.keys()].some(x=>x.includes('.destination-backup.')));
 rows[0].status='live';
 await assert.rejects(vm.runInContext('changeDraftDestinations(plan)',ctx),/changed since preview|No unpublished/);
 assert.equal(rows[0].target,'old@gmail.com');
});
test('Bulk forwarding destination edit never publishes or creates aliases and requires confirmation',()=>{
 assert.match(app,/randomDestinationAcknowledged/);
 assert.match(app,/if\(!plan\|\|panel\.hidden\|\|!\$e\('randomDestinationAcknowledged'\)\.checked\)/);
 assert.match(app,/eligibleRandomDraft=r=>r\.randomGenerated===true&&r\.status==='draft'/);
 assert.match(app,/localStorage\.setItem\(backupKey,previous\)/);
 assert.match(app,/localStorage\.getItem\(backupKey\)!==previous/);
 assert.match(app,/if\(!await store\(\)\)throw Error\('The encrypted Email Bank could not be saved\.'\)/);
 const func=app.slice(app.indexOf(' async function changeDraftDestinations('),app.indexOf(' function refreshDraftDestinations(){'));
 assert.doesNotMatch(func,/api\(\)\.publish|makeAlias\(|records\.push\(|profileWorkshop\.importEmails/);
});


test('Email Gen provides an owner-only CSV download with a generic export password and sequential profile names',()=>{
 assert.match(html,/id="randomAliasExport"/);
 assert.match(html,/email,password,profile_name/);
 assert.match(app,/const EMAIL_GEN_EXPORT_PASSWORD='Freeshit1!'/);
 assert.match(app,/downloadEmailGenExport\(\)/);
 assert.match(app,/if\(!unlocked\)throw Error\('Unlock your encrypted owner Email Gen bank/);
 assert.match(app,/requireOwner\(\)/);
 const start=app.indexOf(" const EMAIL_GEN_EXPORT_PASSWORD=");
 const end=app.indexOf(" const unassignedRandom=",start);
 assert.ok(start>=0&&end>start,'export helper is in the owner-only Email Gen closure');
 const snippet=app.slice(start,end);
 const sample=[
  {alias:'sng0001@sng.sarl',randomGenerated:true,status:'draft'},
  {alias:'manual@sng.sarl',randomGenerated:false,status:'live'},
  {alias:'sng0003@sng.sarl',randomGenerated:true,status:'live'},
  {alias:'outside@example.test',randomGenerated:true,status:'live'}
 ];
 const ctx={OWNER_DOMAIN:'sng.sarl',validEmail:email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),sample};
 const result=vm.runInNewContext(snippet+'\nbuildEmailGenExportCsv(sample)',ctx);
 assert.equal(result.count,3,'only encrypted bank aliases for the owner domain are exported');
 assert.equal(result.csv,'email,password,profile_name\r\n'+
  '"sng0001@sng.sarl","Freeshit1!","aco gen 1"\r\n'+
  '"manual@sng.sarl","Freeshit1!","aco gen 2"\r\n'+
  '"sng0003@sng.sarl","Freeshit1!","aco gen 3"\r\n');
 assert.equal(sample[0].password,undefined,'preset password must not be stored in aliases');
 assert.equal(sample[1].profileName,undefined,'profile name is only in the export copy');
});

test('Email Gen CSV creates 100 names in stable order and rejects duplicate aliases and unsafe spreadsheet prefixes',()=>{
 const start=app.indexOf(" const EMAIL_GEN_EXPORT_PASSWORD="),end=app.indexOf(" const unassignedRandom=",start);
 const ctx={OWNER_DOMAIN:'sng.sarl',validEmail:email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)};
 const names=Array.from({length:100},(_,i)=>({alias:'sng'+i+'@sng.sarl'}));
 const data=vm.runInNewContext(app.slice(start,end)+'\nbuildEmailGenExportCsv('+JSON.stringify(names)+')',ctx);
 assert.equal(data.count,100);
 assert.ok(data.csv.includes('"sng0@sng.sarl","Freeshit1!","aco gen 1"'));
 assert.ok(data.csv.includes('"sng99@sng.sarl","Freeshit1!","aco gen 100"'));
 assert.equal((data.csv.match(/Freeshit1!/g)||[]).length,100);
 assert.throws(()=>vm.runInNewContext("buildEmailGenExportCsv([{alias:'x@sng.sarl'},{alias:'X@sng.sarl'}])",ctx),/Duplicate/);
 assert.throws(()=>vm.runInNewContext("buildEmailGenExportCsv([{alias:'=SUM(1)@sng.sarl'}])",ctx),/spreadsheet-leading character/);
});

test('Email Gen CSV download requires unlocked owner; export does not edit Cloudflare, aliases or retailer pools',()=>{
 const start=app.indexOf(" const EMAIL_GEN_EXPORT_PASSWORD="),end=app.indexOf(" const unassignedRandom=",start);
 const snippet=app.slice(start,end),aliases=[{alias:'sngtest@sng.sarl',randomGenerated:true,status:'draft',poolTarget:null}];
 let ownerChecks=0,clicked=0,revoked=0,stored=0,published=0;
 const anchor={click(){clicked++;},remove(){},href:null,download:null,hidden:false};
 const ctx={OWNER_DOMAIN:'sng.sarl',validEmail:email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
  records:aliases,unlocked:false,requireOwner(){ownerChecks++;},Date,
  document:{createElement:()=>anchor,body:{appendChild:()=>{}}},
  Blob,URL:{createObjectURL:()=>'blob:aco',revokeObjectURL:()=>revoked++},
  setTimeout:callback=>callback(),store(){stored++;},api(){published++;}};
 vm.createContext(ctx);vm.runInContext(snippet,ctx);
 assert.throws(()=>vm.runInContext('downloadEmailGenExport()',ctx),/Unlock/);
 assert.equal(clicked,0);
 ctx.unlocked=true;
 assert.equal(vm.runInContext('downloadEmailGenExport()',ctx),1);
 assert.equal(anchor.download.match(/^aco-gen-emails-\d{4}-\d\d-\d\d\.csv$/)?.length>0,true);
 assert.equal(clicked,1);assert.equal(revoked,1);
 assert.equal(ownerChecks,2);
 assert.equal(stored,0);assert.equal(published,0);
 assert.equal(aliases[0].status,'draft');assert.equal(aliases[0].poolTarget,null);
});
