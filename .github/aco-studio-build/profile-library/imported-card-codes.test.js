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

test('Imported card codes persist in the encrypted Personal vault for both formats',async t=>{
 const h=await library(t);
 for(const owner of [h.p])for(const retailer of ['target','walmart']){
  const data=complete(retailer,owner.scope+'-'+retailer+'@example.test');if(retailer==='target')data.cc_cvv='012';else data.card.cvv='0123';data.profileSecurityCode=retailer==='target'?'8971':'735';
  const plan=await h.lib.importPreview(event,{...owner,bank:'live',retailer,fileName:'profiles.json',text:JSON.stringify([data])});await commit(h,plan);
  const row=(await h.lib.list(event,owner)).profiles.find(x=>x.retailer===retailer);assert.equal(LC.payment(row.data).cvv,retailer==='target'?'012':'0123');
  const loaded=await h.lib.detail(event,{...owner,profileId:row.id});assert.equal(LC.payment(loaded.data).cvv,retailer==='target'?'012':'0123');
  const jig=await h.lib.batchJigPreview(event,{...owner,retailer,profileIds:[row.id],ruleIds:[LC.FL_PHONE_RULE],combine:false,billingSameAsShipping:true});await h.lib.batchJigCommit(event,{token:jig.token,confirmed:true});
  const after=(await h.lib.list(event,owner)).profiles.find(x=>x.id===row.id);assert.equal(LC.payment(after.data).cvv,retailer==='target'?'012':'0123');assert.equal(after.bank,'live');
  await h.lib.exportFile(event,{...owner,retailer,profileIds:[row.id],customerName:'Owner'});assert.ok(h.writes.at(-1)[1].includes(data.profileSecurityCode),'independent security code fills retailer verification slot');
 }
 const bytes=await fs.readFile(h.profiles.paths.personal);assert.ok(bytes.toString().startsWith('ENCRYPTED:'));
 assert.equal((await h.lib.list(event,h.b)).profiles.length,0);h.lockLibrary();await assert.rejects(h.lib.list(event,h.p),/Locked/);
});
test('Local CVV can be edited or cleared without changing another profile or storing it in audit output',async t=>{
 const h=await library(t),data=complete('target','own@example.test');data.cc_cvv='123';await commit(h,await preview(h,[data]));let row=(await h.lib.list(event,h.p)).profiles[0];assert.equal(row.data.cc_cvv,'123');
 const response=await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),cardCvv:'9876'});assert.equal(response.updated,true);assert.ok(!JSON.stringify(response).includes('9876'));
 row=(await h.lib.list(event,h.p)).profiles[0];assert.equal(row.data.cc_cvv,'9876');assert.ok(!JSON.stringify(await h.profiles.audit('personal',null)).includes('9876'));
 await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),cardCvv:''});assert.equal((await h.lib.list(event,h.p)).profiles[0].data.cc_cvv,'');
});
test('Normalized imports retain CVV/CVC aliases without sending values to another owner',async t=>{
 const h=await library(t),data=complete('walmart','cvc@example.test');data.card.cvc='345';await commit(h,await preview(h,[data],h.p,'walmart'));
 const row=(await h.lib.list(event,h.p)).profiles[0];assert.equal(row.data.card.cvv,'345');assert.equal((await h.lib.list(event,h.a)).profiles.length,0);assert.equal((await h.lib.list(event,h.b)).profiles.length,0);
});

test('Customer storage does not change and the customer editor rejects Personal card-code operations',async t=>{
 const h=await library(t),data=complete('target','customer@example.test');data.cc_cvv='123';await commit(h,await preview(h,[data],h.a));const row=(await h.lib.list(event,h.a)).profiles[0];assert.equal(row.data.cc_cvv,'');
 await assert.rejects(h.lib.edit(event,{...h.a,profileId:row.id,revision:row.revision,fields:LC.values(row.data),cardCvv:'123'}),/Personal vault/);
});
