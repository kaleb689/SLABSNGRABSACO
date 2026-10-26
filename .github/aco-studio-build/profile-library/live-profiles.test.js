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
async function library(t){const h=await env(t);let allowed=true;const lib=createLibrary({profiles:h.profiles,cardVault:s=>s==='personal'?h.personal:h.customers,authorize:async(e,s,id)=>{if(e.sender.id!==1)throw Error('Not owner');if(s==='aco'&&!['customer-a','customer-b'].includes(id))throw Error('Unauthorized customer');return s==='personal'?null:id;},guard:(e,s)=>{if(e.sender.id!==1||!allowed)throw Error('Locked');},chooseSave:async(_e,o)=>({filePath:path.join(h.dir,o.name)}),confirmExport:async()=>true,writeFile:async(...args)=>h.writes.push(args),getCustomerProfileSource:async id=>({customer:{id,name:id},linked:[{customerId:id,assignmentId:'linked-1',retailer:'pokemoncenter',active:true,data:complete('pokemoncenter','linked@example.test')}]})});return {...h,lib,lockLibrary:()=>allowed=false};}
function complete(retailer,email){const data=D.blank(retailer,LC.format(retailer),{email,first:'Alex',last:'Example',phone:'9545550100','shipping.address1':'100 Example Avenue','shipping.city':'Sample','shipping.state':'FL','shipping.zip':'33324','billing.address1':'100 Example Avenue','billing.city':'Sample','billing.state':'FL','billing.zip':'33324'});LC.putCard(data,fullCard);return data;}
async function preview(h,data,owner=h.p,retailer='target'){return h.lib.importPreview(event,{...owner,retailer,fileName:'profiles.json',text:JSON.stringify(data)});}
async function commit(h,preview,extra={}){return h.lib.importCommit(event,{token:preview.token,confirmed:true,alreadyJigged:true,repairs:{allowShared:true},...extra});}

async function live(h,rows,owner=h.p,retailer='target',fileName='profiles.json'){
 return h.lib.importPreview(event,{...owner,bank:'live',retailer,fileName,text:JSON.stringify(rows)});
}
test('Live imports keep current data, credentials and retailer banks, with no duplicate PKC seeding',async t=>{
 const h=await library(t),retailers=['target','walmart','pokemoncenter','costco','sams'];
 const files=retailers.map(r=>{const data=complete(r,r+'@example.test');data.password='current-login';data.extraSetting='keep-current';return {fileName:(r==='pokemoncenter'?'PKC':r)+' profiles.json',text:JSON.stringify([data])};});
 const plan=await h.lib.importPreview(event,{...h.p,bank:'live',retailer:'target',files});assert.deepEqual(plan.counts,Object.fromEntries(retailers.map(r=>[r,1])));
 const result=await commit(h,plan);assert.equal(result.imported,5);assert.equal(result.pkcEmailsAdded,4);
 const rows=(await h.lib.list(event,h.p)).profiles;assert.equal(rows.length,5);assert.ok(rows.every(x=>x.bank==='live'&&x.liveSince));
 for(const row of rows){assert.equal(row.data.password,'current-login');assert.equal(row.data.extraSetting,'keep-current');assert.equal(row.data.shipping_street||row.data.shipping.addressLine1,address.address1);}
 const emails=await h.service.emails(event,{...h.p,retailer:'pokemoncenter'});assert.equal(emails.availableForCreation,4);assert.ok(!emails.emails.some(x=>x.email==='pokemoncenter@example.test'&&x.status==='available'));
 assert.equal((await h.lib.list(event,h.a)).profiles.length,0);
});
test('Retailer metadata overrides filenames; unlabeled Valor uses the selected retailer',async t=>{
 const h=await library(t),a=complete('walmart','a@example.test');a.retailer='Sam’s Club';
 const p=await live(h,[a],h.p,'target','Walmart profiles.json');assert.equal(p.profiles[0].retailer,'sams');await commit(h,p);
 const b=await live(h,[complete('costco','b@example.test')],h.p,'costco');assert.equal(b.profiles[0].retailer,'costco');await commit(h,b);
 assert.equal((await h.lib.list(event,h.p)).profiles.length,2);
});
test('Owner PKC email inventory never reads or borrows customer A/B reservations',async t=>{
 const h=await library(t);await h.profiles.importRows({...h.a,retailer:'pokemoncenter',rows:[complete('pokemoncenter','used@example.test')]});
 await h.service.importEmails(event,{...h.b,retailer:'pokemoncenter',emails:['reserved@example.test']});
 const plan=await live(h,[{...complete('target','new@example.test'),retailer:'target'},{...complete('walmart','new@example.test'),retailer:'walmart'},complete('target','used@example.test'),complete('target','reserved@example.test')]);
 const result=await commit(h,plan);assert.equal(result.pkcEmailsAdded,3);const inventory=await h.service.emails(event,{...h.p,retailer:'pokemoncenter'});assert.deepEqual(inventory.emails.map(x=>x.email).sort(),['new@example.test','reserved@example.test','used@example.test']);
 const another=await live(h,[complete('costco','new@example.test')],h.p,'costco');assert.equal((await commit(h,another)).pkcEmailsAdded,0);
});
test('Reimport requires reviewed replacement and stable preview; edits and jigs retain Live bank membership',async t=>{
 const h=await library(t),data=complete('target','live@example.test');await commit(h,await live(h,[data]));let row=(await h.lib.list(event,h.p)).profiles[0],id=row.id;
 const plan=await live(h,[{...data,password:'replacement'}]);assert.equal(plan.matches,1);const kept=await commit(h,plan);assert.equal(kept.imported,1);assert.equal((await h.lib.list(event,h.p)).profiles.length,2);const replacing=await live(h,[{...data,password:'replacement'}]);assert.equal(replacing.duplicateCount,1);
 row=(await h.lib.list(event,h.p)).profiles.find(x=>x.id===id);assert.equal(row.id,id);assert.notEqual(row.data.password,'replacement');
 const stale=await live(h,[data]);await h.lib.edit(event,{...h.p,profileId:id,revision:row.revision,fields:{...LC.values(row.data),first:'Changed',last:'Person'}});const retained=await commit(h,stale,{updateExisting:true});assert.equal(retained.imported,1);
 const jig=await h.lib.batchJigPreview(event,{...h.p,retailer:'target',profileIds:[id],ruleIds:[LC.FL_PHONE_RULE],combine:false,billingSameAsShipping:true});await h.lib.batchJigCommit(event,{token:jig.token,confirmed:true});
 row=(await h.lib.list(event,h.p)).profiles[0];assert.equal(row.bank,'live');assert.equal(row.id,id);assert.equal(row.data.shipping_first_name,'Changed');assert.equal((await h.service.emails(event,{...h.p,retailer:'target'})).availableForCreation,0);
});
test('Duplicate same-retailer imports remain separate; cancelled, locked and foreign-owner imports cause no extra changes',async t=>{
 const h=await library(t),data=complete('target','live@example.test');const duplicatePlan=await live(h,[data,data]);assert.equal(duplicatePlan.duplicateCount,2);const imported=await commit(h,duplicatePlan);assert.equal(imported.imported,2);assert.equal((await h.lib.list(event,h.p)).profiles.filter(x=>x.duplicates.includes('email')).length,2);
 await assert.rejects(live(h,[{...data,customerId:'customer-b'}],h.a),/ownership/);
 const p=await live(h,[data]);h.lib.cancel(event);await assert.rejects(commit(h,p),/expired/);assert.equal((await h.lib.list(event,h.p)).profiles.length,2);assert.equal((await h.service.emails(event,{...h.p,retailer:'pokemoncenter'})).emails.filter(x=>x.email==='live@example.test').length,1);
 const locked=await live(h,[data]);h.lockLibrary();await assert.rejects(commit(h,locked),/Locked/);
});
test('A customer Live bank stays isolated and live accounts are never consumed as free accounts',async t=>{
 const h=await library(t);await commit(h,await live(h,[complete('target','customer@example.test')],h.a));
 const row=(await h.lib.list(event,h.a)).profiles[0];assert.equal(row.bank,'live');assert.equal((await h.lib.list(event,h.b)).profiles.length,0);assert.equal((await h.lib.list(event,h.p)).profiles.length,0);
 await h.profiles.setStatus('aco','customer-a',row.id,'available');assert.equal((await h.service.emails(event,{...h.a,retailer:'target'})).freeAccounts,0);
 const plan=await live(h,[{...complete('target','other@example.test'),retailer:'target'},{...complete('pokemoncenter','other@example.test'),retailer:'pkc'}],h.a);
 assert.equal((await commit(h,plan)).pkcEmailsAdded,0);
});


test('Personal, Mike, and Derick never share cards, address IDs, profile cards, or Hard Card settings',async t=>{
 const h=await library(t);
 const ownerCard=await h.service.addCard(event,{...h.p,card:{...card,number:'4000000000000002',label:'Owner card'}});
 const mikeCard=await h.service.addCard(event,{...h.a,card:{...card,number:'5555555555554444',label:'Mike card'}});
 const derickCard=await h.service.addCard(event,{...h.b,card:{...card,number:'6011111111111117',label:'Derick card'}});
 const ownerAddress=await h.service.addAddress(event,{...h.p,address:{...address,address1:'101 Owner Address'}});
 const mikeAddress=await h.service.addAddress(event,{...h.a,address:{...address,address1:'202 Mike Address'}});
 const derickAddress=await h.service.addAddress(event,{...h.b,address:{...address,address1:'303 Derick Address'}});
 const personal=await h.profiles.importRows({...h.p,retailer:'target',rows:[complete('target','owner-account@example.test')]});
 const ownerProfileId=personal.added[0].id;
 const mikeProfile=await h.profiles.importRows({...h.a,retailer:'target',rows:[complete('target','mike-account@example.test')]});
 const derickProfile=await h.profiles.importRows({...h.b,retailer:'target',rows:[complete('target','derick-account@example.test')]});
 const refs=[['Personal',h.p,ownerCard,ownerAddress,'owner-account@example.test'],['Mike',h.a,mikeCard,mikeAddress,'mike-account@example.test'],['Derick',h.b,derickCard,derickAddress,'derick-account@example.test']];
 for(const [name,owner,ownedCard,ownedAddress,onlyEmail] of refs){
  const a=await h.service.assets(event,owner);
  assert.equal(a.cards.length,1,name+' must only have own saved card');
  assert.equal(a.cards[0].id,ownedCard.id);
  assert.equal(a.addresses.length,1);
  assert.equal(a.addresses[0].id,ownedAddress.id);
  assert.equal(a.profiles.length,1);
  assert.equal(a.profiles[0].email,onlyEmail);
  assert.equal(a.cardPool.length,2,'Saved and profile cards are both listed, but not from foreign vaults');
  assert.ok(!JSON.stringify(a).includes('101 Owner Address')||name==='Personal');
  assert.ok(!JSON.stringify(a).includes('202 Mike Address')||name==='Mike');
  assert.ok(!JSON.stringify(a).includes('303 Derick Address')||name==='Derick');
 }
 await h.service.setHardCard(event,{...h.p,cardRef:'saved:'+ownerCard.id,hard:true,confirmed:true});
 let ownerAssets=await h.service.assets(event,h.p);
 assert.ok(ownerAssets.cardPool.find(x=>x.last4==='0002').hardCard);
 assert.equal((await h.service.assets(event,h.a)).cardPool.some(x=>x.hardCard),false);
 assert.equal((await h.service.assets(event,h.b)).cardPool.some(x=>x.hardCard),false);
 await assert.rejects(h.service.setHardCard(event,{...h.a,cardRef:'saved:'+ownerCard.id,hard:true,confirmed:true}),/not in this vault/);
 await assert.rejects(h.service.setHardCard(event,{...h.b,cardRef:'saved:'+mikeCard.id,hard:true,confirmed:true}),/not in this vault/);
 await assert.rejects(h.service.addProfileCardToBank(event,{...h.a,profileId:ownerProfileId,confirmed:true}),/not found in this vault/);
 await assert.rejects(h.service.addProfileCardToBank(event,{...h.b,profileId:mikeProfile.added[0].id,confirmed:true}),/not found in this vault/);
 await assert.rejects(h.service.generate(event,{...h.a,retailer:'target',count:1,format:'shikari',addressIds:[ownerAddress.id],cardIds:[mikeCard.id]}),/not in this (exact )?vault/);
 await assert.rejects(h.service.generate(event,{...h.b,retailer:'target',count:1,format:'shikari',addressIds:[derickAddress.id],cardIds:[mikeCard.id]}),/not in this (exact )?vault/);
 assert.equal((await h.profiles.fieldSnapshot('personal',null)).length,1);
 assert.equal((await h.profiles.fieldSnapshot('aco','customer-a')).length,1);
 assert.equal((await h.profiles.fieldSnapshot('aco','customer-b')).length,1);
});
test('192 Target Live profiles reconcile to PKC coverage without creating false duplicate PKC profiles',async t=>{
 const h=await library(t);
 const email=i=>'target-'+String(i+1).padStart(3,'0')+'@example.test';
 // First 100 PKC emails already have actual PKC profiles, so only 92
 // unused PKC pool emails should be available from 192 Target identities.
 await h.profiles.importRows({...h.p,retailer:'pokemoncenter',
  rows:Array.from({length:100},(_,i)=>complete('pokemoncenter',email(i)))});
 const imported=await live(h,Array.from({length:192},(_,i)=>complete('target',email(i))));
 const first=await commit(h,imported);
 assert.equal(first.imported,192);
 assert.equal(first.pkcEmailsAdded,92);
 let inventory=await h.service.emails(event,{...h.p,retailer:'pokemoncenter'});
 assert.equal(inventory.availableForCreation,92);
 assert.equal(inventory.targetLiveReconciliation.targetLiveProfiles,192);
 assert.equal(inventory.targetLiveReconciliation.targetUniqueEmails,192);
 assert.equal(inventory.targetLiveReconciliation.alreadyPkcProfiles,100);
 assert.equal(inventory.targetLiveReconciliation.pkcCoverage,192);
 assert.equal(inventory.retailerStats.profileCount,100,'PKC profile rows are separate from unused emails');
 assert.equal(inventory.retailerStats.unusedAccountCount,92,'Unused PKC email pool must not display the stored PKC profile count');
 assert.equal(inventory.retailerStats.unusedEmailCount,92);
 assert.equal(inventory.targetLiveReconciliation.pkcUnusedTotal,92);
 assert.equal(inventory.targetLiveReconciliation.pkcProfileCount,100);

 // Simulate legacy version having lost the Target->PKC email-bank seeding.
 await h.profiles.libraryTransaction('personal',null,context=>{
  for(let i=context.emails.length-1;i>=0;i--)if(context.emails[i].source==='live-profile-import')context.emails.splice(i,1);
 },()=>{});
 inventory=await h.service.emails(event,{...h.p,retailer:'pokemoncenter'});
 assert.equal(inventory.targetLiveReconciliation.added,92);
 assert.equal(inventory.targetLiveReconciliation.pkcCoverage,192);
 assert.equal(inventory.availableForCreation,92);
 const repeated=await h.service.emails(event,{...h.p,retailer:'pokemoncenter'});
 assert.equal(repeated.targetLiveReconciliation.added,0);
 assert.equal(repeated.emails.filter(x=>x.status==='available').length,92);
 const stored=(await h.lib.list(event,h.p)).profiles;
 assert.equal(stored.filter(x=>x.retailer==='target'&&x.bank==='live').length,192);
 assert.equal(stored.filter(x=>x.retailer==='pokemoncenter').length,100);
});
test('PKC reconciliation stays in the authorized customer vault and never imports other customers Target records',async t=>{
 const h=await library(t);
 const plan=await live(h,[complete('target','a-vault@example.test')],h.a,'target');
 await commit(h,plan);
 await h.profiles.libraryTransaction('aco','customer-a',ctx=>{ctx.emails.splice(0,ctx.emails.length);},()=>{});
 const a=await h.service.emails(event,{...h.a,retailer:'pokemoncenter'});
 assert.equal(a.targetLiveReconciliation.added,1);
 assert.equal(a.targetLiveReconciliation.targetLiveProfiles,1);
 const b=await h.service.emails(event,{...h.b,retailer:'pokemoncenter'});
 assert.equal(b.targetLiveReconciliation.targetLiveProfiles,0);
 assert.equal(b.availableForCreation,0);
 const personal=await h.service.emails(event,{...h.p,retailer:'pokemoncenter'});
 assert.equal(personal.targetLiveReconciliation.targetLiveProfiles,0);
 assert.equal(personal.availableForCreation,0);
});

test('pasted email login pairs retain exact password values and enter the selected retailer account bank',async t=>{
 const h=await library(t);
 const input=[
  {email:'test-one@example.test',password:'abc@#%$1:rest'},
  {email:'test-two@example.test',password:'!Case:Sensitive#2$'}
 ];
 const preview=await h.lib.importPreview(event,{...h.p,retailer:'target',fileName:'pasted-logins.json',text:JSON.stringify(input)});
 assert.equal(preview.count,2);
 assert.ok(preview.profiles.every(p=>!Object.hasOwn(p,'password')),'Preview must not expose secrets');
 const imported=await h.lib.importCommit(event,{token:preview.token,confirmed:true,asAvailable:true,repairs:{allowShared:true}});
 assert.equal(imported.imported,2);
 const rows=await h.profiles.fieldSnapshot('personal',null);
 assert.equal(rows.length,2);
 for(let i=0;i<2;i++){
  assert.equal(rows[i].status,'available');
  assert.equal(rows[i].data.password,input[i].password);
  assert.equal(rows[i].email,input[i].email);
 }
 const pool=await h.service.emails(event,{...h.p,retailer:'target'});
 assert.equal(pool.freeAccounts,2);
 assert.equal(pool.availableForCreation,2);
 const addedAddress=await h.service.addAddress(event,{...h.p,address});
 const addedCard=await h.service.addCard(event,{...h.p,card});
 const generated=await h.service.generate(event,{...h.p,retailer:'target',format:'shikari',count:1,randomNames:true,addressIds:[addedAddress.id],cardIds:[addedCard.id]});
 assert.equal(generated.created,1);
 const after=await h.profiles.fieldSnapshot('personal',null);
 assert.equal(after.find(x=>x.email===input[0].email).data.password,input[0].password);
 assert.equal((await h.profiles.fieldSnapshot('aco','customer-a')).length,0);
});
test('pasted login import remains scoped to its selected retailer and customer vault',async t=>{
 const h=await library(t),input=[{email:'shared@example.test',password:'synthetic:!Test#3'}];
 for(const [owner,retailer]of [[h.p,'target'],[h.a,'walmart']]){
  const preview=await h.lib.importPreview(event,{...owner,retailer,fileName:'account-logins.json',text:JSON.stringify(input)});
  await h.lib.importCommit(event,{token:preview.token,confirmed:true,asAvailable:true,repairs:{allowShared:true}});
 }
 const personal=await h.profiles.fieldSnapshot('personal',null);
 const customer=await h.profiles.fieldSnapshot('aco','customer-a');
 assert.equal(personal.length,1);assert.equal(customer.length,1);
 assert.equal(personal[0].retailer,'target');assert.equal(customer[0].retailer,'walmart');
 assert.equal(personal[0].data.password,input[0].password);
 assert.equal(customer[0].data.password,input[0].password);
 assert.equal((await h.service.emails(event,{...h.b,retailer:'walmart'})).freeAccounts,0);
});

test('all Personal retailer profiles and future email bank additions populate unused PKC emails without customer leakage',async t=>{
 const h=await library(t);
 await h.profiles.importRows({...h.p,retailer:'pokemoncenter',rows:[complete('pokemoncenter','already-pkc@example.test')]});
 await h.profiles.importRows({...h.a,retailer:'walmart',rows:[complete('walmart','customer-only@example.test')]});
 await h.profiles.importRows({...h.p,retailer:'walmart',rows:[complete('walmart','walmart-personal@example.test')]});
 await h.profiles.importRows({...h.p,retailer:'costco',rows:[complete('costco','costco-personal@example.test')]});
 await h.profiles.importRows({...h.p,retailer:'sams',rows:[complete('sams','sams-personal@example.test')]});
 await h.profiles.importRows({...h.p,retailer:'target',rows:[complete('target','already-pkc@example.test')]});
 let inventory=await h.service.emails(event,{...h.p,retailer:'pokemoncenter'});
 const available=inventory.emails.filter(x=>x.status==='available').map(x=>x.email).sort();
 assert.deepEqual(available,['costco-personal@example.test','sams-personal@example.test','walmart-personal@example.test']);
 assert.ok(!inventory.emails.some(x=>x.email==='customer-only@example.test'));
 assert.ok(!inventory.emails.some(x=>x.email==='already-pkc@example.test'&&x.status==='available'));
 // Future working profile imports and unused non-PKC emails reconcile on save.
 await h.profiles.importRows({...h.p,retailer:'walmart',rows:[complete('walmart','future-personal@example.test')]});
 await h.service.importEmails(event,{...h.p,retailer:'target',emails:['future-email-bank@example.test']});
 inventory=await h.service.emails(event,{...h.p,retailer:'pokemoncenter'});
 const later=inventory.emails.filter(x=>x.status==='available').map(x=>x.email);
 assert.ok(later.includes('future-personal@example.test'));
 assert.ok(later.includes('future-email-bank@example.test'));
 const before=later.length;
 inventory=await h.service.emails(event,{...h.p,retailer:'pokemoncenter'});
 assert.equal(inventory.emails.filter(x=>x.status==='available').length,before);
 assert.equal(inventory.targetLiveReconciliation.personalAllRetailers,true);
});


test('Importing PKC Live immediately retires matching Ready for Export and Unused profiles but preserves encrypted recovery history',async t=>{
 const h=await library(t),readyEmail='new-pkc-ready@example.test',unusedEmail='new-pkc-unused@example.test';
 await commit(h,await preview(h,[complete('pokemoncenter',readyEmail)],h.p,'pokemoncenter'));
 const unusedImport=await h.profiles.importRows({...h.p,retailer:'pokemoncenter',status:'available',
  rows:[complete('pokemoncenter',unusedEmail)]});
 assert.equal(unusedImport.added.length,1);
 await h.service.importEmails(event,{...h.p,retailer:'pokemoncenter',emails:[readyEmail,unusedEmail]});
 const before=(await h.lib.list(event,h.p)).profiles;
 assert.equal(before.filter(x=>x.retailer==='pokemoncenter'&&x.bank!=='live').length,2);
 const input=[{...complete('pokemoncenter',readyEmail),password:'actual-live-ready'},
  {...complete('pokemoncenter',unusedEmail),password:'actual-live-unused'}];
 const result=await commit(h,await live(h,input,h.p,'pokemoncenter'));
 assert.equal(result.imported,2);
 assert.equal(result.supersededNonLive,2);
 const after=(await h.lib.list(event,h.p)).profiles;
 for(const email of [readyEmail,unusedEmail]){
  const rows=after.filter(x=>x.retailer==='pokemoncenter'&&x.email===email);
  assert.equal(rows.length,1,'Live import replaces all matching non-live accounts within PKC');
  assert.equal(rows[0].bank,'live');
  assert.match(rows[0].data.password,/actual-live/);
 }
 const inv=await h.service.emails(event,{...h.p,retailer:'pokemoncenter'});
 for(const email of [readyEmail,unusedEmail])assert.ok(!inv.emails.some(x=>x.email===email&&x.status==='available'),email+' must be consumed');
 const raw=await fs.readFile(h.profiles.paths.personal);
 assert.equal(raw.toString('utf8').startsWith('ENCRYPTED:'),true);
 const vault=JSON.parse(raw.toString('utf8').slice('ENCRYPTED:'.length));
 const archived=vault.supersededLiveImportProfiles.owner;
 assert.equal(archived.length,2);
 assert.deepEqual(archived.map(x=>x.profile.email).sort(),[readyEmail,unusedEmail].sort());
 assert.ok(archived.every(x=>x.replacedByLiveProfileId&&x.batchId));
 const snapshots=await h.profiles.backupList('personal');assert.ok(snapshots.length>0);
});
test('PKC Live import removes every duplicate Ready profile, not an unrelated retailer or customer record',async t=>{
 const h=await library(t),email='shared-retailer-identity@example.test';
 await h.profiles.importRows({...h.p,retailer:'pokemoncenter',rows:[complete('pokemoncenter',email)]});
 await h.profiles.importRows({...h.p,retailer:'target',rows:[complete('target',email)]});
 await h.profiles.importRows({...h.a,retailer:'pokemoncenter',rows:[complete('pokemoncenter',email)]});
 await h.profiles.libraryTransaction('personal',null,ctx=>{
  const original=ctx.rows.find(r=>r.retailer==='pokemoncenter'&&r.email===email);
  ctx.rows.push({...structuredClone(original),id:'older-pkc-ready-duplicate',createdAt:'2026-10-01T00:00:00.000Z'});
 },()=>{});
 const result=await commit(h,await live(h,[complete('pokemoncenter',email)],h.p,'pokemoncenter'));
 assert.equal(result.supersededNonLive,2);
 const owner=(await h.lib.list(event,h.p)).profiles;
 assert.equal(owner.filter(x=>x.retailer==='pokemoncenter'&&x.email===email).length,1);
 assert.equal(owner.filter(x=>x.retailer==='target'&&x.email===email).length,1);
 assert.equal((await h.lib.list(event,h.a)).profiles.filter(x=>x.retailer==='pokemoncenter'&&x.email===email).length,1);
});
test('A website-linked Ready profile blocks automatic Live duplicate removal and leaves all owner data unchanged',async t=>{
 const h=await library(t),email='linked-protected@example.test';
 await h.profiles.importRows({...h.p,retailer:'pokemoncenter',rows:[complete('pokemoncenter',email)]});
 await h.profiles.libraryTransaction('personal',null,ctx=>{
  const existing=ctx.rows.find(x=>x.retailer==='pokemoncenter'&&x.email===email);
  existing.source='website-linked-profile';existing.sourceLinked=true;existing.websiteAuthoritative=true;
 },()=>{});
 const before=(await h.lib.list(event,h.p)).profiles;
 const p=await live(h,[complete('pokemoncenter',email)],h.p,'pokemoncenter');
 await assert.rejects(commit(h,p),/Unlink it explicitly/);
 const after=(await h.lib.list(event,h.p)).profiles;
 assert.deepEqual(after,before);
});
test('Reusing a Ready profile ID for an explicitly reviewed Live update leaves exactly one Live row',async t=>{
 const h=await library(t),email='upgrade-ready@example.test';
 await h.profiles.importRows({...h.p,retailer:'pokemoncenter',rows:[complete('pokemoncenter',email)]});
 const old=(await h.lib.list(event,h.p)).profiles.find(x=>x.email===email);
 const p=await live(h,[complete('pokemoncenter',email)],h.p,'pokemoncenter');
 const result=await commit(h,p,{updateExisting:true});
 assert.equal(result.supersededNonLive,1);
 const matches=(await h.lib.list(event,h.p)).profiles.filter(x=>x.email===email);
 assert.equal(matches.length,1);assert.equal(matches[0].id,old.id);assert.equal(matches[0].bank,'live');
});


test('A different card from a retired PKC Ready profile returns to the encrypted Card Bank before Live import',async t=>{
 const h=await library(t),email='different-ready-card@example.test';
 const old=complete('pokemoncenter',email);
 LC.putCard(old,{number:'5555555555554444',month:'09',year:'2034',cardholder:'Old Owner'});
 old.custom_security_code='OLD-CARD-REFERENCE';
 await commit(h,await preview(h,[old],h.p,'pokemoncenter'));
 const input=complete('pokemoncenter',email);
 assert.notEqual(LC.payment(old).number,LC.payment(input).number);
 const result=await commit(h,await live(h,[input],h.p,'pokemoncenter'));
 assert.equal(result.supersededNonLive,1);
 assert.equal(result.cardsPreserved,1);
 assert.equal(result.cardsAlreadySaved,0);
 const list=await h.personal.list('personal:owner');
 assert.equal(list.cards.length,1,'old card must be in saved Card Bank');
 const saved=await h.personal.selectedForJig('personal:owner',list.cards.map(x=>x.id));
 assert.equal(saved[0].number,'5555555555554444');
 assert.equal(saved[0].month,'09');
 assert.equal(saved[0].year,'2034');
 const codes=await h.personal.securityReferences('personal:owner');
 assert.equal(codes[0].customSecurityCode,'OLD-CARD-REFERENCE');
 const ownerProfiles=(await h.lib.list(event,h.p)).profiles;
 assert.equal(ownerProfiles.filter(x=>x.retailer==='pokemoncenter'&&x.email===email).length,1);
 assert.equal(ownerProfiles.find(x=>x.email===email).bank,'live');
 const assets=await h.service.assets(event,h.p);
 const restored=assets.cards.find(x=>x.id===list.cards[0].id);
 assert.equal(restored.unused,true,'card should be available for reuse after its Ready/Unused owner is retired');
});
test('A previously saved card is not duplicated when a different Live profile card displaces it',async t=>{
 const h=await library(t),email='saved-ready-card@example.test',old=complete('pokemoncenter',email);
 LC.putCard(old,{number:'5555555555554444',month:'08',year:'2031',cardholder:'Existing Holder'});
 await h.service.addCard(event,{...h.p,card:{number:'5555555555554444',expMonth:'08',expYear:'2031',cardholder:'Existing Holder'}});
 await h.profiles.importRows({...h.p,retailer:'pokemoncenter',rows:[old]});
 const result=await commit(h,await live(h,[complete('pokemoncenter',email)],h.p,'pokemoncenter'));
 assert.equal(result.cardsAlreadySaved,1);
 assert.equal(result.cardsPreserved,0);
 assert.equal((await h.personal.list('personal:owner')).cards.length,1);
});
test('A matching old card does not create a redundant saved Card Bank record',async t=>{
 const h=await library(t),email='same-card@example.test';
 await h.profiles.importRows({...h.p,retailer:'pokemoncenter',rows:[complete('pokemoncenter',email)]});
 const result=await commit(h,await live(h,[complete('pokemoncenter',email)],h.p,'pokemoncenter'));
 assert.equal(result.cardsPreserved,0);
 assert.equal((await h.personal.list('personal:owner')).cards.length,0);
});
test('Unusable old card details stop retirement rather than losing a profile card',async t=>{
 const h=await library(t),email='missing-expiry@example.test',old=complete('pokemoncenter',email);
 old.card.expiration='';
 await h.profiles.importRows({...h.p,retailer:'pokemoncenter',rows:[old]});
 const before=(await h.lib.list(event,h.p)).profiles;
 const plan=await live(h,[complete('pokemoncenter',email)],h.p,'pokemoncenter');
 await assert.rejects(commit(h,plan),/incomplete saved card details/);
 const after=(await h.lib.list(event,h.p)).profiles;
 assert.deepEqual(after,before);
 assert.equal((await h.personal.list('personal:owner')).cards.length,0);
});
test('Customer Card Bank return is scoped to customer, never Personal or a second customer',async t=>{
 const h=await library(t),email='customer-retired-card@example.test',old=complete('pokemoncenter',email);
 LC.putCard(old,{number:'5555555555554444',month:'07',year:'2033',cardholder:'Customer Holder'});
 await h.profiles.importRows({...h.a,retailer:'pokemoncenter',rows:[old]});
 const result=await commit(h,await live(h,[complete('pokemoncenter',email)],h.a,'pokemoncenter'));
 assert.equal(result.cardsPreserved,1);
 assert.equal((await h.customers.list('customer-a')).cards.length,1);
 assert.equal((await h.customers.list('customer-b')).cards.length,0);
 assert.equal((await h.personal.list('personal:owner')).cards.length,0);
});
