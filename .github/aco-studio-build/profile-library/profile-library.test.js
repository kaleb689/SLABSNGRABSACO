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
async function library(t){const h=await env(t);let allowed=true;const lib=createLibrary({profiles:h.profiles,addressBanks:h.addresses,cardVault:s=>s==='personal'?h.personal:h.customers,authorize:async(e,s,id)=>{if(e.sender.id!==1)throw Error('Not owner');if(s==='aco'&&!['customer-a','customer-b'].includes(id))throw Error('Unauthorized customer');return s==='personal'?null:id;},guard:(e,s)=>{if(e.sender.id!==1||!allowed)throw Error('Locked');},chooseSave:async(_e,o)=>({filePath:path.join(h.dir,o.name)}),confirmExport:async()=>true,writeFile:async(...args)=>h.writes.push(args),getCustomerProfileSource:async id=>({customer:{id,name:id},linked:[{customerId:id,assignmentId:'linked-1',retailer:'pokemoncenter',active:true,data:complete('pokemoncenter','linked@example.test')}]})});return {...h,lib,lockLibrary:()=>allowed=false};}
function complete(retailer,email){const data=D.blank(retailer,LC.format(retailer),{email,first:'Alex',last:'Example',phone:'9545550100','shipping.address1':'100 Example Avenue','shipping.city':'Sample','shipping.state':'FL','shipping.zip':'33324','billing.address1':'100 Example Avenue','billing.city':'Sample','billing.state':'FL','billing.zip':'33324'});LC.putCard(data,fullCard);return data;}
async function preview(h,data,owner=h.p,retailer='target'){return h.lib.importPreview(event,{...owner,retailer,fileName:'profiles.json',text:JSON.stringify(data)});}
async function commit(h,preview,extra={}){return h.lib.importCommit(event,{token:preview.token,confirmed:true,alreadyJigged:true,repairs:{allowShared:true},...extra});}
test('Library imports normalize complete Shikari and Valor profiles; email/name/card collisions reported',async t=>{const h=await library(t);await commit(h,await preview(h,[complete('target','one@example.test')]));const p=await preview(h,[complete('target','one@example.test')]);assert.deepEqual(p.profiles[0].duplicates.sort(),['card','email','name']);const result=await h.lib.list(event,h.p);assert.equal(result.profiles[0].stage,'completed');assert.equal((await h.lib.list(event,h.a)).profiles.length,0);});
test('Duplicate import repair consumes only selected retailer email bank and own unused card',async t=>{const h=await library(t);await commit(h,await preview(h,[complete('target','one@example.test')]));await h.service.importEmails(event,{...h.p,retailer:'target',emails:['replacement@example.test']});const c=await h.service.addCard(event,{...h.p,card:{...card,number:'5555555555554444'}});const p=await preview(h,[complete('target','one@example.test')]);await commit(h,p,{repairs:{email:true,name:true,card:true},cardIds:[c.id]});const rows=(await h.lib.list(event,h.p)).profiles;assert.equal(rows.length,2);assert.equal(rows[1].email,'replacement@example.test');assert.equal(rows[1].data.cc_number,'5555555555554444');assert.notEqual(LC.nameKey(rows[0].data),LC.nameKey(rows[1].data));assert.equal((await h.service.emails(event,{...h.p,retailer:'target'})).emails[0].status,'used');});
test('Foreign card IDs and wrong-owner imported rows fail without partial profiles',async t=>{const h=await library(t),c=await h.service.addCard(event,{...h.a,card});const p=await preview(h,[complete('target','one@example.test')]);await assert.rejects(commit(h,p,{cardIds:[c.id]}),/not in this/);assert.equal((await h.lib.list(event,h.p)).profiles.length,0);const row=complete('target','bad@example.test');row.customerId='customer-b';await assert.rejects(preview(h,[row],h.a),/ownership/);});
test('Completed export uses retailer format and full owned payment/address fields',async t=>{const h=await library(t);for(const retailer of ['target','walmart','pokemoncenter']){await commit(h,await preview(h,[complete(retailer,retailer+'@example.test')],h.p,retailer));const row=(await h.lib.list(event,h.p)).profiles.find(x=>x.retailer===retailer);const r=await h.lib.exportFile(event,{...h.p,retailer,profileIds:[row.id],customerName:'Owner'});assert.ok(r.name.endsWith(retailer==='target'?'.csv':'.json'));assert.ok(h.writes.at(-1)[1].includes(card.number));assert.ok(h.writes.at(-1)[1].includes('9545550100'));}await assert.rejects(h.lib.exportFile(event,{...h.a,retailer:'target',profileIds:[(await h.lib.list(event,h.p)).profiles[0].id]}),/belong/);});
test('Owner can export incomplete profiles; revisions and cancellation still stop stale writes',async t=>{const h=await library(t),data=complete('target','draft@example.test');data.phone_num='';data.shipping_phone='';data.billing_phone='';await commit(h,await preview(h,[data]));const row=(await h.lib.list(event,h.p)).profiles[0];const exported=await h.lib.exportFile(event,{...h.p,retailer:'target',profileIds:[row.id]});assert.equal(exported.saved,true);const p=await preview(h,[complete('target','later@example.test')]);h.lib.cancel(event);await assert.rejects(commit(h,p),/expired/);h.lockLibrary();await assert.rejects(h.lib.list(event,h.p),/Locked/);});
test('Linked website customer profile creation is idempotent and isolated',async t=>{const h=await library(t);let r=await h.lib.syncCustomer(event,{...h.a});assert.equal(r.created,1);r=await h.lib.syncCustomer(event,h.a);assert.equal(r.created,0);assert.equal(r.updated,0);const row=(await h.lib.list(event,h.a)).profiles[0];assert.equal(row.stage,'completed');assert.equal(row.data.card.number,card.number);assert.equal((await h.lib.list(event,h.b)).profiles.length,0);assert.equal((await h.lib.list(event,h.p)).profiles.length,0);await assert.rejects(h.lib.syncCustomer(event,h.p),/customer vault/);});
test('Canonical source maps existing Shikari phone/names without inventing missing card data',()=>{const raw={email:'legacy@example.test',first_name:'Alex',last_name:'Example',phone_num:'9545550100',shipping_street:'100 Example Ave',shipping_city:'Sample',shipping_state:'FL',shipping_zip_code:'33324',billing_first_name:'Alex',billing_last_name:'Example',billing_street:'100 Example Ave',billing_city:'Sample',billing_state:'FL',billing_zip_code:'33324',cc_number:card.number,cc_exp_month:'08',cc_exp_year:'2031'};const normalized=LC.normalized(raw,'pokemoncenter');assert.equal(normalized.shipping.phoneNumber,raw.phone_num);assert.equal(normalized.card.holder,'Alex Example');assert.equal(normalized.card.number,card.number);});
test('Raw customer source rejects another customer identity',()=>{const {sourceForCustomer}=require('../customer-profile-source');assert.throws(()=>sourceForCustomer({id:'customer-a',name:'A'},{},{memberships:[{active:true,customerAccountId:'customer-b'}]}),/another customer/);});
test('Customer source uses submitted cards/address/phone and leaves absent cards incomplete',()=>{const {sourceForCustomer}=require('../customer-profile-source'),customer={id:'customer-a',name:'Annette',shipping:{firstName:'Annette',lastName:'Example',phone:'9545550100'}},saved={addresses:[{address:'100 Example Avenue',city:'Sample',state:'FL',zip:'33324',firstName:'Annette',lastName:'Example',phone:'9545550100'}],paymentMethods:[{acoCardNumber:card.number,cardholder:'Annette Example',expMonth:'08',expYear:'2031'}]},memberships={memberships:[{id:'pool-1',assignmentId:'assigned-1',active:true,customerAccountId:'customer-a',retailers:{pkc:{username:'annette@example.test'}},customerProfile:{}}]};const source=sourceForCustomer(customer,saved,memberships);assert.equal(source.linked[0].data.card.number,card.number);assert.equal(source.linked[0].data.shipping.phoneNumber,'9545550100');assert.equal(source.linked[0].data.shipping.addressLine1,'100 Example Avenue');const absent=sourceForCustomer(customer,{addresses:saved.addresses},memberships);assert.equal(absent.linked[0].data.card.number,'');});
test('Retailer jig settings are saved per owner and retailer',async t=>{const h=await library(t);await h.lib.saveRules(event,{...h.p,retailer:'pokemoncenter',rules:['avenue_short']});assert.deepEqual((await h.lib.rules(event,{...h.p,retailer:'pokemoncenter'})).selected,['suffix.matching']);assert.notDeepEqual((await h.lib.rules(event,{...h.a,retailer:'pokemoncenter'})).selected,['suffix.matching']);await assert.rejects(h.lib.saveRules(event,{...h.p,retailer:'target',rules:['prefix_three_1']}),/supported/);});
test('Concurrent import confirmation saves one batch only',async t=>{const h=await library(t),p=await preview(h,[complete('target','once@example.test')]),results=await Promise.allSettled([commit(h,p),commit(h,p)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await h.lib.list(event,h.p)).profiles.length,1);});
test('Explicit repair keeps profile ownership and updates only selected fields',async t=>{const h=await library(t);await commit(h,await preview(h,[complete('target','before@example.test')]));await h.service.importEmails(event,{...h.p,retailer:'target',emails:['after@example.test']});const row=(await h.lib.list(event,h.p)).profiles[0],prior=structuredClone(row.data);await h.lib.repair(event,{...h.p,profileId:row.id,revision:row.revision,repairs:{email:true},cardIds:[]});const updated=(await h.lib.list(event,h.p)).profiles[0];assert.equal(updated.email,'after@example.test');prior.email='after@example.test';assert.deepEqual(updated.data,prior);assert.equal((await h.lib.list(event,h.a)).profiles.length,0);});

test('Florida phone jig generates distinct reserved-format Florida numbers across a selected batch',async t=>{
 const h=await library(t);
 for(let i=0;i<3;i++)await commit(h,await preview(h,[complete('target','phone'+i+'@example.test')]));
 const rows=(await h.lib.list(event,h.p)).profiles.filter(x=>x.retailer==='target');
 const previewed=await h.lib.batchJigPreview(event,{...h.p,retailer:'target',profileIds:rows.map(x=>x.id),ruleIds:[LC.FL_PHONE_RULE],combine:false,billingSameAsShipping:false});
 assert.equal(previewed.count,3);
 const phones=previewed.profiles.map(x=>x.after.phone);
 assert.equal(new Set(phones).size,3);
 for(const phone of phones){
  assert.match(phone,/^\d{3}55501\d{2}$/);
  assert.ok(LC.FL_AREA_CODES.includes(phone.slice(0,3)));
 }
});

test('Florida phone jig is available as a persistent retailer rule',async t=>{
 const h=await library(t);
 const settings=await h.lib.rules(event,{...h.p,retailer:'pokemoncenter'});
 assert.ok(settings.options.some(x=>x.id===LC.FL_PHONE_RULE&&/Florida phone/i.test(x.label)));
 await h.lib.saveRules(event,{...h.p,retailer:'pokemoncenter',rules:[LC.FL_PHONE_RULE]});
 assert.deepEqual((await h.lib.rules(event,{...h.p,retailer:'pokemoncenter'})).selected,[LC.FL_PHONE_RULE]);
});


test('Target preset keeps fractional 1/2 through 1/4 and A-H hyphen house-number jigs',async t=>{
 const h=await library(t);
 const settings=await h.lib.rules(event,{...h.p,retailer:'target'});
 for(const id of ['target.house.fraction.half','target.house.fraction.third','target.house.fraction.quarter',...'abcdefgh'.split('').map(x=>'target.house.hyphen.'+x)])assert.ok(settings.options.some(x=>x.id===id),id);
 for(const id of ['target.house.fraction.half','target.house.fraction.third','target.house.fraction.quarter',...'abcdefgh'.split('').map(x=>'target.house.hyphen.'+x)])assert.ok(settings.selected.includes(id),id+' default');
});

test('Bulk Target jig leaves one original per main address and then distributes soft and hard variants',async t=>{
 const h=await library(t);
 for(let i=0;i<4;i++)await commit(h,await preview(h,[complete('target','mix'+i+'@example.test')]));
 const rows=(await h.lib.list(event,h.p)).profiles.filter(x=>x.retailer==='target');
 const plan=await h.lib.batchJigPreview(event,{...h.p,retailer:'target',profileIds:rows.map(x=>x.id),
  ruleIds:['avenue_short','target.house.fraction.half','target.house.fraction.third','target.house.hyphen.a'],combine:false,billingSameAsShipping:false});
 const streets=plan.profiles.map(x=>x.after.address1);
 assert.equal(streets[0],'100 Example Avenue');
 assert.equal(streets[1],'100 Example Ave');
 assert.match(streets[2],/^100 1\/2 Example Ave$/i);
 assert.match(streets[3],/^100 1\/3 Example Ave$/i);
 assert.equal(new Set(streets).size,4);
});

test('Multiple hard Target primary jigs stack only when Combine is explicitly enabled',async t=>{
 const h=await library(t);
 for(let i=0;i<2;i++)await commit(h,await preview(h,[complete('target','combine'+i+'@example.test')]));
 const rows=(await h.lib.list(event,h.p)).profiles.filter(x=>x.retailer==='target');
 const normal=await h.lib.batchJigPreview(event,{...h.p,retailer:'target',profileIds:rows.map(x=>x.id),
  ruleIds:['target.house.fraction.half','target.house.hyphen.a'],combine:false,billingSameAsShipping:false});
 assert.equal(normal.profiles[0].after.address1,'100 Example Avenue');
 assert.match(normal.profiles[1].after.address1,/^100 1\/2 Example Avenue$/i);
 assert.doesNotMatch(normal.profiles[1].after.address1,/-A/i);
 const mixed=await h.lib.batchJigPreview(event,{...h.p,retailer:'target',profileIds:rows.map(x=>x.id),
  ruleIds:['target.house.fraction.half','target.house.hyphen.a'],combine:true,billingSameAsShipping:false});
 assert.equal(mixed.profiles[0].after.address1,'100 Example Avenue');
 assert.match(mixed.profiles[1].after.address1,/^100-A 1\/2 Example Avenue$/i);
});

test('Target primary-number jigs never stack when combine is enabled',()=>{
 const row=complete('target','target-primary@example.test');
 row.shipping_street='123 MAIN STREET';row.billing_street='123 MAIN STREET';
 const out=LC.jig(row,'target',1,['target.house.fraction.half','target.house.hyphen.a']);
 assert.equal(out.shipping_street,'123 1/2 MAIN STREET');
 assert.equal(out.billing_street,'123 1/2 MAIN STREET');
 assert.doesNotMatch(out.shipping_street,/-A/);
});

test('Jig commit changes cardholder to the profile first and last name for Target and PKC',async t=>{
 const h=await library(t);
 for(const retailer of ['target','pokemoncenter']){
  await commit(h,await preview(h,[complete(retailer,retailer+'-holder@example.test')],h.p,retailer));
  let row=(await h.lib.list(event,h.p)).profiles.find(x=>x.retailer===retailer);
  assert.equal(LC.payment(row.data).cardholder,'Alex Example');
  const plan=await h.lib.batchJigPreview(event,{...h.p,retailer,profileIds:[row.id],ruleIds:['avenue_short'],combine:false,billingSameAsShipping:false});
  await h.lib.batchJigCommit(event,{token:plan.token,confirmed:true});
  row=(await h.lib.list(event,h.p)).profiles.find(x=>x.id===row.id);
  assert.equal(LC.payment(row.data).cardholder,'Alex Example');
  if(retailer==='target')assert.equal(row.data.cc_name,'Alex Example');
  else assert.equal(row.data.card.holder,'Alex Example');
 }
});

test('Cardholder sync helper preserves blank cards but fixes an attached card holder',()=>{
 const blank=D.blank('target','shikari',{first:'Jordan',last:'Smith',email:'blank@example.test'});
 assert.equal(LC.syncCardholderToProfile(blank).cc_name,'');
 const filled=complete('target','filled@example.test');
 assert.equal(LC.payment(filled).cardholder,'Alex Example');
 assert.equal(LC.payment(LC.syncCardholderToProfile(filled)).cardholder,'Alex Example');
});


test('Counted Target hard jig keeps one base and creates 17 unique variants for 18 profiles',async t=>{
 const h=await library(t);
 for(let i=0;i<18;i++)await commit(h,await preview(h,[complete('target','hard-'+i+'@example.test')]));
 const rows=(await h.lib.list(event,h.p)).profiles.filter(x=>x.retailer==='target');
 const result=await h.lib.batchJigPreview(event,{...h.p,retailer:'target',profileIds:rows.map(x=>x.id),ruleIds:[],hardCounts:{fraction:3,hyphen:8,doubleLetter:6,randomUnit:0},combine:false,billingSameAsShipping:true});
 assert.equal(result.count,18);
 assert.equal(result.profiles[0].category,'original');
 assert.equal(result.profiles[0].after.address1,'100 Example Avenue');
 assert.equal(result.profiles.filter(x=>x.category==='fraction').length,3);
 assert.equal(result.profiles.filter(x=>x.category==='hyphen').length,8);
 assert.equal(result.profiles.filter(x=>x.category==='doubleLetter').length,6);
 assert.equal(new Set(result.profiles.map(x=>x.after.address1+'|'+x.after.address2)).size,18);
});
test('Random unit Jig rejects a base address that already contains an apartment',async t=>{
 const h=await library(t);
 const data=complete('target','apt-block@example.test');data.shipping_street_2='Apt 2';
 await commit(h,await preview(h,[data]));
 const row=(await h.lib.list(event,h.p)).profiles[0];
 await assert.rejects(h.lib.batchJigPreview(event,{...h.p,retailer:'target',profileIds:[row.id],ruleIds:[],hardCounts:{fraction:0,hyphen:0,doubleLetter:0,randomUnit:1},combine:false,billingSameAsShipping:false}),/Not enough unique eligible jig variations/);
});



test('Owner Jig lists saved Main addresses and existing Jigged profile addresses for exact reuse',async t=>{
 const h=await library(t);
 await h.service.addAddress(event,{...h.p,address:{...address,label:'Saved Main'}});
 await commit(h,await preview(h,[complete('target','reuse-a@example.test')]));
 await commit(h,await preview(h,[complete('target','reuse-b@example.test')]));
 await commit(h,await preview(h,[complete('target','reuse-c@example.test')]));
 const profiles=(await h.lib.list(event,h.p)).profiles.filter(p=>p.retailer==='target');
 const jig=await h.lib.batchJigPreview(event,{...h.p,retailer:'target',profileIds:[profiles[0].id],ruleIds:['suffix.matching'],combine:false,billingSameAsShipping:false});
 await h.lib.batchJigCommit(event,{token:jig.token,confirmed:true});
 const choices=(await h.lib.reuseChoices(event,h.p)).choices;
 assert.ok(choices.some(x=>x.type==='main'&&x.summary.includes('100 Example Avenue')&&x.summary.includes('Apt 2')),JSON.stringify(choices));
 const variant=choices.find(x=>x.summary.includes('100 Example Ave')&&!x.summary.includes('Avenue'));
 assert.ok(variant,JSON.stringify(choices));
 assert.equal(variant.type,'jigged');
 assert.equal((await h.lib.reuseChoices(event,h.a)).choices.some(x=>x.id===variant.id),false);
 await assert.rejects(h.lib.reuseChoices(foreign,h.p),/Not owner/);
});
test('Exact Main/Jigged reuse count changes the chosen profiles only and can be reviewed before commit',async t=>{
 const h=await library(t);
 const main=await h.service.addAddress(event,{...h.p,address:{...address,label:'Private Main'}});
 for(let i=0;i<4;i++)await commit(h,await preview(h,[complete('target','repeat-'+i+'@example.test')]));
 const profiles=(await h.lib.list(event,h.p)).profiles.filter(x=>x.retailer==='target');
 const choices=(await h.lib.reuseChoices(event,h.p)).choices;
 const choice=choices.find(x=>x.type==='main'&&x.summary.includes('Apt 2'));
 assert.ok(choice);
 const args={...h.p,retailer:'target',profileIds:profiles.map(x=>x.id),ruleIds:['suffix.matching'],reuse:{sourceId:choice.id,count:2},combine:false,billingSameAsShipping:false};
 const result=await h.lib.batchJigPreview(event,args);
 assert.equal(result.reused,2);
 assert.equal(result.profiles.length,4);
 for(const record of result.profiles.slice(0,2)){
  assert.equal(record.after.address1,'100 Example Avenue');
  assert.equal(record.after.address2,'Apt 2');
  assert.equal(record.category,'reused saved address');
 }
 assert.equal(result.profiles[2].after.address2,'');
 const before=(await h.lib.list(event,h.p)).profiles;
 assert.ok(before.every(x=>!String(LC.values(x.data)['shipping.address2']||'').includes('Apt 2')));
 await h.lib.batchJigCommit(event,{token:result.token,confirmed:true});
 const after=(await h.lib.list(event,h.p)).profiles;
 assert.equal(after.filter(x=>String(LC.values(x.data)['shipping.address2']).toUpperCase()==='APT 2').length,2);
 const noReuse={...args,reuse:{sourceId:choice.id,count:1}};
 await assert.rejects(h.lib.batchJigPreview(event,noReuse),/Choose between 2/);
 await assert.rejects(h.lib.batchJigPreview(event,{...args,reuse:{sourceId:'profile:unknown',count:2}}),/available/);
});

test('Owner import history removes only exact batch profiles and preserves later imports, cards and customers',async t=>{
 const h=await library(t);
 const first=await commit(h,await preview(h,[complete('target','first-batch@example.test')]));
 const second=await commit(h,await preview(h,[complete('target','second-batch@example.test')]));
 const customer=await commit(h,await preview(h,[complete('target','customer-a@example.test')],h.a));
 const history=(await h.lib.importHistory(event,h.p)).batches;
 assert.equal(history.length,2);
 assert.equal(history[0].id,second.batchId);
 assert.equal(history[1].id,first.batchId);
 await assert.rejects(h.lib.removeImportBatch(event,{...h.a,batchId:first.batchId,fingerprint:history[1].fingerprint,confirmed:true}),/history|changed/i);
 const removed=await h.lib.removeImportBatch(event,{...h.p,batchId:first.batchId,fingerprint:history[1].fingerprint,confirmed:true});
 assert.equal(removed.deleted,1);
 assert.deepEqual((await h.lib.list(event,h.p)).profiles.map(x=>x.email),['second-batch@example.test']);
 assert.equal((await h.lib.list(event,h.a)).profiles.length,1);
 assert.equal(customer.imported,1);
 assert.equal((await h.lib.importHistory(event,h.p)).batches.find(x=>x.id===first.batchId).removedAt!==null,true);
});
test('Owner bulk move/delete validates exact retailer and revision atomically',async t=>{
 const h=await library(t);
 await commit(h,await preview(h,[complete('target','bulk-one@example.test')]));
 await commit(h,await preview(h,[complete('target','bulk-two@example.test')]));
 await commit(h,await preview(h,[complete('pokemoncenter','unrelated@example.test')],h.p,'pokemoncenter'));
 const originals=(await h.lib.list(event,h.p)).profiles;
 const selected=originals.filter(x=>x.retailer==='target');
 const args={...h.p,retailer:'target',fromBank:'working',profileIds:selected.map(x=>x.id),revisions:selected.map(x=>x.revision),confirmed:true};
 await assert.rejects(h.lib.bulkManage(event,{...args,revisions:[999,...args.revisions.slice(1)],operation:'delete'}),/changed/);
 assert.equal((await h.lib.list(event,h.p)).profiles.length,3);
 const moved=await h.lib.bulkManage(event,{...args,operation:'move',toBank:'live'});
 assert.equal(moved.count,2);
 assert.deepEqual((await h.lib.list(event,h.p)).profiles.filter(x=>x.retailer==='target').map(x=>x.bank),['live','live']);
 await assert.rejects(h.lib.bulkManage(event,{...args,operation:'delete'}),/changed/);
 const next=(await h.lib.list(event,h.p)).profiles.filter(x=>x.retailer==='target');
 assert.equal((await h.lib.bulkManage(event,{...args,fromBank:'live',revisions:next.map(x=>x.revision),operation:'delete'})).count,2);
 assert.deepEqual((await h.lib.list(event,h.p)).profiles.map(x=>x.retailer),['pokemoncenter']);
});
test('Owner batch operations refuse connected website profile deletion and preserve snapshot on invalid calls',async t=>{
 const h=await library(t);
 await h.lib.syncCustomer(event,h.a);
 const row=(await h.lib.list(event,h.a)).profiles[0];
 await assert.rejects(h.lib.bulkManage(event,{...h.a,operation:'delete',retailer:'pokemoncenter',fromBank:'working',profileIds:[row.id],revisions:[row.revision],confirmed:true}),/Linked website/);
 assert.equal((await h.lib.list(event,h.a)).profiles.length,1);
});

test('Separate profile code is editable, preserved and included in owner JSON export without card verifier',async t=>{
 const h=await library(t),source=complete('target','separate-code@example.test');
 source.profileSecurityCode='WAREHOUSE-ACCESS-73';
 source.cc_cvv='123';
 await commit(h,await preview(h,[source]));
 let row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'WAREHOUSE-ACCESS-73');
 const updated=await h.lib.edit(event,{...h.p,profileId:row.id,revision:row.revision,fields:LC.values(row.data),profileSecurityCode:'PICKUP-CODE-44'});
 assert.equal(updated.updated,true);
 row=(await h.lib.list(event,h.p)).profiles[0];
 assert.equal(row.data.profileSecurityCode,'PICKUP-CODE-44');
 await h.lib.exportArchive(event,{...h.p,retailer:'target',profileIds:[row.id],customerName:'Owner'});
 const archive=JSON.parse(h.writes.at(-1)[1]);
 assert.equal(archive.profiles[0].profileSecurityCode,'PICKUP-CODE-44');
 assert.equal(archive.profiles[0].data.cc_number,card.number);
 assert.equal(archive.profiles[0].data.cc_cvv,undefined);
 assert.equal(archive.profiles[0].data.profileSecurityCode,'PICKUP-CODE-44');
 await assert.rejects(h.lib.exportArchive(event,{...h.a,retailer:'target',profileIds:[row.id]}),/belong/);
});
