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
  await h.lib.batchJigCommit(event,{token:jig.token,confirmed:true});
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
 const updated=await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),profileSecurityCode:'PICKUP-NEW'});
 assert.equal(updated.updated,true);
 assert.ok(!JSON.stringify(updated).includes('PICKUP-NEW'));
 row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'PICKUP-NEW');
 assert.ok(!JSON.stringify(await h.profiles.audit('personal',null)).includes('PICKUP-NEW'));
 await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),profileSecurityCode:''});
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
 await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),profileSecurityCode:''});
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
 assert.ok(ui.includes('api.recoveryReviewSelectedFiles'),'one recovery action invokes the native original file picker');
 assert.ok(!ui.includes('reviewPicker.click()'),'hidden browser file input must not be used for desktop original files');
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
