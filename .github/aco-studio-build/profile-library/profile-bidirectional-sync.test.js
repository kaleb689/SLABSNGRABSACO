'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {makeProfileVault}=require('../profile-vault'),{createLibrary}=require('../profile-library-service');
const Draft=require('../profile-draft-core'),Core=require('../profile-library-core');
const sender={sender:{id:111}},intruder={sender:{id:999}};
const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
function fullData(address='100 Example Avenue',retailer='pokemoncenter'){
 const v={email:'account@example.test',first:'Alex',last:'Example',phone:'9545550100',
  'shipping.address1':address,'shipping.city':'Example','shipping.state':'FL','shipping.zip':'33324',
  'billing.address1':address,'billing.city':'Example','billing.state':'FL','billing.zip':'33324'};
 const data=Draft.blank(retailer,Core.format(retailer),v);
 Core.putCard(data,{number:'4242424242424242',cardholder:'Alex Example',month:'08',year:'2031',type:'Visa'});
 return data;
}
async function harness(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'aco-bidirectional-test-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const profiles=makeProfileVault({baseDir:dir,safeStorage});
 const calls=[],changes=[];let active=true;let remoteAddress='100 Example Avenue',reject=false;
 const source=async id=>({customer:{id,name:'Sample Customer'},linked:[{customerId:id,retailer:'pokemoncenter',
  assignmentId:'assignment-1',managedAccountId:'managed-1',assignmentType:'free',remoteUpdatedAt:remoteAddress==='100 Example Avenue'?'2026-10-18T00:00:00Z':'2026-10-18T00:02:00Z',active,
  data:fullData(remoteAddress)}]});
 const auth=async(e,scope,id)=>{
  if(e.sender.id!==111)throw Error('Not the owner window');
  if(scope==='personal')return null;
  if(id!=='customer-a')throw Error('Customer vault mismatch');
  return id;
 };
 const lib=createLibrary({profiles,authorize:auth,guard:(e)=>{if(e.sender.id!==111)throw Error('Not owner');},
  cardVault:()=>({withSelectedForJig:(_key,_ids,fn)=>fn([])}),
  getCustomerProfileSource:source,
  saveCustomerProfile:async(id,identity,payload)=>{
   calls.push({id,identity,payload});
   if(reject)throw Error('Website conflict; reload before editing');
   remoteAddress=payload.fields['shipping.address1']||remoteAddress;
   return {saved:true,updatedAt:'2026-10-18T00:01:00Z'};
  },
  changeCustomerAssignment:async(id,remote,operation)=>{calls.push({id,remote,operation});active=false;return {saved:true};},
  getCustomerSavedData:async id=>({customer:{id},addresses:[{id:'addr-1',address:'100 Example Avenue',revision:'a'.repeat(64)}],paymentMethods:[{id:'pay-1',last4:'4242',revision:'b'.repeat(64)}]}),
  updateCustomerSavedData:async(id,kind,recordId,payload)=>{
   changes.push({id,kind,recordId,payload});
   if(reject)throw Error('409 Stale website revision');
   return {saved:true};
  }});
 return {lib,profiles,calls,changes,setAddress:value=>remoteAddress=value,setReject:value=>reject=value};
}
const owner={scope:'aco',customerId:'customer-a'};
test('Website to Studio: linked account updates modify the same customer card and never Personal',async t=>{
 const h=await harness(t);
 const first=await h.lib.syncCustomer(sender,owner);
 assert.equal(first.created,1);
 let list=await h.lib.list(sender,owner);
 const id=list.profiles[0].id,rev=list.profiles[0].revision;
 assert.equal(list.profiles[0].source,'website-linked-profile');
 assert.equal(list.profiles[0].remoteType,'free');
 assert.equal(list.profiles[0].remoteManagedId,'managed-1');
 h.setAddress('240 Changed Street');
 const second=await h.lib.syncCustomer(sender,owner);
 assert.equal(second.created,0);assert.equal(second.updated,1);
 list=await h.lib.list(sender,owner);
 assert.equal(list.profiles.length,1);assert.equal(list.profiles[0].id,id);
 assert.ok(list.profiles[0].revision>rev);
 assert.equal((await h.lib.list(sender,{scope:'personal',customerId:null})).profiles.length,0);
});
test('Studio to website: linked edit calls exact website assignment before local commit',async t=>{
 const h=await harness(t);await h.lib.syncCustomer(sender,owner);
 let record=(await h.lib.list(sender,owner)).profiles[0];
 const fields={email:'account@example.test',label:'Updated',first:'Alex',last:'Example',phone:'9545550100',
  'shipping.first':'Alex','shipping.last':'Example','shipping.phone':'9545550100',
  'shipping.address1':'420 Published Court','shipping.city':'Example','shipping.state':'FL','shipping.zip':'33324',
  'billing.address1':'100 Example Avenue','billing.city':'Example','billing.state':'FL','billing.zip':'33324'};
 const saved=await h.lib.edit(sender,{...owner,profileId:record.id,revision:record.revision,fields});
 assert.equal(saved.remoteSaved,true);
 assert.equal(saved.localOnly,false);
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].id,'customer-a');
 assert.equal(h.calls[0].identity.managedAccountId,'managed-1');
 assert.equal(h.calls[0].identity.type,'free');
 assert.equal(h.calls[0].payload.fields['shipping.address1'],'420 Published Court');
 record=(await h.lib.list(sender,owner)).profiles[0];
 assert.ok(record.revision>0);
});
test('A refused website edit leaves the local record untouched (no false success)',async t=>{
 const h=await harness(t);await h.lib.syncCustomer(sender,owner);
 const before=(await h.lib.list(sender,owner)).profiles[0];
 h.setReject(true);
 await assert.rejects(h.lib.edit(sender,{...owner,profileId:before.id,revision:before.revision,fields:{
  email:'account@example.test','shipping.address1':'999 Old Request Drive',first:'Alex',last:'Example',
  'shipping.city':'Example','shipping.state':'FL','shipping.zip':'33324'}}),/Website conflict/);
 const after=(await h.lib.list(sender,owner)).profiles[0];
 assert.deepEqual(after,before);
});
test('Website saved-address and payment changes are authorized and version checked',async t=>{
 const h=await harness(t);
 const snapshot=await h.lib.websiteSnapshot(sender,owner);
 assert.equal(snapshot.customer.id,'customer-a');
 assert.equal(snapshot.paymentMethods[0].last4,'4242');
 let r=await h.lib.saveWebsiteAddress(sender,{...owner,addressId:'addr-1',expectedRevision:'a'.repeat(64),address:{address:'New Street'},confirmed:true});
 assert.equal(r.saved,true);assert.equal(h.changes[0].kind,'address');assert.equal(h.changes[0].id,'customer-a');
 r=await h.lib.saveWebsitePayment(sender,{...owner,paymentId:'pay-1',expectedRevision:'b'.repeat(64),payment:{cardholder:'New Holder'},confirmed:true});
 assert.equal(r.saved,true);assert.equal(h.changes[1].kind,'payment');
 await assert.rejects(h.lib.saveWebsiteAddress(sender,{...owner,addressId:'addr-1',expectedRevision:'invalid',confirmed:true}),/current saved address/);
 await assert.rejects(h.lib.websiteSnapshot(sender,{scope:'personal',customerId:null}),/only available/);
 await assert.rejects(h.lib.websiteSnapshot(intruder,owner),/owner window/);
 assert.equal(h.changes.length,2);
});
test('Website vault version conflict cannot be mistaken for a successful sync',async t=>{
 const h=await harness(t);h.setReject(true);
 await assert.rejects(h.lib.saveWebsitePayment(sender,{...owner,paymentId:'pay-1',expectedRevision:'a'.repeat(64),payment:{cardholder:'Not Saved'},confirmed:true}),/Stale website revision/);
 assert.equal(h.changes.length,1);
});

test('Explicit saved record IDs and separate billing address survive website to Studio import',()=>{
 const {sourceForCustomer}=require('../customer-profile-source');
 const customer={id:'customer-a',name:'Alex Sample',shipping:{address:'Origin',city:'Sample',state:'FL',zip:'33324'}};
 const saved={
  addresses:[
   {id:'addr-other',firstName:'Other',lastName:'Person',address:'99 Wrong Lane',city:'Other',state:'FL',zip:'33325'},
   {id:'addr-selected',firstName:'Alex',lastName:'Sample',address:'123 Selected Street',city:'Selected',state:'FL',zip:'33324'}],
  paymentMethods:[
   {id:'card-other',acoCardNumber:'5555555555554444',expMonth:'01',expYear:'2030',cardholder:'Wrong'},
   {id:'card-selected',acoCardNumber:'4242424242424242',expMonth:'08',expYear:'2031',cardholder:'Alex Sample'}]
 };
 const memberships={memberships:[{id:'managed-1',assignmentId:'assignment-1',customerAccountId:'customer-a',type:'free',active:true,
  assignmentRetailer:'pkc',accountEmail:'account@example.test',
  retailers:{pkc:{username:'account@example.test'}},savedAddressId:'addr-selected',savedPaymentMethodId:'card-selected',
  customerBillingProfile:{profileName:'Billing profile',firstName:'Bill',lastName:'Example',email:'customer@example.test',phone:'9545550100',
   address:'425 Billing Court',city:'Billing',state:'FL',zip:'33325',country:'US'}}]};
 const result=sourceForCustomer(customer,saved,memberships);
 assert.equal(result.linked.length,1);
 const row=result.linked[0];
 assert.equal(row.managedAccountId,'managed-1');
 assert.equal(row.assignmentType,'free');
 assert.equal(row.data.shipping.addressLine1,'123 Selected Street');
 assert.equal(row.data.billing.addressLine1,'425 Billing Court');
 assert.equal(row.data.card.number,'4242424242424242');
});

test('Applying a jig to a linked customer publishes its shipping address to website and Studio',async t=>{
 const h=await harness(t);await h.lib.syncCustomer(sender,owner);
 const row=(await h.lib.list(sender,owner)).profiles[0];
 const result=await h.lib.publishLinkedJig(sender,{...owner,profileId:row.id,expectedRevision:row.revision,
   confirmed:true,address:{address1:'531 Verified Jig Lane',address2:'',city:'New City',state:'FL',zip:'33325'}});
 assert.equal(result.saved,true);assert.equal(result.remoteSaved,true);
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].payload.fields['shipping.address1'],'531 Verified Jig Lane');
 assert.equal(h.calls[0].payload.fields['shipping.city'],'New City');
 const next=(await h.lib.list(sender,owner)).profiles[0];
 assert.ok(next.revision>row.revision);
 assert.equal((await h.lib.list(sender,{scope:'personal',customerId:null})).profiles.length,0);
 // A remote change event must not apply the retailer jig a second time.
 await h.lib.syncCustomer(sender,owner);
 const imported=(await h.lib.list(sender,owner)).profiles[0];
 assert.equal(Draft.toValues(imported.data)['shipping.address1'],'531 Verified Jig Lane');
 await h.lib.syncCustomer(sender,owner);
 const stable=(await h.lib.list(sender,owner)).profiles[0];
 assert.equal(Draft.toValues(stable.data)['shipping.address1'],'531 Verified Jig Lane');
});
test('A stale linked jig cannot publish or change an existing profile',async t=>{
 const h=await harness(t);await h.lib.syncCustomer(sender,owner);
 const row=(await h.lib.list(sender,owner)).profiles[0];
 await assert.rejects(h.lib.publishLinkedJig(sender,{...owner,profileId:row.id,expectedRevision:row.revision-1,
  confirmed:true,address:{address1:'700 Stale Street',city:'Example',state:'FL',zip:'33324'}}),/changed after your preview/);
 assert.equal(h.calls.length,0);
 await assert.rejects(h.lib.publishLinkedJig(sender,{scope:'personal',customerId:null,profileId:row.id,expectedRevision:row.revision,
  confirmed:true,address:{address1:'700 Stale Street',city:'Example',state:'FL',zip:'33324'}}),/website-linked/);
 assert.equal(h.calls.length,0);
});

test('upstream conflict invalidates old editors and requires an explicit choice',async t=>{
 const h=await harness(t);await h.lib.syncCustomer(sender,owner);
 let row=(await h.lib.list(sender,owner)).profiles[0];
 await h.profiles.libraryTransaction('aco','customer-a',ctx=>{ctx.rows[0].manualOverride=true;},()=>{});
 const previousRevision=row.revision;h.setAddress('900 Latest Website Street');await h.lib.syncCustomer(sender,owner);
 row=(await h.lib.list(sender,owner)).profiles[0];assert.ok(row.revision>previousRevision);assert.equal(row.needsReview,true);assert.equal(Core.values(row.pendingWebsiteData)['shipping.address1'],'900 Latest Website Street');
 await assert.rejects(h.lib.edit(sender,{...owner,profileId:row.id,revision:previousRevision,fields:{email:row.email}}),/changed/);
 await assert.rejects(h.lib.edit(sender,{...owner,profileId:row.id,revision:row.revision,fields:{email:row.email}}),/Resolve the website conflict/);
 assert.equal(h.calls.length,0);await h.lib.resolveSourceConflict(sender,{...owner,profileId:row.id,revision:row.revision,choice:'website',confirmed:true});
 row=(await h.lib.list(sender,owner)).profiles[0];assert.equal(row.needsReview,false);assert.equal(Core.values(row.data)['shipping.address1'],'900 Latest Website Street');
});
test('confirmed unlink updates website before local status and permits exact local deletion afterward',async t=>{
 const h=await harness(t);await h.lib.syncCustomer(sender,owner);let row=(await h.lib.list(sender,owner)).profiles[0];
 await assert.rejects(h.lib.removeLocal(sender,{...owner,profileId:row.id,revision:row.revision,confirmed:true}),/Return this linked account/);
 await assert.rejects(h.lib.changeAssignment(sender,{...owner,profileId:row.id,revision:row.revision,operation:'unlink'}),/Confirm/);
 await h.lib.changeAssignment(sender,{...owner,profileId:row.id,revision:row.revision,operation:'unlink',confirmed:true});
 row=(await h.lib.list(sender,owner)).profiles[0];assert.equal(row.sourceLinked,false);assert.equal(row.stage,'in-progress');assert.equal(h.calls[0].operation,'unlink');
 await h.lib.removeLocal(sender,{...owner,profileId:row.id,revision:row.revision,confirmed:true});assert.equal((await h.lib.list(sender,owner)).profiles.length,0);
});
test('local imports are never implicitly converted to website-linked records by matching email',async t=>{
 const h=await harness(t);await h.profiles.importRows({scope:'aco',customerId:'customer-a',retailer:'pokemoncenter',rows:[fullData()]});
 await h.lib.syncCustomer(sender,owner);const list=(await h.lib.list(sender,owner)).profiles;assert.equal(list.length,2);assert.equal(list.filter(x=>x.source==='website-linked-profile').length,1);assert.equal(list.filter(x=>x.localOnly).length,1);
});

test('explicit local-to-website linking confirms the server save before replacing the exact local mirror',async t=>{const h=await harness(t);await h.profiles.importRows({scope:'aco',customerId:'customer-a',retailer:'pokemoncenter',rows:[fullData('700 Local Street')]});await h.lib.syncCustomer(sender,owner);let rows=(await h.lib.list(sender,owner)).profiles,local=rows.find(x=>x.localOnly),mirror=rows.find(x=>x.sourceLinked);const request={...owner,profileId:local.id,revision:local.revision,mirrorId:mirror.id,mirrorRevision:mirror.revision,confirmed:true};h.setReject(true);await assert.rejects(h.lib.linkLocal(sender,request),/Website conflict/);assert.equal((await h.lib.list(sender,owner)).profiles.length,2);h.setReject(false);await h.lib.linkLocal(sender,request);rows=(await h.lib.list(sender,owner)).profiles;assert.equal(rows.length,1);assert.equal(rows[0].id,local.id);assert.equal(rows[0].sourceLinked,true);assert.equal(h.calls.at(-1).payload.fields['shipping.address1'],'700 Local Street');await assert.rejects(h.lib.linkLocal(sender,{...request,scope:'personal',customerId:null}),/Confirm linking/);});
