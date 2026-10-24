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
  const jig=await h.lib.batchJigPreview(event,{...h.p,retailer,profileIds:[row.id],ruleIds:[LC.FL_PHONE_RULE],combine:false,billingSameAsShipping:true});
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
