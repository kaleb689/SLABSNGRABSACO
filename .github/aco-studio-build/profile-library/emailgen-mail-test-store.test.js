'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),
 os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {makeMailTestStore,normalizeConfig}=require('../emailgen-mail-test-store');
const fixture={mailbox:'inbox.one@gmail.com',sender:'sender.one@gmail.com',
 password:'test-inbox-app-password',senderPassword:'test-sender-app-password',
 smtpHost:'smtp.gmail.com',imapHost:'imap.gmail.com',senderImapHost:'imap.gmail.com'};
function keychain(){
 const secret=crypto.randomBytes(32);
 return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',
  encryptString:value=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',secret,iv);
   return Buffer.concat([iv,c.getAuthTag?Buffer.alloc(0):Buffer.alloc(0),c.update(value,'utf8'),c.final(),c.getAuthTag()]);},
  decryptString:buffer=>{const iv=buffer.subarray(0,12),tag=buffer.subarray(buffer.length-16);
   const d=crypto.createDecipheriv('aes-256-gcm',secret,iv);d.setAuthTag(tag);
   return Buffer.concat([d.update(buffer.subarray(12,-16)),d.final()]).toString('utf8');}
 };
}
function workspace(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aco-mail-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('Stores multiple different receivers and senders, never exposing passwords in status or plaintext',t=>{
 const safeStorage=keychain(),store=makeMailTestStore({baseDir:workspace(t),safeStorage,platform:'darwin'});
 assert.deepEqual(store.status().profiles,[]);
 store.save(fixture);
 store.save({...fixture,mailbox:'inbox.two@gmail.com',sender:'sender.two@gmail.com'});
 store.save({...fixture,sender:'alternate@gmail.com',senderPassword:'alt-sender-app-secret'});
 const metadata=store.status();
 assert.equal(metadata.profiles.length,3);
 assert.equal(metadata.saved,true);
 assert.deepEqual(store.read({mailbox:fixture.mailbox,sender:fixture.sender}).password,fixture.password);
 assert.equal(store.read({mailbox:'inbox.two@gmail.com'}).sender,'sender.two@gmail.com');
 assert.equal(store.read({mailbox:fixture.mailbox,sender:'unknown@gmail.com'}),null);
 for(const profile of metadata.profiles){
  assert.equal(profile.password,undefined);
  assert.equal(profile.senderPassword,undefined);
 }
 const ciphertext=fs.readFileSync(store.path);
 assert.equal(fs.statSync(store.path).mode&0o777,0o600);
 for(const value of [fixture.password,fixture.senderPassword,'alt-sender-app-secret'])
  assert.ok(!ciphertext.includes(Buffer.from(value)), 'app password must never be stored as plaintext');
 const restarted=makeMailTestStore({baseDir:path.dirname(store.path),safeStorage,platform:'darwin'});
 assert.equal(restarted.status().profiles.length,3);
});
test('Replacing one account pair keeps others, removing selected pair never clears the rest',t=>{
 const store=makeMailTestStore({baseDir:workspace(t),safeStorage:keychain(),platform:'darwin'});
 store.save(fixture);
 store.save({...fixture,mailbox:'another@gmail.com'});
 store.save({...fixture,password:'updated-inbox-password'});
 assert.equal(store.status().profiles.length,2);
 assert.equal(store.read({mailbox:fixture.mailbox}).password,'updated-inbox-password');
 store.forget({mailbox:fixture.mailbox,sender:fixture.sender});
 assert.equal(store.status().profiles.length,1);
 assert.equal(store.read({mailbox:fixture.mailbox}),null);
 assert.equal(store.read({mailbox:'another@gmail.com'}).password,fixture.password);
});
test('Missing or unsafe Keychain blocks saving, and mismatched sender/receiver identities are rejected',t=>{
 const folder=workspace(t);
 const broken=makeMailTestStore({baseDir:folder,safeStorage:{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'basic_text'},platform:'darwin'});
 assert.throws(()=>broken.save(fixture),/Keychain/);
 assert.equal(fs.existsSync(broken.path),false);
 for(const value of [
  {...fixture,mailbox:'inbox.one+tag@gmail.com',sender:'inbox.one@gmail.com'},
  {...fixture,mailbox:'inbox.one@gmail.com',sender:'inbox.one@googlemail.com'},
  {...fixture,imapHost:'localhost'},
  {...fixture,password:''}
 ])assert.throws(()=>normalizeConfig(value));
});
test('Corrupt or foreign Keychain storage cannot overwrite an existing encrypted credential file',t=>{
 const folder=workspace(t),first=keychain(),saved=makeMailTestStore({baseDir:folder,safeStorage:first,platform:'darwin'});
 saved.save(fixture);const before=fs.readFileSync(saved.path);
 const second=makeMailTestStore({baseDir:folder,safeStorage:keychain(),platform:'darwin'});
 assert.throws(()=>second.save({...fixture,sender:'another@gmail.com'}),/could not be decrypted/);
 assert.deepEqual(fs.readFileSync(saved.path),before);
 assert.equal(saved.read({mailbox:fixture.mailbox}).sender,fixture.sender);
});

test('Missing current credentials can be recovered from verified encrypted owner checkpoint without touching another file',t=>{
 const directory=workspace(t),safeStorage=keychain(),store=makeMailTestStore({baseDir:directory,safeStorage,platform:'darwin'});
 store.save(fixture);
 store.save({...fixture,sender:'second.sender@gmail.com'});
 const ciphertext=fs.readFileSync(store.path),id='20261115T141000Z-0123456789abcdef';
 const checkpoint=path.join(path.dirname(directory),path.basename(directory)+'.encrypted-recovery-backups',id);
 fs.mkdirSync(checkpoint,{recursive:true});
 fs.writeFileSync(path.join(checkpoint,path.basename(store.path)),ciphertext,{mode:0o600});
 fs.writeFileSync(path.join(checkpoint,'manifest.json'),JSON.stringify({version:1,id,
  createdAt:'2026-11-15T14:10:00Z',files:[{name:path.basename(store.path),
   size:ciphertext.length,digest:crypto.createHash('sha256').update(ciphertext).digest('hex')}]}));
 const unrelated=path.join(directory,'some-other-profile-file.encrypted');
 fs.writeFileSync(unrelated,'leave my profile data alone');
 fs.unlinkSync(store.path);
 assert.equal(store.status().credentialFilePresent,false);
 const preview=store.backupStatus();
 assert.equal(preview.credentialFilePresent,false);
 assert.deepEqual(preview.candidates.map(row=>row.count),[2]);
 assert.throws(()=>store.restoreMissingFromBackup({id,confirmed:false}),/Confirm/);
 assert.equal(fs.existsSync(store.path),false);
 const result=store.restoreMissingFromBackup({id,confirmed:true});
 assert.equal(result.count,2);
 assert.equal(store.status().profiles.length,2);
 assert.deepEqual(fs.readFileSync(store.path),ciphertext);
 assert.equal(fs.readFileSync(unrelated,'utf8'),'leave my profile data alone');
 assert.throws(()=>store.restoreMissingFromBackup({id,confirmed:true}),/already exists/);
 fs.rmSync(path.dirname(checkpoint),{recursive:true,force:true});
});
test('Existing encrypted credential file always wins over any rollback snapshot',t=>{
 const directory=workspace(t),safeStorage=keychain(),store=makeMailTestStore({baseDir:directory,safeStorage,platform:'darwin'});
 store.save(fixture);
 const before=fs.readFileSync(store.path);
 assert.throws(()=>store.restoreMissingFromBackup({id:'20261115T141000Z-0123456789abcdef',confirmed:true}),/already exists/);
 assert.deepEqual(fs.readFileSync(store.path),before);
 assert.equal(store.status().credentialFilePresent,true);
});
test('Snapshots encrypted under a different Keychain are never treated as recoverable',t=>{
 const directory=workspace(t),first=keychain(),store=makeMailTestStore({baseDir:directory,safeStorage:first,platform:'darwin'});
 store.save(fixture);const ciphertext=fs.readFileSync(store.path);
 const root=path.join(path.dirname(directory),path.basename(directory)+'.encrypted-recovery-backups');
 const id='20261115T141100Z-1123456789abcdef';fs.mkdirSync(path.join(root,id),{recursive:true});
 fs.writeFileSync(path.join(root,id,path.basename(store.path)),ciphertext);
 fs.writeFileSync(path.join(root,id,'manifest.json'),JSON.stringify({version:1,id,
  createdAt:'2026-11-15T14:11:00Z',files:[{name:path.basename(store.path),
   size:ciphertext.length,digest:crypto.createHash('sha256').update(ciphertext).digest('hex')}]}));
 const incompatible=makeMailTestStore({baseDir:directory,safeStorage:keychain(),platform:'darwin'});
 assert.deepEqual(incompatible.backupStatus().candidates,[]);
 assert.throws(()=>incompatible.status(),/cannot currently be decrypted/);
 assert.deepEqual(fs.readFileSync(store.path),ciphertext);
 fs.rmSync(root,{recursive:true,force:true});
});
