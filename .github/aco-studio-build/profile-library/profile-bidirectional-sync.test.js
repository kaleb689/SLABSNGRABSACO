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
 const calls=[],changes=[];let remoteAddress='100 Example Avenue',reject=false;
 const source=async id=>({customer:{id,name:'Sample Customer'},linked:[{customerId:id,retailer:'pokemoncenter',
  assignmentId:'assignment-1',managedAccountId:'managed-1',assignmentType:'free',remoteUpdatedAt:'2026-10-18T00:00:00Z',active:true,
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
