'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {makeProfileVault}=require('../profile-vault');
const storage={
 isEncryptionAvailable:()=>true,
 encryptString:input=>Buffer.from(input,'utf8'),
 decryptString:bytes=>Buffer.from(bytes).toString('utf8')
};
test('owner Personal and ACO profile vaults keep encrypted recovery snapshots and restore separately',async t=>{
 const baseDir=await fs.mkdtemp(path.join(os.tmpdir(),'owner-profile-backups-'));
 t.after(()=>fs.rm(baseDir,{recursive:true,force:true}));
 const vault=makeProfileVault({baseDir,safeStorage:storage});
 const set=async(scope,customerId,value)=>vault.libraryTransaction(scope,customerId,ctx=>{
   ctx.settings.label=value;return {saved:true};
 },()=>{});
 await set('personal',null,'personal-original');
 await set('personal',null,'personal-current');
 await set('aco','customer-a','aco-original');
 await set('aco','customer-a','aco-current');
 const personal=await vault.backupList('personal'),aco=await vault.backupList('aco');
 assert.equal(personal.length,1);assert.equal(aco.length,1);
 assert.notEqual(personal[0].name,aco[0].name);
 assert.equal((await vault.librarySettings('personal',null)).label,'personal-current');
 assert.equal((await vault.librarySettings('aco','customer-a')).label,'aco-current');
 await vault.backupRestore('personal',personal[0].name);
 assert.equal((await vault.librarySettings('personal',null)).label,'personal-original');
 assert.equal((await vault.librarySettings('aco','customer-a')).label,'aco-current');
 await vault.backupRestore('aco',aco[0].name);
 assert.equal((await vault.librarySettings('aco','customer-a')).label,'aco-original');
 await assert.rejects(vault.backupRestore('aco',personal[0].name),/existing encrypted/);
 const personalFile=vault.paths.personal;
 await fs.rm(personalFile);
 await assert.rejects(vault.list('personal',null),/snapshots exist/);
 assert.equal((await vault.librarySettings('aco','customer-a')).label,'aco-original');
});


test('Missing Security Codes can be selectively restored from encrypted snapshots only after explicit preview and confirmation',async t=>{
 const baseDir=await fs.mkdtemp(path.join(os.tmpdir(),'owner-code-recovery-'));
 t.after(()=>fs.rm(baseDir,{recursive:true,force:true}));
 const vault=makeProfileVault({baseDir,safeStorage:storage});
 const row=(id,retailer,email,cardNumber,code)=>({
  id,retailer,email,label:email,bank:'live',status:'active',revision:0,source:'owner-created-profile',
  data:{email,cc_number:cardNumber,profileSecurityCode:code}
 });
 const personal=row('personal-one','target','personal@example.test','4242424242424242','0044');
 const customerA=row('customer-one','target','customer-a@example.test','4444444444444444','0099');
 const customerB=row('customer-two','target','customer-b@example.test','5555555555555555','7777');
 const edit=async(scope,id,fn)=>vault.libraryTransaction(scope,id,ctx=>{fn(ctx.rows);return {saved:true};},()=>{});
 await edit('personal',null,rows=>rows.push(personal));
 await edit('aco','customer-a',rows=>rows.push(customerA));
 await edit('aco','customer-b',rows=>rows.push(customerB));
 // ACO and Personal backups are separate encrypted files. Both personal
 // and customer A are deliberately cleared to simulate an earlier bad update.
 await vault.libraryTransaction('personal',null,ctx=>{
  ctx.allowIndependentReferenceEdit(ctx.rows[0].id); // Deliberate simulated historical loss
  ctx.rows[0].data.profileSecurityCode='';ctx.rows[0].label='New label';
 },()=>{});
 await vault.libraryTransaction('aco','customer-a',ctx=>{
  ctx.allowIndependentReferenceEdit(ctx.rows[0].id); // Deliberate simulated historical loss
  ctx.rows[0].data.profileSecurityCode='';
 },()=>{});
 const first=await vault.codeRecovery('personal',null,{},()=>{});
 assert.equal(first.recoverable,1);
 assert.equal(first.byRetailer.target,1);
 assert.ok(!JSON.stringify(first).includes('0044'),'preview never exposes secret values');
 assert.equal((await vault.fieldSnapshot('personal',null))[0].data.profileSecurityCode,'','preview must not write');
 const applied=await vault.codeRecovery('personal',null,{confirmed:true,token:first.token},()=>{});
 assert.equal(applied.restored,1);
 const restored=(await vault.fieldSnapshot('personal',null))[0];
 assert.equal(restored.data.profileSecurityCode,'0044');
 assert.equal(restored.label,'New label','recovery must not overwrite current profile changes');
 const second=await vault.codeRecovery('aco','customer-a',{},()=>{});
 assert.equal(second.recoverable,1);
 assert.equal((await vault.codeRecovery('aco','customer-a',{confirmed:true,token:second.token},()=>{})).restored,1);
 assert.equal((await vault.fieldSnapshot('aco','customer-a'))[0].data.profileSecurityCode,'0099');
 assert.equal((await vault.fieldSnapshot('aco','customer-b'))[0].data.profileSecurityCode,'7777');
 assert.equal((await vault.codeRecovery('personal',null,{},()=>{})).recoverable,0);
 const backups=await vault.backupList('personal');
 assert.ok(backups.length>=2,'a pre-recovery encrypted snapshot must exist');
});
test('Security Code recovery never crosses customer ownership or overwrites nonempty fields',async t=>{
 const baseDir=await fs.mkdtemp(path.join(os.tmpdir(),'owner-code-recovery-isolation-'));
 t.after(()=>fs.rm(baseDir,{recursive:true,force:true}));
 const vault=makeProfileVault({baseDir,safeStorage:storage});
 const make=(id,customer,code)=>vault.libraryTransaction('aco',customer,ctx=>{
  ctx.rows.push({id,retailer:'walmart',email:'same@example.test',revision:0,
   data:{email:'same@example.test',card:{number:'4242424242424242'},profileSecurityCode:code}});
 },()=>{});
 await make('a-id','customer-a','');
 await make('b-id','customer-b','0011');
 await vault.libraryTransaction('aco','customer-b',ctx=>{ctx.settings.other='change';},()=>{});
 const preview=await vault.codeRecovery('aco','customer-a',{},()=>{});
 assert.equal(preview.recoverable,0,'matching email and card in another customer must not be read');
 const bPreview=await vault.codeRecovery('aco','customer-b',{},()=>{});
 assert.equal(bPreview.recoverable,0,'existing customer code must not be overwritten');
});
