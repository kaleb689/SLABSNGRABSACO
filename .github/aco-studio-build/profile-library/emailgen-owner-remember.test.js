'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {makeOwnerLoginStore}=require('../emailgen-owner-login-store');
const {registerOwnerLogin}=require('../emailgen-owner-login-ipc');
const example={accountId:'a'.repeat(32),zoneId:'b'.repeat(32),token:'scoped-cloudflare-fake-token-for-tests',passphrase:'fake-banks-passphrase-12+'};
function stubKeychain(){
 const key=crypto.randomBytes(32);
 return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'keychain',
  encryptString:value=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
   const out=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
   return Buffer.concat([iv,cipher.getAuthTag(),out]);},
  decryptString:blob=>{const d=crypto.createDecipheriv('aes-256-gcm',key,blob.subarray(0,12));d.setAuthTag(blob.subarray(12,28));
   return Buffer.concat([d.update(blob.subarray(28)),d.final()]).toString('utf8');}
 };
}
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sng-keychain-owner-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('Owner login saves all four fields encrypted, with no token or passphrase on disk',t=>{
 const baseDir=temp(t),safeStorage=stubKeychain(),store=makeOwnerLoginStore({baseDir,safeStorage,platform:'darwin'});
 assert.equal(store.status().saved,false);
 assert.deepEqual(store.save(example),{saved:true});
 const raw=fs.readFileSync(store.path);
 for(const value of Object.values(example))assert.ok(!raw.includes(Buffer.from(value)),'no credential may be present as plaintext');
 assert.equal(fs.statSync(store.path).mode&0o777,0o600);
 const newInstance=makeOwnerLoginStore({baseDir,safeStorage,platform:'darwin'});
 assert.deepEqual(newInstance.read(),{version:1,domain:'sng.sarl',...example});
});
test('Owner login survives update-like reinitialization; corrupt Keychain data never erases saved login',t=>{
 const baseDir=temp(t),safeStorage=stubKeychain();
 const before=makeOwnerLoginStore({baseDir,safeStorage,platform:'darwin'});
 before.save(example);
 const bytes=fs.readFileSync(before.path);
 assert.throws(()=>makeOwnerLoginStore({baseDir,safeStorage:stubKeychain(),platform:'darwin'}).read(),/could not be decrypted/);
 assert.deepEqual(fs.readFileSync(before.path),bytes);
 assert.deepEqual(makeOwnerLoginStore({baseDir,safeStorage,platform:'darwin'}).read().token,example.token);
});
test('Cannot silently save plaintext if Mac Keychain encryption is unavailable',t=>{
 const baseDir=temp(t),unsafe={isEncryptionAvailable:()=>false};
 assert.throws(()=>makeOwnerLoginStore({baseDir,safeStorage:unsafe,platform:'darwin'}).save(example),/Keychain/);
 assert.throws(()=>makeOwnerLoginStore({baseDir,safeStorage:stubKeychain(),platform:'linux'}).save(example),/Keychain/);
 assert.equal(fs.readdirSync(baseDir).length,0);
});
test('No credentials are saved on invalid input or overwritten after a failed save',t=>{
 const baseDir=temp(t),safeStorage=stubKeychain(),store=makeOwnerLoginStore({baseDir,safeStorage,platform:'darwin'});
 store.save(example);
 const bytes=fs.readFileSync(store.path);
 assert.throws(()=>store.save({...example,accountId:'invalid'}),/required/);
 assert.deepEqual(fs.readFileSync(store.path),bytes);
 store.forget();assert.equal(store.status().saved,false);
});
test('Owner IPC restores through Cloudflare authorization and never sends token back to renderer',async t=>{
 const baseDir=temp(t),safeStorage=stubKeychain(),handlers=new Map(),sessions=new Map();
 const ipcMain={handle:(name,fn)=>handlers.set(name,fn)};
 const event={sender:{id:14}},cloudflare={authorize:async config=>({authorized:true,domain:config.domain})};
 registerOwnerLogin({ipcMain,baseDir,safeStorage,cloudflare,sessions,ownerSender:e=>{if(e.sender.id!==14)throw Error('Unauthorized window');},platform:'darwin'});
 assert.throws(()=>handlers.get('cf:remember:save')(event,example.passphrase),/Verify/);
 sessions.set(14,{config:{domain:'sng.sarl',accountId:example.accountId,zoneId:example.zoneId,token:example.token},lastUsed:Date.now()});
 assert.equal(handlers.get('cf:remember:save')(event,example.passphrase).saved,true);
 sessions.clear();
 const restored=await handlers.get('cf:remember:restore')(event);
 assert.equal(restored.restored,true);
 assert.equal(restored.passphrase,example.passphrase);
 assert.ok(!Object.hasOwn(restored,'token'),'token must not be returned to browser renderer');
 assert.equal(sessions.get(14).config.token,example.token);
 assert.equal(handlers.get('cf:remember:forget')(event).saved,false);
 assert.equal(sessions.size,0);
 assert.deepEqual(await handlers.get('cf:remember:restore')(event),{stored:false,restored:false,reason:'NO_SAVED_LOGIN'});
});
test('Transient Cloudflare outage keeps Keychain login for retry without resubmitting',async t=>{
 const baseDir=temp(t),safeStorage=stubKeychain(),handlers=new Map(),sessions=new Map();
 makeOwnerLoginStore({baseDir,safeStorage,platform:'darwin'}).save(example);
 registerOwnerLogin({ipcMain:{handle:(id,fn)=>handlers.set(id,fn)},baseDir,safeStorage,
  cloudflare:{authorize:async()=>{throw Error('network unavailable with secret '+example.token);}},
  sessions,ownerSender:()=>{},platform:'darwin'});
 const result=await handlers.get('cf:remember:restore')({sender:{id:1}});
 assert.deepEqual(result,{stored:true,restored:false,reason:'CLOUDFLARE_UNREACHABLE',networkOrAuthError:true});
 assert.ok(!JSON.stringify(result).includes(example.token));
 assert.equal(makeOwnerLoginStore({baseDir,safeStorage,platform:'darwin'}).status().saved,true);
});
test('Saved-login UI auto-reconnects and manual unlock remembers only after successful verification',()=>{
 const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
 assert.match(app,/addEvents\(\);setupRememberedOwnerControls\(\);setupNewEmailBankReset\(\);render\(\);void restoreRememberedOwner\(\)/);
 assert.match(app,/api\(\)\.saveRemembered\(passphrase\)/);
 assert.match(app,/api\(\)\.restoreRemembered\(\)/);
 assert.match(app,/Forget this Mac/);
 assert.match(app,/await unlockBank\(result\.passphrase\)/);
});

test('Reconnect distinguishes invalid saved token without changing Keychain encrypted bytes',async t=>{
 const baseDir=temp(t),safeStorage=stubKeychain(),handlers=new Map(),sessions=new Map();
 const store=makeOwnerLoginStore({baseDir,safeStorage,platform:'darwin'});
 store.save(example);const original=fs.readFileSync(store.path);
 registerOwnerLogin({ipcMain:{handle:(id,fn)=>handlers.set(id,fn)},baseDir,safeStorage,
  cloudflare:{authorize:async()=>{throw Error('401 invalid token '+example.token);}},
  sessions,ownerSender:()=>{},platform:'darwin'});
 const result=await handlers.get('cf:remember:restore')({sender:{id:1}});
 assert.equal(result.reason,'CLOUDFLARE_TOKEN_REJECTED');
 assert.equal(result.restored,false);
 assert.ok(!JSON.stringify(result).includes(example.token),'token may not escape in error');
 assert.deepEqual(fs.readFileSync(store.path),original);
 assert.equal(sessions.size,0);
});
test('Reconnect distinguishes Mac Keychain decryption failure and preserves saved file',async t=>{
 const baseDir=temp(t),originalSafe=stubKeychain(),handlers=new Map();
 const store=makeOwnerLoginStore({baseDir,safeStorage:originalSafe,platform:'darwin'});
 store.save(example);const original=fs.readFileSync(store.path);
 registerOwnerLogin({ipcMain:{handle:(id,fn)=>handlers.set(id,fn)},baseDir,
  safeStorage:stubKeychain(),cloudflare:{authorize:async()=>{throw Error('must not authorize');}},
  sessions:new Map(),ownerSender:()=>{},platform:'darwin'});
 const result=await handlers.get('cf:remember:restore')({sender:{id:1}});
 assert.deepEqual(result,{stored:true,restored:false,reason:'KEYCHAIN_DECRYPT_FAILED'});
 assert.deepEqual(fs.readFileSync(store.path),original);
});
test('Reconnect distinguishes missing Keychain availability and never writes secrets',async t=>{
 const baseDir=temp(t),safeStorage=stubKeychain(),handlers=new Map();
 makeOwnerLoginStore({baseDir,safeStorage,platform:'darwin'}).save(example);
 const original=fs.readFileSync(path.join(baseDir,'aco-cloudflare-owner-login.encrypted'));
 registerOwnerLogin({ipcMain:{handle:(id,fn)=>handlers.set(id,fn)},baseDir,
  safeStorage:{isEncryptionAvailable:()=>false},cloudflare:{authorize:async()=>{throw Error('must not call');}},
  sessions:new Map(),ownerSender:()=>{},platform:'darwin'});
 assert.equal((await handlers.get('cf:remember:restore')({sender:{id:1}})).reason,'KEYCHAIN_UNAVAILABLE');
 assert.deepEqual(fs.readFileSync(path.join(baseDir,'aco-cloudflare-owner-login.encrypted')),original);
});
test('Reconnect UI displays explicit reason for each failure and never clears the encrypted bank',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','emailgen-owner-remember-ui.js'),'utf8');
 for(const code of ['NO_SAVED_LOGIN','KEYCHAIN_UNAVAILABLE','KEYCHAIN_DECRYPT_FAILED','CLOUDFLARE_TOKEN_REJECTED','CLOUDFLARE_UNREACHABLE','CLOUDFLARE_AUTH_FAILED','BANK_PASSPHRASE_MISMATCH','NEW_BANK_SETUP_PENDING'])
  assert.ok(source.includes(code),code+' must be handled');
 assert.match(source,/note\.textContent=reconnectStatusMessage/);
 assert.doesNotMatch(source,/localStorage\.removeItem|localStorage\.clear\(/);
 assert.doesNotMatch(source,/console\.log|console\.error/);
});
