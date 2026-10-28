'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createBackupManager}=require('../owner-backup-manager');
const {makeProfileVault}=require('../profile-vault');
const safeStorage={
 isEncryptionAvailable:()=>true,
 encryptString:text=>Buffer.from('TEST-CIPHERTEXT:'+text),
 decryptString:buf=>{const s=Buffer.from(buf).toString();if(!s.startsWith('TEST-CIPHERTEXT:'))throw Error('Invalid ciphertext');return s.slice(16);}
};
async function scenario(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aco-encrypted-workspace-'));
 t.after(async()=>{await fs.rm(root,{force:true,recursive:true});await fs.rm(root+'.encrypted-recovery-backups',{force:true,recursive:true});});
 const manager=createBackupManager({baseDir:root,safeStorage});
 const names=['personal-retailer-profiles.encrypted','aco-customer-retailer-profiles.encrypted',
  'jig-studio-personal-cards.encrypted','jig-studio-personal-addresses.encrypted',
  'jig-studio-aco-cards.encrypted','jig-studio-aco-addresses.encrypted'];
 const store=async(name,value)=>fs.writeFile(path.join(root,name),safeStorage.encryptString(JSON.stringify({value})),{mode:0o600});
 const read=async name=>JSON.parse(safeStorage.decryptString(await fs.readFile(path.join(root,name)))).value;
 for(const [i,name] of names.entries())await store(name,'original-'+i);
 return {root,manager,names,store,read};
}
test('automatic encrypted checkpoints cover profile, card, address, email and customer scope files, independently of export',async t=>{
 const h=await scenario(t);
 const first=await h.manager.checkpoint('daily');assert.equal(first.created,true);
 const second=await h.manager.checkpoint('daily');assert.equal(second.created,false,'daily checkpoint should not multiply on frequent refreshes');
 let status=await h.manager.status();
 assert.equal(status.encrypted,true);assert.equal(status.automatic,true);
 assert.equal(status.fileCount,6);assert.equal(status.backupCount,1);
 assert.equal(status.checkpoints[0].files,6);
 assert.ok(!JSON.stringify(status).includes('original-'),'metadata must not disclose vault contents');
 await h.store(h.names[2],'new-card-data');
 await h.store(h.names[3],'new-address-data');
 const plan=await h.manager.previewRestore(first.id);
 assert.equal(plan.affectedFiles,6);
 assert.equal(await h.read(h.names[2]),'new-card-data','a preview must never restore anything');
 await assert.rejects(h.manager.restore({token:plan.token,confirmed:false}),/approval/);
 const applied=await h.manager.restore({token:plan.token,confirmed:true});
 assert.equal(applied.restored,true);assert.equal(applied.files,6);
 assert.equal(await h.read(h.names[2]),'original-2');assert.equal(await h.read(h.names[3]),'original-3');
 assert.equal(applied.restartRequired,true);
 assert.ok((await h.manager.status()).checkpoints.some(row=>row.reason==='pre-restore'));
 const safety=await h.manager.previewRestore(applied.safetyCheckpoint);
 await h.manager.restore({token:safety.token,confirmed:true});
 assert.equal(await h.read(h.names[2]),'new-card-data','safety snapshot lets owner undo the rollback');
});
test('rollback must refuse changed live vaults after preview without modifying any data',async t=>{
 const h=await scenario(t),saved=await h.manager.checkpoint('manual');
 const plan=await h.manager.previewRestore(saved.id);
 await h.store(h.names[0],'more-recent-data');
 await assert.rejects(h.manager.restore({token:plan.token,confirmed:true}),/changed since preview/);
 assert.equal(await h.read(h.names[0]),'more-recent-data');
});
test('corrupted checkpoints are never offered for unsafe restoration',async t=>{
 const h=await scenario(t),saved=await h.manager.checkpoint('manual');
 const file=path.join(h.root+'.encrypted-recovery-backups',saved.id,h.names[2]);
 await fs.writeFile(file,Buffer.from('CORRUPTED'));
 await assert.rejects(h.manager.previewRestore(saved.id),/integrity failed/);
 assert.equal(await h.read(h.names[2]),'original-2');
});
test('profile writes retain automatic historical pre-write backups and full workspace checkpoints',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aco-automatic-prewrite-'));t.after(async()=>{await fs.rm(root,{recursive:true,force:true});await fs.rm(root+'.encrypted-recovery-backups',{recursive:true,force:true});});
 const vault=makeProfileVault({baseDir:root,safeStorage});
 const set=value=>vault.libraryTransaction('personal',null,ctx=>{ctx.settings.label=value;},()=>{});
 await set('original');await set('changed');await set('later');
 const snapshots=await vault.backupList('personal');
 assert.ok(snapshots.length>=2,'per-write profile snapshots remain in place');
 const status=await vault.backupStatus();assert.ok(status.backupCount>=1);
 const manual=await vault.backupCheckpoint();assert.equal(manual.created,true);
 const plan=await vault.backupPreview(manual.id);assert.ok(plan.preview);
 assert.ok(!JSON.stringify(plan).includes('later'),'backup preview has metadata only');
});
test('restore can only be performed for known checkpoint IDs with a fresh owner-reviewed token',async t=>{
 const h=await scenario(t);
 const entry=await h.manager.checkpoint('manual');
 await assert.rejects(h.manager.previewRestore('../../other'),/Choose a listed/);
 await assert.rejects(h.manager.restore({token:'made-up',confirmed:true}),/expired/);
 assert.ok((await h.manager.previewRestore(entry.id)).token);
});

test('every Card Bank critical write is eligible for its own encrypted rollback checkpoint',async t=>{
 const h=await scenario(t);
 const first=await h.manager.checkpoint('critical-change');
 await h.store(h.names[2],'card-after-first-edit');
 const second=await h.manager.checkpoint('critical-change');
 assert.equal(first.created,true);
 assert.equal(second.created,true,'critical card changes must never be skipped by the short profile-change throttle');
 assert.notEqual(first.id,second.id);
 await h.store(h.names[2],'card-after-second-edit');
 const plan=await h.manager.previewRestore(second.id);
 await h.manager.restore({token:plan.token,confirmed:true});
 assert.equal(await h.read(h.names[2]),'card-after-first-edit');
});
