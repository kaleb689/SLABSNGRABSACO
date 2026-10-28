'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {makeProfileVault}=require('../profile-vault'),{makeJigBanks}=require('../jig-address-banks'),{makeVault}=require('../local-card-vault');
const D=require('../profile-draft-core'),F=require('../jig-field-core'),Core=require('../app'),{createWorkshop}=require('../profile-workshop-service');
const event={sender:{id:1}},foreign={sender:{id:2}};
const crypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('ENCRYPTED:'+s),decryptString:b=>{assert.ok(b.toString().startsWith('ENCRYPTED:'));return b.toString().slice(10);}};
const address={label:'Home',address1:'100 Example Avenue',address2:'Apt 2',city:'Sample',state:'FL',zip:'33324'};
const card={label:'Test card',number:'4242424242424242',cardholder:'Saved Holder',expMonth:'08',expYear:'2031',brand:'Visa'};
const fullCard={id:'card-a',label:'Test card',number:card.number,cardholder:card.cardholder,month:card.expMonth,year:card.expYear,type:card.brand};
const choices=(n)=>({address:!!(n&1),card:!!(n&2),name:!!(n&4)});
async function env(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-workshop-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let unlocked=true,time=1000,allowExport=false;const writes=[];
 const profiles=makeProfileVault({baseDir:dir,safeStorage:crypto}),addresses=makeJigBanks({baseDir:dir,safeStorage:crypto});
 const personal=makeVault({baseDir:dir,safeStorage:crypto,fileName:'jig-studio-personal-cards.encrypted'}),customers=makeVault({baseDir:dir,safeStorage:crypto});
 function guard(e,scope){if(e.sender.id!==1)throw Error('Not the owner window');if(scope==='personal'&&!unlocked)throw Error('Personal locked');}
 const service=createWorkshop({profiles,addressBanks:addresses,cardVault:s=>s==='personal'?personal:customers,
  authorize:async(e,s,id)=>{guard(e,s);if(s==='aco'&&!['customer-a','customer-b'].includes(id))throw Error('Unauthorized customer');return s==='personal'?null:id;},guard,now:()=>time,
  chooseSave:async(_e,o)=>({filePath:path.join(dir,o.name)}),confirmExport:async()=>allowExport,writeFile:async(...args)=>writes.push(args)});
 const p={scope:'personal',customerId:null},a={scope:'aco',customerId:'customer-a'},b={scope:'aco',customerId:'customer-b'};
 return {dir,profiles,addresses,personal,customers,service,p,a,b,writes,lock:()=>{unlocked=false;},setTime:v=>time=v,export:()=>allowExport=true};
}

const {createLibrary}=require('../profile-library-service'),LC=require('../profile-library-core');
async function library(t,overrides={}){const h=await env(t);let allowed=true;const lib=createLibrary({profiles:h.profiles,cardVault:s=>s==='personal'?h.personal:h.customers,authorize:async(e,s,id)=>{if(e.sender.id!==1)throw Error('Not owner');if(s==='aco'&&!['customer-a','customer-b'].includes(id))throw Error('Unauthorized customer');return s==='personal'?null:id;},guard:(e,s)=>{if(e.sender.id!==1||!allowed)throw Error('Locked');},chooseSave:async(_e,o)=>({filePath:path.join(h.dir,o.name)}),confirmExport:async()=>true,writeFile:async(...args)=>h.writes.push(args),getCustomerProfileSource:async id=>({customer:{id,name:id},linked:[{customerId:id,assignmentId:'linked-1',retailer:'pokemoncenter',active:true,data:complete('pokemoncenter','linked@example.test')}]}),...overrides});return {...h,lib,lockLibrary:()=>allowed=false};}
function complete(retailer,email){const data=D.blank(retailer,LC.format(retailer),{email,first:'Alex',last:'Example',phone:'9545550100','shipping.address1':'100 Example Avenue','shipping.city':'Sample','shipping.state':'FL','shipping.zip':'33324','billing.address1':'100 Example Avenue','billing.city':'Sample','billing.state':'FL','billing.zip':'33324'});LC.putCard(data,fullCard);return data;}
async function preview(h,data,owner=h.p,retailer='target'){return h.lib.importPreview(event,{...owner,retailer,fileName:'profiles.json',text:JSON.stringify(data)});}
async function commit(h,preview,extra={}){return h.lib.importCommit(event,{token:preview.token,confirmed:true,alreadyJigged:true,repairs:{allowShared:true},...extra});}

test('Independent profile Security Codes persist through import, edit, jig and export in both retailer formats',async t=>{
 const h=await library(t);
 for(const retailer of ['target','walmart']){
  const data=complete(retailer,'owner-'+retailer+'@example.test');
  if(retailer==='target')data.cc_cvv='012';else data.card.cvv='0123';
  const reference='PICKUP-REFERENCE-'+retailer.toUpperCase();
  data.profileSecurityCode=reference;
  await commit(h,await h.lib.importPreview(event,{...h.p,bank:'live',retailer,fileName:'profiles.json',text:JSON.stringify([data])}));
  let row=(await h.lib.list(event,h.p)).profiles.find(x=>x.retailer===retailer);
  assert.equal(row.data.profileSecurityCode,reference);
  assert.equal(LC.payment(row.data).cvv,'','Card verifiers are not an independent profile reference');
  const loaded=await h.lib.detail(event,{...h.p,profileId:row.id});
  assert.equal(loaded.data.profileSecurityCode,reference);
  const jig=await h.lib.batchJigPreview(event,{...h.p,retailer,profileIds:[row.id],ruleIds:[LC.FL_PHONE_RULE],hardCounts:{fraction:1},combine:false,billingSameAsShipping:true});
  await h.lib.batchJigCommit(event,{token:jig.token,confirmed:true,allowDuplicateAddresses:jig.duplicateAddresses.length>0});
  row=(await h.lib.list(event,h.p)).profiles.find(x=>x.id===row.id);
  assert.equal(row.data.profileSecurityCode,reference);
  assert.equal(row.bank,'live');
  await h.lib.exportArchive(event,{...h.p,retailer,profileIds:[row.id],customerName:'Owner'});
  assert.equal(JSON.parse(h.writes.at(-1)[1]).profiles[0].profileSecurityCode,reference);
 }
 assert.ok((await fs.readFile(h.profiles.paths.personal)).toString().startsWith('ENCRYPTED:'));
 assert.equal((await h.lib.list(event,h.b)).profiles.length,0);
 h.lockLibrary();await assert.rejects(h.lib.list(event,h.p),/Locked/);
});
test('Independent profile code may be edited without affecting other profiles or audit logs',async t=>{
 const h=await library(t),data=complete('target','code@example.test');
 data.profileSecurityCode='PICKUP-OLD';
 await commit(h,await preview(h,[data]));
 let row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'PICKUP-OLD');
 const updated=await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),profileSecurityCode:'PICKUP-NEW',confirmSecurityCodeChange:true});
 assert.equal(updated.updated,true);
 assert.ok(!JSON.stringify(updated).includes('PICKUP-NEW'));
 row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'PICKUP-NEW');
 assert.ok(!JSON.stringify(await h.profiles.audit('personal',null)).includes('PICKUP-NEW'));
 await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),profileSecurityCode:'',confirmSecurityCodeChange:true});
 assert.equal((await h.lib.list(event,h.p)).profiles[0].data.profileSecurityCode,'');
});
test('Imported independent Security Code aliases remain with the correct owner and never become a card verifier',async t=>{
 const h=await library(t),data=complete('walmart','code-alias@example.test');
 data.card.cvc='345';data.profileSecurityCode='PROFILE-REFERENCE';
 data.card.custom_security_code='INDEPENDENT-SAVED-NOTE';
 await commit(h,await preview(h,[data],h.p,'walmart'));
 const row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'PROFILE-REFERENCE');
 assert.equal(row.data.card.custom_security_code,'INDEPENDENT-SAVED-NOTE');
 assert.equal(LC.payment(row.data).cvv,'');
 assert.equal((await h.lib.list(event,h.a)).profiles.length,0);
 assert.equal((await h.lib.list(event,h.b)).profiles.length,0);
});

test('Customer storage does not change and the customer editor rejects Personal card-code operations',async t=>{
 const h=await library(t),data=complete('target','customer@example.test');data.cc_cvv='123';await commit(h,await preview(h,[data],h.a));const row=(await h.lib.list(event,h.a)).profiles[0];assert.equal(row.data.cc_cvv,'');
 await assert.rejects(h.lib.edit(event,{...h.a,profileId:row.id,revision:row.revision,fields:LC.values(row.data),cardCvv:'123'}),/Personal vault/);
});


test('Legacy CVV-labeled import slot preserves user-entered Security Code in separate profile field without truncating leading zeros',async t=>{
 const h=await library(t);
 for(const [retailer,code] of [['target','0044'],['walmart','0008']]){
  const data=complete(retailer,'legacy-'+retailer+'@example.test');
  if(retailer==='target')data.cc_cvv=code;else data.card.cvv=code;
  await commit(h,await h.lib.importPreview(event,{...h.p,bank:'live',retailer,fileName:'profiles.json',text:JSON.stringify([data])}));
  let row=(await h.lib.list(event,h.p)).profiles.find(x=>x.retailer===retailer);
  assert.equal(row.data.profileSecurityCode,code);
  const payment=LC.payment(row.data);assert.equal(payment.cvv,'');
  await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data)});
  row=(await h.lib.list(event,h.p)).profiles.find(x=>x.id===row.id);
  assert.equal(row.data.profileSecurityCode,code,'unrelated profile edit never clears code');
  await h.lib.exportArchive(event,{...h.p,retailer,profileIds:[row.id],customerName:'Personal'});
  assert.equal(JSON.parse(h.writes.at(-1)[1]).profiles[0].profileSecurityCode,code);
 }
});
test('Selecting an explicit export format does not mutate or remove profile Security Codes',async t=>{
 const h=await library(t),data=complete('target','formats@example.test');
 data.profileSecurityCode='PICKUP-0008';
 await commit(h,await preview(h,[data]));
 const row=(await h.lib.list(event,h.p)).profiles[0];
 for(const extension of ['json','csv','tsv','txt']){
  await h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:[row.id],customerName:'Personal',exportFormat:extension});
  const last=h.writes.at(-1);
  assert.ok(last[0].endsWith('.'+extension));
  assert.ok(last[1].includes('PICKUP-0008'));
 }
 const after=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(after.data.profileSecurityCode,'PICKUP-0008');
});
test('UI exposes View/Edit for imported cards and editable Security Code for saved cards',()=>{
 const code=require('node:fs').readFileSync(require.resolve('../profile-workshop-ui.js'),'utf8');
 assert.match(code,/line.append\(view\)/);
 assert.match(code,/textContent='View \/ Edit'/);
 assert.match(code,/field\('customSecurityCode','Security Code/);
});


test('Every selected export format maps the independent Security Code into its retailer CVV slot without modifying saved data',async t=>{
 const h=await library(t);
 for(const retailer of ['target','walmart']){
  const source=complete(retailer,'cvv-slot-'+retailer+'@example.test');
  source.profileSecurityCode='0044';
  await commit(h,await h.lib.importPreview(event,{...h.p,retailer,fileName:'profiles.json',text:JSON.stringify([source])}));
  const row=(await h.lib.list(event,h.p)).profiles.find(x=>x.retailer===retailer);
  for(const format of ['json','csv','tsv','txt']){
   const result=await h.lib.exportFile(event,{...h.p,retailer,profileIds:[row.id],customerName:'Personal',exportFormat:format});
   assert.equal(result.saved,true);
   const body=h.writes.at(-1)[1];
   assert.ok(body.includes('0044'),retailer+' '+format+' must keep leading zeros');
   if(format==='json'){
    const record=JSON.parse(body).profiles[0].data;
    assert.equal(retailer==='target'?record.cc_cvv:record.card.cvv,'0044');
   }else{
    assert.ok(body.includes(retailer==='target'?'cc_cvv':'card.cvv'),
      retailer+' '+format+' must use CVV-named column, not a separate arbitrary Security Code column');
   }
  }
  await h.lib.exportFile(event,{...h.p,retailer,profileIds:[row.id],customerName:'Personal',exportFormat:'retailer'});
  const native=h.writes.at(-1)[1];
  assert.ok(native.includes('0044'),retailer+' retailer template must place exported code');
  if(retailer==='target'){
   const header=native.split(/\r?\n/,1)[0];
   assert.match(header,/(?:^|,)(?:"?cc_cvv"?|"?cvv"?)(?:,|$)/i,
    'Shikari native CSV must include its CVV field');
  }else{
   const parsed=JSON.parse(native);
   function cvvEntries(node){
    if(Array.isArray(node))return node.flatMap(cvvEntries);
    if(!node||typeof node!=='object')return [];
    return Object.entries(node).flatMap(([key,value])=>
     /^(cvv|cc_cvv)$/i.test(key)?[value]:cvvEntries(value));
   }
   assert.ok(cvvEntries(parsed).includes('0044'),
    'Valor native JSON must put exact reference in a CVV-named field, not another field');
  }
  const after=(await h.lib.list(event,h.p)).profiles.find(x=>x.id===row.id);
  assert.equal(after.data.profileSecurityCode,'0044');
  assert.equal(LC.payment(after.data).cvv,'','encrypted master does not gain an actual payment verifier');
 }
});


test('Original imported profile can restore its missing Security Code without re-importing profile records',async t=>{
 const h=await library(t),original=complete('target','recover-original@example.test');
 original.cc_cvv='0099'; // Legacy file contained the unrelated reference here.
 await commit(h,await preview(h,[original]));
 let row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'0099');
 await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),profileSecurityCode:'',confirmSecurityCodeChange:true});
 row=(await h.lib.list(event,h.p)).profiles[0];assert.equal(row.data.profileSecurityCode,'');
 const decoded=Core.parseFile('original.json',JSON.stringify([original])).records[0];
 assert.equal(decoded.cc_cvv,'0099','parser must preserve the old reference slot for recovery');
 assert.equal(LC.payment(decoded).number,LC.payment(row.data).number,'card identity must stay exact');
 const result=await h.lib.recoverCodesFromFile(event,{...h.p,retailer:'target',fileName:'original.json',text:JSON.stringify([original])});
 assert.equal(result.preview,true);assert.equal(result.recoverable,1,JSON.stringify(result.diagnostics));
 assert.equal((await h.lib.list(event,h.p)).profiles[0].data.profileSecurityCode,'','preview never modifies profile');
 const applied=await h.lib.recoverCodesFromFile(event,{...h.p,retailer:'target',token:result.token,confirmed:true});
 assert.equal(applied.restored,1);
 const after=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(after.data.profileSecurityCode,'0099');
 assert.equal(after.data.cc_number,original.cc_number);
 assert.equal(after.email,'recover-original@example.test');
});
test('Original-import recovery refuses a file assigned to a different customer',async t=>{
 const h=await library(t),original=complete('target','scoped-code@example.test');
 original.cc_cvv='0044';original.customerId='customer-b';
 await assert.rejects(h.lib.recoverCodesFromFile(event,{...h.a,retailer:'target',fileName:'original.json',text:JSON.stringify([original])}),/another vault/);
 assert.equal((await h.lib.list(event,h.a)).profiles.length,0);
});


test('Saved Card Bank can explicitly fill a missing profile Security Code by full card number in one vault only',async t=>{
 const h=await library(t);
 const data=complete('target','saved-card-recovery@example.test');
 await commit(h,await preview(h,[data]));
 const saved=await h.service.addCard(event,{...h.p,card:{...card,customSecurityCode:'0077'}});
 assert.ok(saved.id,'saved card bank entry required');
 const file=await fs.readFile(path.join(h.dir,'jig-studio-personal-cards.encrypted'));
 const storedText=file.toString();
 assert.ok(storedText.includes('0077'),'encrypted fixture file must contain independent reference after safe storage shim');
 const preserved=(await h.personal.securityReferences('personal:owner')).find(x=>x.id===saved.id);
 assert.equal(preserved.customSecurityCode,'0077','existing saved Card Bank code must be present in encrypted storage');
 assert.equal(LC.payment((await h.lib.list(event,h.p)).profiles[0].data).number,preserved.number,'full card identity must match');
 const previewResult=await h.lib.recoverCodesFromSavedCards(event,{...h.p,confirmed:false});
 assert.equal(previewResult.recoverable,1);
 assert.equal((await h.lib.list(event,h.p)).profiles[0].data.profileSecurityCode||'','');
 const restored=await h.lib.recoverCodesFromSavedCards(event,{...h.p,confirmed:true,token:previewResult.token});
 assert.equal(restored.restored,1);
 assert.equal((await h.lib.list(event,h.p)).profiles[0].data.profileSecurityCode,'0077');
 assert.equal((await h.lib.list(event,h.a)).profiles.length,0);
 assert.equal((await h.lib.list(event,h.b)).profiles.length,0);
});

test('Recovery Source Review reports independent source counts without changing saved values',async t=>{
 const h=await library(t),data=complete('target','review-sources@example.test');
 data.profileSecurityCode='REF-SNAPSHOT';
 await commit(h,await preview(h,[data]));
 await h.profiles.libraryTransaction('personal',null,ctx=>{
  // Deliberately simulate an earlier data-loss incident in this test only.
  ctx.allowIndependentReferenceEdit(ctx.rows[0].id);
  ctx.rows[0].data.profileSecurityCode='';
  return {saved:true};
 },()=>{});
 await h.service.addCard(event,{...h.p,card:{...card,customSecurityCode:'REF-SAVED-BANK'}});
 const original=complete('target','review-sources@example.test');
 original.profileSecurityCode='REF-ORIGINAL-FILE';
 const before=await fs.readFile(h.profiles.paths.personal);
 const result=await h.lib.recoveryReview(event,{...h.p,retailer:'target',
  fileName:'original.json',text:JSON.stringify([original])});
 const after=await fs.readFile(h.profiles.paths.personal);
 assert.equal(result.readOnly,true);
 assert.equal(result.scope,'personal');
 assert.equal(result.missingProfiles,1);
 assert.equal(result.backups.potentialMatches,1);
 assert.ok(result.backups.scanned>=1);
 assert.equal(result.savedCardBank.potentialMatches,1);
 assert.equal(result.originalFile.potentialMatches,1);
 assert.equal(result.originalFile.scannedRecords,1);
 assert.deepEqual(after,before,'review must not write to the encrypted profile vault');
 assert.equal((await h.lib.list(event,h.p)).profiles[0].data.profileSecurityCode,'');
 const visible=JSON.stringify(result);
 for(const code of ['REF-SNAPSHOT','REF-SAVED-BANK','REF-ORIGINAL-FILE'])
  assert.ok(!visible.includes(code),'never expose source codes in the read-only report');
});

test('Recovery Source Review enforces owner scopes, does not accept confirmation, and rejects mixed-owner files',async t=>{
 const h=await library(t),a=complete('target','same-review@example.test'),
  b=complete('target','same-review@example.test');
 a.profileSecurityCode='';b.profileSecurityCode='REF-CUSTOMER-B';
 await commit(h,await preview(h,[a],h.a));
 await commit(h,await preview(h,[b],h.b));
 const report=await h.lib.recoveryReview(event,{...h.a});
 assert.equal(report.missingProfiles,1);
 assert.equal(report.backups.potentialMatches,0);
 assert.equal(report.savedCardBank.potentialMatches,0);
 await assert.rejects(h.lib.recoveryReview(foreign,{...h.a}),/owner|unauthorized|window/i);
 await assert.rejects(h.lib.recoveryReview(event,{...h.a,confirmed:true}),/read-only/);
 await assert.rejects(h.lib.recoveryReview(event,{...h.a,retailer:'target',fileName:'original.json',
  text:JSON.stringify([{...b,scope:'aco',customerId:'customer-b'}])}),/another vault/);
 assert.equal((await h.lib.list(event,h.a)).profiles[0].data.profileSecurityCode,'');
 assert.equal((await h.lib.list(event,h.b)).profiles[0].data.profileSecurityCode,'REF-CUSTOMER-B');
});

test('Read-only recovery review excludes CVV/CVC-labeled values from original files',async t=>{
 const h=await library(t),profile=complete('target','legacy-only@example.test');
 await commit(h,await preview(h,[profile]));
 const legacy=complete('target','legacy-only@example.test');
 legacy.cc_cvv='123';delete legacy.profileSecurityCode;
 const result=await h.lib.recoveryReview(event,{...h.p,retailer:'target',
  fileName:'old.json',text:JSON.stringify([legacy])});
 assert.equal(result.originalFile.scannedRecords,1);
 assert.equal(result.originalFile.potentialMatches,0);
 assert.equal(result.originalFile.withSourceReference,0);
 assert.equal((await h.lib.list(event,h.p)).profiles[0].data.profileSecurityCode||'','');
});

test('One recovery scan reviews multiple original files across retailers without modifying profiles',async t=>{
 const h=await library(t);
 const target=complete('target','multi-target@example.test');
 const walmart=complete('walmart','multi-walmart@example.test');
 await commit(h,await preview(h,[target],h.p,'target'));
 await commit(h,await preview(h,[walmart],h.p,'walmart'));
 const targetSource={...complete('target','multi-target@example.test'),retailer:'target',profileSecurityCode:'TARGET-INDEPENDENT-REFERENCE'};
 const walmartSource={...complete('walmart','multi-walmart@example.test'),retailer:'walmart',profileSecurityCode:'WALMART-INDEPENDENT-REFERENCE'};
 const original=await fs.readFile(h.profiles.paths.personal);
 const result=await h.lib.recoveryReview(event,{...h.p,files:[
  {fileName:'target-older.json',text:JSON.stringify([targetSource])},
  {fileName:'walmart-older.json',text:JSON.stringify([walmartSource])}
 ]});
 assert.equal(result.readOnly,true);
 assert.equal(result.missingProfiles,2);
 assert.equal(result.originalFiles.scanned,2);
 assert.equal(result.originalFiles.potentialMatches,2,'reviews all retailers, not just active retailer tab');
 assert.equal(result.originalFiles.scannedRecords,2);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),original,'scan must never write current encrypted profiles');
 assert.ok(!JSON.stringify(result).includes('TARGET-INDEPENDENT-REFERENCE'));
 assert.ok(!JSON.stringify(result).includes('WALMART-INDEPENDENT-REFERENCE'));
});

test('One recovery scan rejects cross-owner originals and excludes verifier aliases',async t=>{
 const h=await library(t);
 await commit(h,await preview(h,[complete('target','multi-owner@example.test')]));
 const original={...complete('target','multi-owner@example.test'),retailer:'target',cc_cvv:'123'};
 const noVerifier=await h.lib.recoveryReview(event,{...h.p,files:[
  {fileName:'target-old.json',text:JSON.stringify([original])}
 ]});
 assert.equal(noVerifier.originalFiles.potentialMatches,0);
 await assert.rejects(h.lib.recoveryReview(event,{...h.p,files:[
  {fileName:'foreign.json',text:JSON.stringify([{...original,scope:'aco',customerId:'customer-b'}])}
 ]}),/another vault/i);
 await assert.rejects(h.lib.recoveryReview(foreign,{...h.p,files:[
  {fileName:'target-old.json',text:JSON.stringify([original])}
 ]}),/owner/i);
 await assert.rejects(h.lib.recoveryReview(event,{...h.p,files:[]}),/1-20/);
 assert.equal((await h.lib.list(event,h.p)).profiles[0].data.profileSecurityCode||'','');
});

test('Profile screen renders one recovery action, keeping original import choice within the scan workflow',async()=>{
 const ui=await fs.readFile(path.join(__dirname,'..','profile-library-ui.js'),'utf8');
 assert.equal((ui.match(/textContent='Scan All Recovery Sources'/g)||[]).length,1);
 for(const obsolete of ['Recover missing Security Codes from encrypted backups','Recover codes from original import file',
  'Recover codes from saved Card Bank','Scan with original import file','Scan available recovery sources'])
  assert.ok(!ui.includes(obsolete),'duplicate recovery control should not appear: '+obsolete);
 assert.ok(ui.includes('api.historicalFolderReview'),'one action invokes the trusted native folder picker');
 assert.ok(ui.includes('scanOriginals:true'),'the folder grant includes eligible originals in the same scan');
 assert.ok(!ui.includes('reviewPicker.click()'),'hidden browser file input must not be used');
});

test('Deeper recovery scan inventories previous encrypted vault copies while never changing live data',async t=>{
 const h=await library(t),row=complete('target','history-check@example.test');
 await commit(h,await preview(h,[row]));
 const current=await h.profiles.fieldSnapshot('personal',null),older=structuredClone(current);
 older[0].data.profileSecurityCode='INDEPENDENT-LOCAL-HISTORY-ONLY';
 const archive={version:1,groups:{owner:older},audit:{}};
 const oldFilename=path.join(h.dir,'personal-retailer-profiles.encrypted.bak');
 await fs.writeFile(oldFilename,crypto.encryptString(JSON.stringify(archive)));
 const vaultBefore=await fs.readFile(h.profiles.paths.personal);
 const diskBefore=await fs.readFile(oldFilename);
 const report=await h.lib.recoveryReview(event,h.p);
 assert.equal(report.readOnly,true);
 assert.equal(report.historicSources.readable,1);
 assert.equal(report.historicSources.matched,1);
 assert.equal(report.historicSources.cardHistoryFiles,0,'active Card Bank is not a historical copy');
 assert.ok(report.importInventory.batches>=1);
 assert.equal(report.importInventory.contentsStoredInHistory,false);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),vaultBefore,'scan must not rewrite live vault');
 assert.deepEqual(await fs.readFile(oldFilename),diskBefore,'scan must not rewrite old vault');
 assert.ok(!JSON.stringify(report).includes('INDEPENDENT-LOCAL-HISTORY-ONLY'),'no reference values leave main process');
});

test('Historic source diagnostics do not enter a different customer bank or infer missing verifiers',async t=>{
 const h=await library(t),owner=complete('target','scope-check@example.test');
 await commit(h,await preview(h,[owner],h.a));
 const rows=await h.profiles.fieldSnapshot('aco','customer-a');
 const historic={version:1,groups:{'customer-b':rows.map(row=>({...row,data:{...row.data,profileSecurityCode:'CUSTOMER-B-ONLY'}}))},audit:{}};
 await fs.writeFile(path.join(h.dir,'aco-customer-retailer-profiles.encrypted.old'),crypto.encryptString(JSON.stringify(historic)));
 const report=await h.lib.recoveryReview(event,h.a);
 assert.equal(report.historicSources.readable,0,'no readable matching-owner records');
 assert.equal(report.historicSources.matched,0);
 assert.equal((await h.lib.list(event,h.a)).profiles[0].data.profileSecurityCode||'','');
 await assert.rejects(h.lib.recoveryReview(foreign,h.a),/owner|unauthorized/i);
});


test('Native original-file picker reads selected originals only within main process and leaves vault intact',async t=>{
 let choose=()=>[];
 const h=await library(t,{chooseOriginalFiles:async()=>choose()});
 const current=complete('target','native-picker@example.test');
 await commit(h,await preview(h,[current]));
 const original=complete('target','native-picker@example.test');
 original.profileSecurityCode='NATIVE-REFERENCE-ONLY';
 const filename=path.join(h.dir,'target-original.json');
 await fs.writeFile(filename,JSON.stringify([{...original,retailer:'target'}]));
 choose=()=>[filename];
 const before=await fs.readFile(h.profiles.paths.personal);
 const report=await h.lib.recoveryReviewSelectedFiles(event,{...h.p});
 assert.equal(report.readOnly,true);
 assert.equal(report.originalSelectionCancelled,false);
 assert.equal(report.originalFiles.scanned,1);
 assert.equal(report.originalFiles.potentialMatches,1);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before);
 assert.ok(!JSON.stringify(report).includes('NATIVE-REFERENCE-ONLY'));
 assert.ok(!JSON.stringify(report).includes(filename));
 choose=()=>null;
 const cancelled=await h.lib.recoveryReviewSelectedFiles(event,{...h.p});
 assert.equal(cancelled.originalSelectionCancelled,true);
 assert.equal(cancelled.originalFiles,null);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before);
});
test('Native picker rejects renderer supplied paths and cross-owner access',async t=>{
 const h=await library(t,{chooseOriginalFiles:async()=>[]});
 await assert.rejects(h.lib.recoveryReviewSelectedFiles(event,{...h.p,path:'/tmp/arbitrary.json'}),/trusted Mac file picker/);
 await assert.rejects(h.lib.recoveryReviewSelectedFiles(foreign,h.p),/owner/i);
});

test('Single folder action scans original files and all known sources without changing current vault',async t=>{
 let folder=null;
 const h=await library(t,{chooseHistoricalFolder:async()=>folder});
 const data=complete('target','folder-source@example.test');
 await commit(h,await preview(h,[data]));
 folder=path.join(h.dir,'originals');await fs.mkdir(folder);
 const older=complete('target','folder-source@example.test');
 older.profileSecurityCode='SEPARATE-NONPAYMENT-REF';
 await fs.writeFile(path.join(folder,'aco.json'),JSON.stringify([{...older,retailer:'target'}]));
 const before=await fs.readFile(h.profiles.paths.personal);
 const result=await h.lib.historicalFolderReview(event,{...h.p,scanOriginals:true});
 assert.equal(result.readOnly,true);
 assert.equal(result.selectedFolder.contentsInspected,false,'folder inventory is metadata-only');
 assert.equal(result.folderOriginalScan.scanned,1,'original content was also checked in the same workflow');
 assert.equal(result.originalFiles.potentialMatches,1);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before);
 assert.ok(!JSON.stringify(result).includes('SEPARATE-NONPAYMENT-REF'));
 folder=null;
 const cancelled=await h.lib.historicalFolderReview(event,{...h.p,scanOriginals:true});
 assert.equal(cancelled.selectedFolder.cancelled,true);
 assert.equal(cancelled.readOnly,true);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before);
});


test('Legacy CVV-labeled column is inventoried by metadata and identity only, without copying its value',async t=>{
 const h=await library(t),email='legacy-evidence@example.test';
 await commit(h,await preview(h,[complete('target',email)]));
 const original=complete('target',email);
 original.cc_cvv='SYNTHETIC-VERIFY-NO-RESTORE-101';
 const before=await fs.readFile(h.profiles.paths.personal);
 const report=await h.lib.recoveryReview(event,{...h.p,files:[
  {fileName:'target-original.json',text:JSON.stringify([{...original,retailer:'target'}])}
 ]});
 assert.equal(report.readOnly,true);
 assert.equal(report.originalFiles.scannedRecords,1);
 assert.equal(report.originalFiles.withSourceReference,0);
 assert.equal(report.originalFiles.withoutIndependentReference,1);
 assert.equal(report.originalFiles.legacyFieldPopulatedRows,1);
 assert.equal(report.originalFiles.legacyOnlyPopulatedRows,1);
 assert.equal(report.originalFiles.legacyIdentityMatches,1);
 assert.equal(report.originalFiles.legacyIdentityCardMismatches,0);
 assert.equal(report.originalFiles.potentialMatches,0,'verification columns never become recoverable codes');
 assert.equal(report.originalFiles.legacyFieldsMetadataOnly,true);
 assert.ok(!JSON.stringify(report).includes(original.cc_cvv),'no source code values in report');
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before,'read-only review cannot change saved information');
});

test('Legacy metadata audit rejects changed-card identity and does not cross owner vault scope',async t=>{
 const h=await library(t),email='legacy-mismatch@example.test';
 await commit(h,await preview(h,[complete('target',email)]));
 const original=complete('target',email);
 original.cc_cvv='SYNTHETIC-NOT-A-REAL-VERIFIER';
 original.cc_number='5555555555554444';
 const report=await h.lib.recoveryReview(event,{...h.p,files:[
  {fileName:'target-older.json',text:JSON.stringify([{...original,retailer:'target'}])}
 ]});
 assert.equal(report.originalFiles.legacyFieldPopulatedRows,1);
 assert.equal(report.originalFiles.legacyIdentityMatches,0);
 assert.equal(report.originalFiles.legacyIdentityCardMismatches,1);
 assert.equal(report.originalFiles.potentialMatches,0);
 assert.ok(!JSON.stringify(report).includes(original.cc_cvv));
 const wrongOwner={...original,scope:'aco',customerId:'customer-b'};
 await assert.rejects(h.lib.recoveryReview(event,{...h.p,files:[
  {fileName:'target-older.json',text:JSON.stringify([wrongOwner])}
 ]}),/another vault/i);
});


test('Routine vault saves reject silent loss of existing independent reference without changing encrypted data',async t=>{
 const h=await library(t);
 const source=complete('target','preserve-write@example.test');
 source.profileSecurityCode='INDEPENDENT-REF-PRESERVED';
 await commit(h,await preview(h,[source]));
 const before=await fs.readFile(h.profiles.paths.personal);
 await assert.rejects(h.profiles.libraryTransaction('personal',null,ctx=>{
  ctx.rows[0].label='Unrelated metadata edit';
  ctx.rows[0].data.profileSecurityCode='';
  return {updated:true};
 },()=>{}),/independent profile reference.*without an explicit code edit/i);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before,'no overwritten vault and no new backup');
 const row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'INDEPENDENT-REF-PRESERVED');
 await h.profiles.libraryTransaction('personal',null,ctx=>{
  ctx.rows[0].label='Allowed unrelated metadata edit';
 },()=>{});
 const after=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(after.data.profileSecurityCode,'INDEPENDENT-REF-PRESERVED');
});

test('Live profile replacement cannot silently erase independent reference even with updateExisting',async t=>{
 const h=await library(t);
 const original=complete('target','preserve-reimport@example.test');
 original.profileSecurityCode='INDEPENDENT-REIMPORT-REF';
 await commit(h,await h.lib.importPreview(event,{...h.p,bank:'live',retailer:'target',fileName:'original.json',text:JSON.stringify([original])}));
 const before=await fs.readFile(h.profiles.paths.personal);
 const row=(await h.profiles.fieldSnapshot('personal',null))[0];
 const withoutCode=complete('target','preserve-reimport@example.test');
 await assert.rejects(h.profiles.importLiveProfiles('personal',null,[{
  retailer:'target',data:withoutCode,format:'shikari',expectedHash:F.hash(row)
 }],{updateExisting:true},()=>{}),/preview|independent profile reference/i);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before);
 assert.equal((await h.lib.list(event,h.p)).profiles[0].data.profileSecurityCode,'INDEPENDENT-REIMPORT-REF');
});

test('Reviewed latest Live import archives old independent code even when replacement omits it',async t=>{
 const h=await library(t),email='preserve-reference@example.test';
 const original=complete('target',email);
 original.profileSecurityCode='ORIGINAL-INDEPENDENT-REF';
 const first=await h.lib.importPreview(event,{...h.p,bank:'live',retailer:'target',
  fileName:'original.json',text:JSON.stringify([original])});
 await commit(h,first);
 const old=(await h.lib.list(event,h.p)).profiles[0];
 const fresh=complete('target',email);
 const reviewed=await h.lib.importPreview(event,{...h.p,bank:'live',retailer:'target',
  fileName:'latest.json',text:JSON.stringify([fresh])});
 const result=await commit(h,reviewed);
 assert.equal(result.supersededLive,1);
 const current=(await h.lib.list(event,h.p)).profiles;
 assert.equal(current.length,1);assert.notEqual(current[0].id,old.id);
 const encrypted=await fs.readFile(h.profiles.paths.personal);
 assert.ok(encrypted.includes(Buffer.from('ORIGINAL-INDEPENDENT-REF')),
  'old independent reference remains in encrypted profile archive for recovery');
 assert.ok(encrypted.includes(Buffer.from(old.id)));
 assert.ok((await h.profiles.backupList('personal')).length>0);
});

test('Explicit owner profile-code edits remain possible, and unrelated edits retain reference',async t=>{
 const h=await library(t);
 const data=complete('walmart','preserve-explicit@example.test');
 data.profileSecurityCode='INDEPENDENT-REF-OLD';
 await commit(h,await preview(h,[data]));
 let row=(await h.lib.list(event,h.p)).profiles[0];
 await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,
  fields:LC.values(row.data),profileSecurityCode:'INDEPENDENT-REF-NEW',confirmSecurityCodeChange:true});
 row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'INDEPENDENT-REF-NEW');
 await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data)});
 row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'INDEPENDENT-REF-NEW');
 await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,
  fields:LC.values(row.data),profileSecurityCode:'',confirmSecurityCodeChange:true});
 row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'','explicitly authorized independent-reference clear is permitted');
});


test('Strict recovery matches every card digit, rejects missing or altered PAN and leaves existing vault unchanged',async t=>{
 const h=await library(t),email='strict-recovery@example.test';
 await commit(h,await preview(h,[complete('target',email)]));
 const original=complete('target',email);
 original.profileSecurityCode='INDEPENDENT-REFERENCE-ONLY';
 const source=(value)=>({...original,cc_number:value,retailer:'target'});
 const before=await fs.readFile(h.profiles.paths.personal);
 const check=async(raw)=>h.lib.recoveryReview(event,{...h.p,files:[{fileName:'target-profiles.json',text:JSON.stringify([raw])}]});
 const good=await check(source('4242 4242-4242 4242'));
 assert.equal(good.originalFiles.potentialMatches,1,'formatted full PAN with exact same digits matches');
 const missing=await check(source(''));
 assert.equal(missing.originalFiles.potentialMatches,0,'missing card number is never a match');
 assert.equal(missing.originalFiles.cardMismatches,1);
 const oneChanged=await check(source('4242424242424243'));
 assert.equal(oneChanged.originalFiles.potentialMatches,0,'even one different digit rejects the source');
 assert.equal(oneChanged.originalFiles.cardMismatches,1);
 const sameLastFour=await check(source('5555555555554242'));
 assert.equal(sameLastFour.originalFiles.potentialMatches,0,'matching last four is insufficient');
 assert.equal(sameLastFour.originalFiles.cardMismatches,1);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before,'review must remain read-only');
 assert.ok(!JSON.stringify(good).includes(original.profileSecurityCode),'no reference contents in report');
});

test('Legacy slot presence only counts exact complete-card identity matches, never restores ambiguous values',async t=>{
 const h=await library(t),email='strict-legacy@example.test';
 await commit(h,await preview(h,[complete('target',email)]));
 const original=complete('target',email);
 original.cc_cvv='SYNTHETIC-LEGACY-COLUMN-ONLY';
 const before=await fs.readFile(h.profiles.paths.personal);
 const check=async(raw)=>h.lib.recoveryReview(event,{...h.p,files:[{fileName:'target-history.json',text:JSON.stringify([{...raw,retailer:'target'}])}]});
 const good=await check(original);
 assert.equal(good.originalFiles.legacyIdentityMatches,1);
 assert.equal(good.originalFiles.potentialMatches,0,'legacy column is not automatically restored');
 const noCard=await check({...original,cc_number:''});
 assert.equal(noCard.originalFiles.legacyIdentityMatches,0);
 assert.equal(noCard.originalFiles.legacyIdentityCardMismatches,1);
 const wrong=await check({...original,cc_number:'5555555555554444'});
 assert.equal(wrong.originalFiles.legacyIdentityMatches,0);
 assert.equal(wrong.originalFiles.legacyIdentityCardMismatches,1);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before);
 assert.ok(!JSON.stringify(good).includes(original.cc_cvv));
});


test('Original-file recovery preview requires the exact full card number before a reference may be restored',async t=>{
 const h=await library(t),email='exact-original@example.test';
 await commit(h,await preview(h,[complete('target',email)]));
 const original=complete('target',email);
 original.profileSecurityCode='NONPAYMENT-REF-SYNTHETIC';
 const before=await fs.readFile(h.profiles.paths.personal);
 const request=(number)=>h.lib.recoverCodesFromFile(event,{...h.p,retailer:'target',
  fileName:'target-original.json',text:JSON.stringify([{...original,cc_number:number}]),independentOnly:true});
 const absent=await request('');
 assert.equal(absent.recoverable,0);
 const changed=await request('4242424242424243');
 assert.equal(changed.recoverable,0);
 const lastFour=await request('5555555555554242');
 assert.equal(lastFour.recoverable,0);
 const match=await request('4242424242424242');
 assert.equal(match.recoverable,1);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before,'previews cannot modify saved references');
 await assert.rejects(h.lib.recoverCodesFromFile(event,{...h.p,retailer:'target',
  token:match.token,confirmed:true}),/mode changed/,'recovery mode cannot change after preview');
 await h.profiles.libraryTransaction('personal',null,ctx=>{
  ctx.rows[0].data.cc_number='5'.repeat(16);
  return {saved:true};
 },()=>{});
 await assert.rejects(h.lib.recoverCodesFromFile(event,{...h.p,retailer:'target',
  token:match.token,confirmed:true,independentOnly:true}),/complete card identity changed/,
 'the full card identity must still match when confirmation is attempted');
});


test('Historical encrypted copy review requires full card equality, not merely last four or an absent number',async t=>{
 const h=await library(t);
 const data=complete('target','historic-identity@example.test');
 await commit(h,await preview(h,[data]));
 const rows=(await h.profiles.fieldSnapshot('personal',null));
 const current=rows[0];
 const other=structuredClone(current);
 other.data.profileSecurityCode='INDEPENDENT-NONPAYMENT-REF';
 const fileName='personal-retailer-profiles.old.encrypted';
 const past={version:1,groups:{owner:[other]}};
 const folder=path.join(h.dir,'backups');
 await fs.mkdir(folder,{recursive:true});
 const saved=path.join(folder,fileName);
 const snapshot=async()=>h.profiles.historicSourceReview('personal',null);
 const save=async()=>fs.writeFile(saved,Buffer.from('ENCRYPTED:'+JSON.stringify(past)));
 t.after(async()=>fs.rm(saved,{force:true}));
 await save();
 const exact=await snapshot();
 assert.equal(exact.matched,1);
 other.data.cc_number='5555555555554242';
 await save();
 assert.equal((await snapshot()).matched,0,'last four matching is not sufficient');
 other.data.cc_number='';
 await save();
 assert.equal((await snapshot()).matched,0,'missing complete card number is not sufficient');
 other.data.cc_number='4242424242424243';
 await save();
 assert.equal((await snapshot()).matched,0,'a changed digit rejects historical match');
});

test('Export reads matching saved Card Bank independent reference into temporary file only, preserving original master profile',async t=>{
 const h=await library(t);
 for(const retailer of ['target','walmart']){
  const original=complete(retailer,'matched-'+retailer+'@example.test');
  const number=retailer==='target'?card.number:'5555555555554444';
  LC.putCard(original,{...fullCard,number});
  await commit(h,await preview(h,[original],h.p,retailer));
  const row=(await h.lib.list(event,h.p)).profiles.find(x=>x.retailer===retailer);
  assert.equal(LC.profileCode(row.data),'');
  await h.service.addCard(event,{...h.p,card:{...card,number,customSecurityCode:'00BANK-'+retailer}});
  for(const format of ['retailer','json','csv','tsv','txt']){
   const result=await h.lib.exportFile(event,{...h.p,retailer,profileIds:[row.id],exportFormat:format});
   assert.equal(result.saved,true);
   assert.ok(h.writes.at(-1)[1].includes('00BANK-'+retailer),'export copy must include matched bank code for '+retailer+' '+format);
  }
  const before=(await h.lib.list(event,h.p)).profiles.find(x=>x.id===row.id);
  assert.equal(LC.profileCode(before.data),'','a successful export must never write an independent code into the master profile');
  const archive=await h.lib.exportArchive(event,{...h.p,retailer,profileIds:[row.id]});
  assert.equal(archive.saved,true);
  const record=JSON.parse(h.writes.at(-1)[1]).profiles[0];
  assert.equal(record.profileSecurityCode,'00BANK-'+retailer);
 }
});

test('Export blocks missing references without producing incomplete files or changing encrypted data',async t=>{
 const h=await library(t),original=complete('target','missing-code@example.test');
 await commit(h,await preview(h,[original]));
 const row=(await h.lib.list(event,h.p)).profiles[0],vaultBefore=await fs.readFile(h.profiles.paths.personal);
 await assert.rejects(h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:[row.id]}),/Export BLOCKED.*missing/);
 await assert.rejects(h.lib.exportArchive(event,{...h.p,retailer:'target',profileIds:[row.id]}),/Export BLOCKED.*missing/);
 assert.equal(h.writes.length,0);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),vaultBefore);
});

test('Export refuses different Security Codes for the identical full card number',async t=>{
 const h=await library(t),original=complete('target','conflicting-code@example.test');
 original.profileSecurityCode='PROFILE-REF';
 await commit(h,await preview(h,[original]));
 await h.service.addCard(event,{...h.p,card:{...card,customSecurityCode:'BANK-REF'}});
 const row=(await h.lib.list(event,h.p)).profiles[0];
 await assert.rejects(h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:[row.id]}),/Export BLOCKED.*conflicting/);
 assert.equal(h.writes.length,0);
 assert.equal((await h.lib.list(event,h.p)).profiles[0].data.profileSecurityCode,'PROFILE-REF');
});

test('Full card number, not matching last four digits, determines Security Code used for export',async t=>{
 const h=await library(t),original=complete('target','exact-card@example.test');
 await commit(h,await preview(h,[original]));
 await h.service.addCard(event,{...h.p,card:{...card,number:'5555555555554242',customSecurityCode:'WRONG-REFERENCE'}});
 const row=(await h.lib.list(event,h.p)).profiles[0];
 await assert.rejects(h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:[row.id]}),/Export BLOCKED.*missing/);
 assert.equal(h.writes.length,0);
});

test('Ordinary profile changes cannot silently remove or replace an existing Security Code',async t=>{
 const h=await library(t),data=complete('target','never-clear@example.test');
 data.profileSecurityCode='NONPAYMENT-REF-0042';
 await commit(h,await preview(h,[data]));
 const row=(await h.lib.list(event,h.p)).profiles[0];
 const before=await fs.readFile(h.profiles.paths.personal);
 await assert.rejects(h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),profileSecurityCode:''}),/explicit separate confirmation/);
 await assert.rejects(h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),profileSecurityCode:'REPLACEMENT'}),/explicit separate confirmation/);
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),before);
 const saved=await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data)});
 assert.equal(saved.updated,true);
 assert.equal((await h.lib.list(event,h.p)).profiles[0].data.profileSecurityCode,'NONPAYMENT-REF-0042');
});

test('45-row Target Shikari export retains each different independent Security Code in the exact cc_cvv column',async t=>{
 const h=await library(t),sources=[];
 for(let i=0;i<45;i++){
  const data=complete('target','batch-'+i+'@example.test');
  LC.putCard(data,{...fullCard,number:'411111111111'+String(1000+i)});
  data.profileSecurityCode='SYNTHETIC-REF-'+String(i).padStart(4,'0');
  sources.push(data);
 }
 await commit(h,await preview(h,sources));
 const selected=(await h.lib.list(event,h.p)).profiles.map(row=>row.id);
 assert.equal(selected.length,45);
 const result=await h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:selected,customerName:'Batch 45',exportFormat:'retailer'});
 assert.equal(result.saved,true);
 const body=h.writes.at(-1)[1],parsed=Core.parseFile('Batch 45 profiles.csv',body);
 assert.equal(parsed.records.length,45);
 const expected=new Map(sources.map(source=>[source.cc_number,source.profileSecurityCode]));
 for(const row of parsed.records){
  assert.equal(row.cc_cvv,expected.get(row.cc_number),'Security Code must follow exact full card number, never the array index');
  assert.ok(row.cc_cvv,'Never silently emit a blank Security Code');
 }
});

test('45-row Target export refuses 40 missing Security Codes without writing any file',async t=>{
 const h=await library(t),sources=[];
 for(let i=0;i<45;i++){
  const data=complete('target','partial-'+i+'@example.test');
  LC.putCard(data,{...fullCard,number:'411111111111'+String(2000+i)});
  if(i<5)data.profileSecurityCode='SYNTHETIC-PRESENT-'+i;
  sources.push(data);
 }
 await commit(h,await preview(h,sources));
 const rows=(await h.lib.list(event,h.p)).profiles;
 assert.throws(()=>LC.exportRows(rows,'target','Partial 45'),/Export blocked: 40 Target profiles/,'Direct retailer format export must also fail closed');
 await assert.rejects(h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:rows.map(row=>row.id)}),/Export BLOCKED: 40 missing/);
 assert.equal(h.writes.length,0);
});

test('Recovery review offers an explicitly confirmed saved Card Bank restore action',()=>{
 const ui=require('node:fs').readFileSync(require.resolve('../profile-library-ui.js'),'utf8');
 assert.match(ui,/Preview saved Card Bank recovery/);
 assert.match(ui,/restoreFromBank\.hidden=!\(Number\(report\.savedCardBank\?\.potentialMatches/);
 assert.match(ui,/recoverCodesFromSavedCards\(\{\.\.\.owner,confirmed:false\}\)/);
 assert.match(ui,/window\.confirm\('Restore '\+plan\.recoverable/);
 assert.match(ui,/recoverCodesFromSavedCards\(\{\.\.\.owner,confirmed:true,token:plan\.token\}\)/);
});
test('Saved-bank recovery restores only exact full-card matches and preserves all unrelated profiles',async t=>{
 const h=await library(t),data=[];
 for(let i=0;i<8;i++){
  const row=complete('target','missing-bank-'+i+'@example.test');
  LC.putCard(row,{...fullCard,number:'411111111111'+String(1000+i)});
  data.push(row);
 }
 data[7].profileSecurityCode='KEEP-PROFILE-REFERENCE';
 await commit(h,await preview(h,data));
 for(let i=0;i<4;i++)await h.service.addCard(event,{...h.p,card:{...card,number:'411111111111'+String(1000+i),customSecurityCode:'REF-EXACT-'+i}});
 // Last four digits alone, a different complete card number, or the wrong vault never qualifies.
 await h.service.addCard(event,{...h.a,card:{...card,number:'4111111111111004',customSecurityCode:'OTHER-VAULT-REF'}});
 const scan=await h.lib.recoveryReview(event,h.p);
 assert.equal(scan.savedCardBank.potentialMatches,4);
 assert.equal(scan.missingProfiles,7);
 const planned=await h.lib.recoverCodesFromSavedCards(event,{...h.p,confirmed:false});
 assert.equal(planned.recoverable,4);
 assert.equal((await h.lib.list(event,h.p)).profiles.filter(x=>LC.profileCode(x.data)).length,1);
 await assert.rejects(h.lib.recoverCodesFromSavedCards(event,{...h.p,confirmed:true,token:'incorrect-token'}),/expired/);
 const result=await h.lib.recoverCodesFromSavedCards(event,{...h.p,confirmed:true,token:planned.token});
 assert.equal(result.restored,4);
 assert.equal(result.stillMissing,3);
 const stored=(await h.lib.list(event,h.p)).profiles;
 for(let i=0;i<4;i++)assert.equal(stored.find(x=>x.email==='missing-bank-'+i+'@example.test').data.profileSecurityCode,'REF-EXACT-'+i);
 for(let i=4;i<7;i++)assert.equal(LC.profileCode(stored.find(x=>x.email==='missing-bank-'+i+'@example.test').data),'');
 assert.equal(stored.find(x=>x.email==='missing-bank-7@example.test').data.profileSecurityCode,'KEEP-PROFILE-REFERENCE');
 assert.equal((await h.lib.list(event,h.a)).profiles.length,0);
});

test('Selected 45 Target profiles: diagnose the single missing reference without exposing or editing any codes',async t=>{
 const h=await library(t),sources=[];
 for(let i=0;i<45;i++){
  const data=complete('target','one-missing-'+i+'@example.test');
  LC.putCard(data,{...fullCard,number:'411111111111'+String(3000+i)});
  if(i!==28)data.profileSecurityCode='NONPAYMENT-REFERENCE-'+i;
  sources.push(data);
 }
 await commit(h,await preview(h,sources));
 const rows=(await h.lib.list(event,h.p)).profiles,ids=rows.map(row=>row.id);
 const encryptedBefore=await fs.readFile(h.profiles.paths.personal);
 const diagnose=await h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:ids,diagnoseOnly:true});
 assert.deepEqual([diagnose.selected,diagnose.ready,diagnose.missing,diagnose.conflicting],[45,44,1,0]);
 assert.equal(diagnose.issues.length,1);
 assert.equal(diagnose.issues[0].email,'one-missing-28@example.test');
 assert.equal(diagnose.issues[0].cardLast4,'3028');
 assert.equal(diagnose.issues[0].reason,'missing');
 assert.equal(diagnose.readyProfileIds.length,44);
 assert.ok(!diagnose.readyProfileIds.includes(diagnose.issues[0].profileId));
 assert.ok(!JSON.stringify(diagnose).includes('NONPAYMENT-REFERENCE-'),'read-only diagnostics must not reveal any reference values');
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),encryptedBefore,'diagnostics must not change vault data');
 assert.equal(h.writes.length,0,'diagnostic mode must not export or write anything');
 await assert.rejects(h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:ids}),/Export BLOCKED: 1 missing and 0 conflicting/);
 assert.equal(h.writes.length,0);
 const result=await h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:diagnose.readyProfileIds});
 assert.equal(result.saved,true);assert.equal(result.count,44);
 const parsed=Core.parseFile('44 ready profiles.csv',h.writes.at(-1)[1]);
 assert.equal(parsed.records.length,44);
 assert.ok(parsed.records.every(row=>typeof row.cc_cvv==='string'&&row.cc_cvv.length>0));
 assert.equal((await h.lib.list(event,h.p)).profiles.length,45,'incomplete profile must remain saved');
});
test('Read-only export diagnostics obey owner authentication and never leak sensitive reference values',async t=>{
 const h=await library(t);
 const data=complete('target','scoped-export-diagnosis@example.test');
 data.profileSecurityCode='PRIVATE-REFERENCE-EXAMPLE';
 await commit(h,await preview(h,[data]));
 const id=(await h.lib.list(event,h.p)).profiles[0].id;
 await assert.rejects(h.lib.exportFile(foreign,{...h.p,retailer:'target',profileIds:[id],diagnoseOnly:true}),/owner|unauthorized/i);
 const diagnosis=await h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:[id],diagnoseOnly:true});
 assert.equal(diagnosis.ready,1);
 assert.ok(!JSON.stringify(diagnosis).includes('PRIVATE-REFERENCE-EXAMPLE'));
 assert.equal(h.writes.length,0);
});
test('Selected export failure UI highlights the problem and requires consent before excluding any profile',()=>{
 const ui=require('node:fs').readFileSync(require.resolve('../profile-library-ui.js'),'utf8');
 assert.match(ui,/Review blocked export/);
 assert.match(ui,/diagnoseOnly:true/);
 assert.match(ui,/Find this profile/);
 assert.match(ui,/Export '\+report\.ready\+' complete profiles only/);
 assert.match(ui,/window\.confirm\('Export only '/);
});
