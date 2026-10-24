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


async function poolStock(h,owner,retailer='target',n=3){
 const a=await h.service.addAddress(event,{...owner,address});const ids=[];
 for(let i=0;i<n;i++){const c=await h.service.addCard(event,{...owner,card:{...card,number:'424242424242'+String(4242+i)}});ids.push(c.id);}
 return {...owner,retailer,format:retailer==='target'?'shikari':'valor',count:n,addressIds:[a.id],cardIds:ids,randomNames:true};
}
test('Build bulk profiles from existing free accounts without importing emails and preserve credentials',async t=>{
 const h=await env(t),p=await poolStock(h,h.p);
 await h.profiles.importRows({...h.p,retailer:'target',status:'available',rows:Array.from({length:3},(_,i)=>D.blank('target','shikari',{email:'free'+i+'@example.test',password:'saved-password-'+i,phone:'9545550100'}))});
 const before=await h.profiles.fieldSnapshot('personal',null),inventory=await h.service.emails(event,p);assert.equal(inventory.freeAccounts,3);assert.equal(inventory.availableForCreation,3);
 const r=await h.service.generate(event,p);assert.equal(r.created,3);const rows=await h.profiles.fieldSnapshot('personal',null);assert.equal(rows.length,3);
 for(let i=0;i<3;i++){assert.equal(rows[i].id,before[i].id);assert.equal(D.toValues(rows[i].data).password,'saved-password-'+i);assert.equal(rows[i].data.cc_name,[rows[i].data.shipping_first_name,rows[i].data.shipping_last_name].join(' '));assert.equal(rows[i].data.shipping_street,address.address1);}
 assert.equal(new Set(rows.map(x=>x.assetRefs.cardId)).size,3);assert.equal((await h.service.emails(event,p)).availableForCreation,0);assert.equal((await h.service.assets(event,p)).cards.filter(x=>x.unused).length,0);
 await assert.rejects(h.service.generate(event,p));assert.equal((await h.profiles.fieldSnapshot('aco','customer-a')).length,0);
});
test('Mixed free accounts and email bank create exactly requested amount and retain unused resources',async t=>{
 const h=await env(t),p=await poolStock(h,h.a,'walmart');await h.profiles.importRows({...h.a,retailer:'walmart',status:'available',rows:[D.blank('walmart','valor',{email:'free@example.test',password:'keep-me'})]});
 await h.service.importEmails(event,{...h.a,retailer:'walmart',emails:['email1@example.test','email2@example.test']});assert.equal((await h.service.emails(event,p)).availableForCreation,3);
 await h.service.generate(event,{...p,count:2});const rows=await h.profiles.fieldSnapshot('aco','customer-a');assert.equal(rows.length,2);assert.equal(D.toValues(rows[0].data).password,'keep-me');assert.equal((await h.service.emails(event,p)).availableForCreation,1);assert.equal((await h.service.assets(event,p)).cards.filter(x=>x.unused).length,1);
 assert.equal((await h.service.emails(event,{...h.b,retailer:'walmart'})).availableForCreation,0);assert.equal((await h.service.emails(event,{...h.a,retailer:'target'})).availableForCreation,0);
});
test('Insufficient cards or invalid count consume no available accounts; concurrent requests consume once',async t=>{
 const h=await env(t),p=await poolStock(h,h.p,'target',1);await h.profiles.importRows({...h.p,retailer:'target',status:'available',rows:[{email:'a@example.test'},{email:'b@example.test'}]});
 for(const count of [2,0,1.5,501])await assert.rejects(h.service.generate(event,{...p,count}));assert.equal((await h.service.emails(event,p)).availableForCreation,2);
 const r=await Promise.allSettled([h.service.generate(event,p),h.service.generate(event,p)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await h.service.emails(event,p)).availableForCreation,1);
});

test('Jig selected unused accounts consumes exact requested IDs, not the first available account',async t=>{
 const h=await env(t),p=await poolStock(h,h.p,'target',2);
 await h.service.importEmails(event,{...h.p,retailer:'target',emails:['first@example.test','selected@example.test']});
 const before=await h.service.emails(event,p),selected=before.emails.find(x=>x.email==='selected@example.test');
 assert.ok(selected?.id);
 const result=await h.service.generate(event,{...p,count:1,cardIds:p.cardIds.slice(0,1),emailIds:[selected.id]});
 assert.equal(result.created,1);
 const rows=await h.profiles.fieldSnapshot('personal',null);
 assert.deepEqual(rows.filter(x=>x.retailer==='target').map(x=>x.email),['selected@example.test']);
 const after=await h.service.emails(event,p);
 assert.deepEqual(after.emails.filter(x=>x.status==='available').map(x=>x.email),['first@example.test']);
 await assert.rejects(h.service.generate(event,{...p,count:1,cardIds:[p.cardIds[1]],emailIds:[selected.id]}),/no longer unused/);
 assert.equal((await h.profiles.fieldSnapshot('personal',null)).length,1);
});

test('Unused account selection cannot borrow an ID from another customer or another retailer',async t=>{
 const h=await env(t),a=await poolStock(h,h.a,'target',1),b=await poolStock(h,h.b,'target',1);
 await h.service.importEmails(event,{...h.a,retailer:'target',emails:['mike@example.test']});
 await h.service.importEmails(event,{...h.b,retailer:'target',emails:['derick@example.test']});
 const mike=(await h.service.emails(event,a)).emails.find(x=>x.status==='available');
 await assert.rejects(h.service.generate(event,{...b,emailIds:[mike.id]}),/no longer unused/);
 await assert.rejects(h.service.generate(event,{...a,retailer:'pokemoncenter',format:'valor',emailIds:[mike.id]}),/no longer unused|Not enough unused/);
 assert.equal((await h.profiles.fieldSnapshot('aco','customer-a')).length,0);
 assert.equal((await h.profiles.fieldSnapshot('aco','customer-b')).length,0);
});

test('Importing an active Target profile consumes only Target Unused and leaves PKC Unused independently eligible',async t=>{
 const h=await env(t),owner=h.p;
 await h.service.importEmails(event,{...owner,retailer:'target',emails:['shared@example.test']});
 await h.service.importEmails(event,{...owner,retailer:'pokemoncenter',emails:['shared@example.test']});
 await h.profiles.importRows({...owner,retailer:'target',status:'active',rows:[{email:'shared@example.test'}]});
 const target=await h.service.emails(event,{...owner,retailer:'target'});
 const pkc=await h.service.emails(event,{...owner,retailer:'pokemoncenter'});
 assert.equal(target.availableForCreation,0);
 assert.equal(pkc.availableForCreation,1);
 assert.deepEqual(pkc.emails.filter(x=>x.status==='available').map(x=>x.email),['shared@example.test']);
});

test('Atomic Hard Card batch updates only selected cards in the authorized owner vault',async t=>{
 const h=await env(t),p=h.p;
 const first=await h.service.addCard(event,{...p,card});
 const second=await h.service.addCard(event,{...p,card:{...card,number:'5555555555554444'}});
 const refs=['saved:'+first.id,'saved:'+second.id];
 const result=await h.service.setHardCards(event,{...p,cardRefs:refs,hard:true,confirmed:true});
 assert.equal(result.updated,2);
 assert.ok((await h.service.assets(event,p)).cardPool.every(x=>x.hardCard));
 await assert.rejects(h.service.setHardCards(event,{...h.a,cardRefs:refs,hard:false,confirmed:true}),/not in this vault/);
 assert.ok((await h.service.assets(event,p)).cardPool.every(x=>x.hardCard));
 await h.service.setHardCards(event,{...p,cardRefs:refs,hard:false,confirmed:true});
 assert.ok((await h.service.assets(event,p)).cardPool.every(x=>!x.hardCard));
});

test('Card Bank discloses full numbers only in the authenticated vault view and shows linked email + retailer',async t=>{
 const h=await env(t),p=h.p,n='4242424242424242';
 await h.service.addCard(event,{...p,card});
 await h.profiles.importRows({...p,retailer:'target',status:'active',rows:[{email:'owner-target@example.test',cc_number:n,cc_exp_month:'08',cc_exp_year:'2031'}]});
 const standard=await h.service.assets(event,p),full=await h.service.assets(event,{...p,showFullCards:true});
 const ref=full.cardPool.find(x=>x.last4==='4242');
 assert.ok(ref);
 assert.equal(ref.fullNumber,n);
 assert.deepEqual(ref.linkedAccounts.map(x=>[x.email,x.retailer]),[['owner-target@example.test','target']]);
 assert.equal(Object.hasOwn(standard.cardPool.find(x=>x.last4==='4242'),'fullNumber'),false);
 assert.equal(JSON.stringify(await h.service.assets(event,h.a)).includes(n),false);
 assert.equal(JSON.stringify(await h.service.assets(event,h.b)).includes('owner-target@example.test'),false);
});

test('Hard Card bulk removal is all-or-nothing if any selected card has multiple retailer uses',async t=>{
 const h=await env(t),p=h.p,n=card.number,other='5555555555554444';
 const one=await h.service.addCard(event,{...p,card}),two=await h.service.addCard(event,{...p,card:{...card,number:other}});
 await h.service.setHardCards(event,{...p,cardRefs:['saved:'+one.id,'saved:'+two.id],hard:true,confirmed:true});
 await h.profiles.importRows({...p,retailer:'target',status:'active',rows:[{email:'first@example.test',cc_number:n}]});
 await h.profiles.importRows({...p,retailer:'walmart',status:'active',rows:[{email:'second@example.test',card:{number:n}}]});
 await assert.rejects(h.service.setHardCards(event,{...p,cardRefs:['saved:'+one.id,'saved:'+two.id],hard:false,confirmed:true}),/multiple profiles/);
 const inventory=(await h.service.assets(event,p)).cardPool;
 assert.equal(inventory.find(x=>x.last4==='4242').hardCard,true);
 assert.equal(inventory.find(x=>x.last4==='4444').hardCard,true);
});
