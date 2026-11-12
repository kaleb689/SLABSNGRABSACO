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
 assert.match(html,/Choose your inbox/);
 assert.match(html,/id="randomAliasCount" min="1" max="10000"/);
 assert.match(html,/No retailer pool is required/);
 assert.match(html,/id="randomAliasActivate"/);
 assert.match(html,/id="randomAliasForwardStatus"/);
 assert.match(html,/id="randomAliasCreate">Generate Only/);
 assert.match(html,/Cloudflare standard Email Routing supports up to 200 individual rules per domain/);
});
test('Random local parts use secure name combinations, stay within 10 characters, and still reject duplicates',()=>{
 const start=app.indexOf(' const RANDOM_FIRST_NAMES='),end=app.indexOf(' // CSV export values',start);
 assert.ok(start>=0&&end>start);
 const script=app.slice(start,end);
 let seed=0;
 const crypt={getRandomValues:array=>{for(let i=0;i<array.length;i++)array[i]=(seed+i*29)%256;seed++;return array;}};
 const ctx=vm.createContext({crypto:crypt,Uint8Array,Array,Object,String});
 vm.runInContext(script,ctx);
 const results=Array.from({length:500},()=>vm.runInContext('randomLocal()',ctx));
 assert.ok(results.every(name=>/^[a-z]{5,9}[0-9]{1,2}$/.test(name)&&name.length<=10),results.find(name=>name.length>10));
 assert.ok(new Set(results).size>200,'random aliases should have varied names');
 assert.ok(results.every(name=>!name.startsWith('sng')),'Do not use the old sng plus hex alias format');
 assert.match(app,/new Set\(records\.map\(r=>r\.alias\)\)/);
 assert.match(app,/if\(\+\+attempts>100\)/);
 assert.match(app,/count<1\|\|count>10000/);
 assert.match(app,/if\(records\.length\+count>10000\)/);
 assert.match(app,/if\(\(i\+1\)%250===0&&i\+1<count\)/);
 assert.match(app,/makeAlias\('Random '\+local,local,target,currentDomain\(\)\)/);
});
test('Encrypted Email Bank retains pool assignment and delivery test provenance across reload',()=>{
 for(const field of ['randomGenerated:r.randomGenerated===true','poolTarget:','poolImportedAt:','forwardingTestedAt:','forwardingTestTarget:','catchAllVerifiedAt:'])assert.ok(app.includes(field),field);
 assert.match(app,/if\(!await store\(\)\)/);
 assert.match(app,/row\.batchId=batchId/);
 assert.match(app,/row\.batchCreatedAt=batchCreatedAt/);
 assert.match(app,/Batch manager replaces the old global assignment path/);
});
test('Saved aliases can turn on forwarding without a retailer pool',()=>{
 assert.match(app,/const unassignedRandom=\(\)=>records\.filter\(r=>r\.randomGenerated===true&&!r\.poolTarget\)/);
 const start=app.indexOf(' async function activateUnassignedForwarding(){');
 const end=app.indexOf(' async function publishRandomAndSync(){',start);
 assert.ok(start>=0&&end>start);
 const source=app.slice(start,end);
 assert.match(source,/unassignedRandom\(\)\.filter/);
 assert.match(source,/batch\.map\(\(\{alias,target\}\)=>\(\{alias,target\}\)\)/);
 assert.match(source,/index\+=100/);
 assert.doesNotMatch(source,/poolTarget\s*=/);
 assert.doesNotMatch(source,/importLiveRandom\(\)/);
 assert.match(app,/activate\.addEventListener\('click'/);
});
test('Cloudflare live AND exact mailbox receipt are mandatory before Personal unused-pool import',()=>{
 assert.match(app,/unsyncedRandom\(\)\.filter\(r=>r\.status==='live'&&r\.forwardingTestedAt&&r\.forwardingTestTarget===r\.target\)/);
 assert.match(app,/profileWorkshop\?\.importEmails/);
 assert.match(app,/scope:'personal',customerId:null,retailer,emails:batch\.map\(r=>r\.alias\)/);
 assert.match(app,/JigPersonalGuard\?\.ensureUnlocked/);
 assert.match(app,/await api\(\)\.publish\(toPublish\.map/);
 assert.match(app,/api\(\)\?\.testForwarding/);
 assert.match(app,/row\.forwardingTestedAt=now/);
 assert.match(app,/row\.catchAllVerifiedAt=now/);
});
test('Catch-all verification only promotes actual inbox receipts and never publishes Cloudflare rules',async()=>{
 assert.match(html,/id="randomAliasCatchAllTest"/);
 assert.match(html,/Catch-all/);
 const start=app.indexOf(' async function testAllRandomEmails(){'),end=app.indexOf(' // Changing the top forwarding field',start);
 assert.ok(start>=0&&end>start);
 const source=app.slice(start,end);
 assert.doesNotMatch(source,/api\(\)\.publish/);
 const records=Array.from({length:30},(_,i)=>({alias:'saved'+i+'@sng.sarl',target:'owner@example.com',randomGenerated:true,status:'draft',poolTarget:null}));
 const fields={emailTarget:{value:'owner@example.com'},randomTestSmtp:{value:'smtp.gmail.com'},randomTestImap:{value:'imap.gmail.com'},
  randomTestPassword:{value:'test-password'},randomTestSender:{value:'other@example.com'},randomTestSenderPassword:{value:'sender-password'},
  randomAliasCatchAllTest:{checked:true},randomTestStatus:{textContent:''}};
 const batches=[],ctx={records,requireOwner(){},OWNER_DOMAIN:'sng.sarl',validEmail:v=>/^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(v),
  $e:id=>fields[id],api:()=>({testForwarding:async req=>{
   batches.push(req.aliases);
   return {results:req.aliases.map((alias,i)=>({alias,status:i<7?'delivered':'not_received'}))};
  }}),store:async()=>true,importLiveRandom:async()=>({added:0}),randomNotice(){},refreshRandomChooser(){},Date,Set};
 vm.createContext(ctx);
 vm.runInContext(source+'; this.verifyCatchAll=testAllRandomEmails;',ctx);
 await ctx.verifyCatchAll();
 assert.equal(batches.length,1);
 assert.equal(batches[0].length,25);
 assert.equal(records.filter(r=>r.status==='live').length,7);
 assert.equal(records.filter(r=>r.catchAllVerifiedAt&&r.forwardingTestedAt).length,7);
 assert.equal(records.filter(r=>r.status==='draft').length,23);
 assert.ok(records.every(r=>!r.poolTarget));
 assert.match(fields.randomTestStatus.textContent,/7 PASSED/);
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
 assert.match(html,/id="randomAliasExportShikari"/);
 assert.match(html,/id="randomAliasExportShikariTxt"/);
 assert.match(html,/profile_name,email,password/);
 assert.match(app,/const EMAIL_GEN_EXPORT_PASSWORD='Freeshit1!'/);
 assert.match(app,/function downloadEmailGenExport\(mode='basic',extension='csv'\)/);
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
 assert.equal(result.csv,'profile_name,email,password\r\n'+
  '"aco gen 1","sng0001@sng.sarl","Freeshit1!"\r\n'+
  '"aco gen 2","manual@sng.sarl","Freeshit1!"\r\n'+
  '"aco gen 3","sng0003@sng.sarl","Freeshit1!"\r\n');
 assert.equal(sample[0].password,undefined,'preset password must not be stored in aliases');
 assert.equal(sample[1].profileName,undefined,'profile name is only in the export copy');
});

test('Email Gen CSV creates 100 names in stable order and rejects duplicate aliases and unsafe spreadsheet prefixes',()=>{
 const start=app.indexOf(" const EMAIL_GEN_EXPORT_PASSWORD="),end=app.indexOf(" const unassignedRandom=",start);
 const ctx={OWNER_DOMAIN:'sng.sarl',validEmail:email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)};
 const names=Array.from({length:100},(_,i)=>({alias:'sng'+i+'@sng.sarl'}));
 const data=vm.runInNewContext(app.slice(start,end)+'\nbuildEmailGenExportCsv('+JSON.stringify(names)+')',ctx);
 assert.equal(data.count,100);
 assert.ok(data.csv.includes('"aco gen 1","sng0@sng.sarl","Freeshit1!"'));
 assert.ok(data.csv.includes('"aco gen 100","sng99@sng.sarl","Freeshit1!"'));
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


test('Email Gen Shikari export exactly matches owner-supplied 24-column Shikari template (index,profile_name...)',()=>{
 const start=app.indexOf(" const EMAIL_GEN_EXPORT_PASSWORD="),end=app.indexOf(" const unassignedRandom=",start);
 const ctx={OWNER_DOMAIN:'sng.sarl',validEmail:email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)};
 vm.createContext(ctx);vm.runInContext(app.slice(start,end),ctx);
 const reference=['index','profile_name','first_name','last_name','email','phone_num',
  'cc_number','cc_exp_month','cc_exp_year','cc_cvv','shipping_street',
  'shipping_street_2','shipping_city','shipping_state','shipping_zip_code',
  'shipping_country','billing_first_name','billing_last_name','billing_street',
  'billing_street_2','billing_city','billing_state','billing_zip_code','billing_country'];
 assert.equal(reference.length,24);
 const aliases=Array.from({length:102},(_,i)=>({alias:'sng'+i+'@sng.sarl'}));
 ctx.data=aliases;
 const shikari=vm.runInContext("buildEmailGenExportCsv(data,'shikari')",ctx);
 const lines=shikari.csv.trim().split('\r\n'),header=lines[0].split(',');
 assert.equal(shikari.csv.charCodeAt(0),'i'.charCodeAt(0),'No BOM before index header');
 assert.deepEqual(header,reference);
 assert.equal(lines.length,103,'One header plus all 102 Shikari profiles');
 const records=lines.slice(1).map(line=>line.split(','));
 for(let i=0;i<records.length;i++){
  const record=Object.fromEntries(header.map((field,j)=>[field,records[i][j]]));
  assert.equal(records[i].length,24,'Exact Shikari column count');
  assert.equal(record.index,String(i),'Index is a zero-based unquoted number');
  assert.equal(record.profile_name,'aco gen '+(i+1),'Shikari sees non-empty profile_name on each row');
  assert.equal(record.email,aliases[i].alias,'Original alias preserved');
  assert.ok(!Object.hasOwn(record,'password'),'Shikari profile template must not insert a non-template password column');
  assert.ok(reference.filter(k=>!['index','profile_name','email'].includes(k)).every(k=>record[k]===''),
   'Unverified name/card/address fields must remain empty');
 }
 assert.equal(records[0][1],'aco gen 1');
 assert.equal(records[101][1],'aco gen 102');
 assert.equal(records[0][4],'sng0@sng.sarl');
 const basic=vm.runInContext("buildEmailGenExportCsv(data,'basic')",ctx);
 assert.ok(basic.csv.startsWith('profile_name,email,password\r\n'));
 assert.ok(basic.csv.includes('"aco gen 102","sng101@sng.sarl","Freeshit1!"'));
 assert.equal((basic.csv.match(/Freeshit1!/g)||[]).length,102);
 assert.equal((shikari.csv.match(/Freeshit1!/g)||[]).length,0);
 assert.match(html,/Export Shikari profile template CSV/);
 assert.match(html,/Export Shikari TXT/);
 assert.match(app,/new Blob\(\[result\.csv\]/,'No BOM prefix in exported bytes');
});

test('Shikari TXT uses exact index then profile_name schema and genuine .txt extension',()=>{
 const start=app.indexOf(" const EMAIL_GEN_EXPORT_PASSWORD="),end=app.indexOf(" const unassignedRandom=",start);
 let download='',type='';
 const anchor={click(){},remove(){},set href(v){},set download(v){download=v},hidden:false};
 const ctx={OWNER_DOMAIN:'sng.sarl',validEmail:email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
  records:[{alias:'one@sng.sarl'}],unlocked:true,requireOwner(){},
  Date,document:{createElement:()=>anchor,body:{appendChild(){}}},
  Blob:class{constructor(data,opts){type=opts.type;assert.equal(data[0].startsWith('index,profile_name,'),true);}},
  URL:{createObjectURL:()=>'blob:local',revokeObjectURL(){}},
  setTimeout:fn=>fn()};
 vm.createContext(ctx);vm.runInContext(app.slice(start,end),ctx);
 const result=vm.runInContext("downloadEmailGenExport('shikari','txt')",ctx);
 assert.equal(result,1);
 assert.match(download,/^shikari-email-profile-template-\d{4}-\d\d-\d\d\.txt$/);
 assert.match(type,/^text\/plain/);
 assert.throws(()=>vm.runInContext("downloadEmailGenExport('shikari','exe')",ctx),/Unsupported/);
});
