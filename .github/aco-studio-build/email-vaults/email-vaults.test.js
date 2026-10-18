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

test('Email imports normalize, skip batch/retailer collisions and retain cross-retailer reuse',async t=>{const h=await env(t);
 let r=await h.service.importEmails(event,{...h.p,retailer:'target',emails:[' OWN@example.test ','own@example.test','bad']});assert.equal(r.added,1);assert.equal(r.skipped,1);assert.equal(r.invalid,1);
 r=await h.service.importEmails(event,{...h.a,retailer:'target',emails:['own@example.test','annette@example.test']});assert.equal(r.added,1);assert.equal(r.skipped,1);
 r=await h.service.importEmails(event,{...h.p,retailer:'walmart',emails:['own@example.test']});assert.equal(r.added,1);
 assert.deepEqual((await h.service.emails(event,{...h.a,retailer:'target'})).emails.map(x=>x.email),['annette@example.test']);
 assert.equal((await h.service.emails(event,{...h.b,retailer:'target'})).emails.length,0);
});
async function stock(h,scope,email){await h.service.importEmails(event,{...scope,retailer:'target',emails:[email]});const a=await h.service.addAddress(event,{...scope,address});const c=await h.service.addCard(event,{...scope,card});return {...scope,retailer:'target',count:1,format:'shikari',randomNames:true,addressIds:[a.id],cardIds:[c.id]};}
test('Generation consumes email and saves own cards/address/name in a single scoped commit',async t=>{const h=await env(t),p=await stock(h,h.a,'annette@example.test');
 await h.service.importEmails(event,{...h.b,retailer:'target',emails:['mike@example.test']});await h.service.importEmails(event,{...h.p,retailer:'target',emails:['owner@example.test']});
 const privateBefore=await fs.readFile(h.profiles.paths.personal);const r=await h.service.generate(event,p);assert.equal(r.created,1);
 const [row]=await h.profiles.fieldSnapshot('aco','customer-a');assert.equal(row.email,'annette@example.test');assert.equal(row.data.cc_number,card.number);assert.equal(row.data.shipping_street,address.address1);assert.equal(row.data.billing_street,address.address1);assert.equal(row.data.shipping_first_name,row.data.billing_first_name);assert.ok(row.data.shipping_first_name);assert.ok(!JSON.stringify(r).includes(card.number));
 assert.deepEqual(await fs.readFile(h.profiles.paths.personal),privateBefore);assert.equal((await h.profiles.fieldSnapshot('aco','customer-b')).length,0);
 assert.equal((await h.service.emails(event,{...h.a,retailer:'target'})).emails[0].status,'used');await assert.rejects(h.service.generate(event,p),/Not enough unused/);
});
test('Foreign cards/addresses, insufficient resources and locked vault abort without consuming emails',async t=>{const h=await env(t),p=await stock(h,h.p,'own@example.test');await h.service.importEmails(event,{...h.a,retailer:'target',emails:['other@example.test']});
 const before=await fs.readFile(h.profiles.paths.aco);await assert.rejects(h.service.generate(event,{...p,...h.a}),/not in this/);assert.deepEqual(await fs.readFile(h.profiles.paths.aco),before);
 await assert.rejects(h.service.generate(event,{...p,count:2}),/Not enough unused/);h.lock();for(const fn of [()=>h.service.generate(event,p),()=>h.service.emails(event,p),()=>h.service.importEmails(event,{...p,emails:['x@example.test']})])await assert.rejects(fn,/locked/);
});
test('Concurrent generations use each email/card once',async t=>{const h=await env(t),p=await stock(h,h.p,'own@example.test');const r=await Promise.allSettled([h.service.generate(event,p),h.service.generate(event,p)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await h.profiles.fieldSnapshot('personal',null)).length,1);});
test('Existing profiles block imports and competing legacy imports prevent generation reuse',async t=>{const h=await env(t);await h.profiles.importRows({scope:'aco',customerId:'customer-a',retailer:'target',rows:[{email:'existing@example.test'}]});assert.equal((await h.service.importEmails(event,{...h.p,retailer:'target',emails:['existing@example.test']})).skipped,1);
 const p=await stock(h,h.p,'reserved@example.test');await h.profiles.importRows({scope:'aco',customerId:'customer-b',retailer:'target',rows:[{email:'reserved@example.test'}]});await assert.rejects(h.service.generate(event,p),/Not enough unused/);
});
test('Missing customer and non-owner frame cannot read/import/generate',async t=>{const h=await env(t);for(const method of ['emails','importEmails','generate']){await assert.rejects(h.service[method](foreign,{...h.p,retailer:'target',emails:['a@example.test']}));await assert.rejects(h.service[method](event,{scope:'aco',customerId:null,retailer:'target',emails:['a@example.test']}));}});
