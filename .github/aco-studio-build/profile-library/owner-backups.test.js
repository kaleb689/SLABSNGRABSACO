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
