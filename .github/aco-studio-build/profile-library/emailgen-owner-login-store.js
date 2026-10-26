'use strict';
// Owner-only Cloudflare credential persistence in the original app userData
// directory, encrypted with macOS Keychain-backed Electron safeStorage.
// Never persist secrets unencrypted or print secrets to a log.
const fs=require('node:fs');
const path=require('node:path');
const DATA_FILE='aco-cloudflare-owner-login.encrypted';
const HEX_ID=/^[a-f0-9]{32}$/i;
function valid(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Owner credentials must be supplied.');
 const accountId=String(value.accountId||'').trim(),zoneId=String(value.zoneId||'').trim();
 const token=String(value.token||'').trim(),passphrase=String(value.passphrase||'');
 if(!HEX_ID.test(accountId)||!HEX_ID.test(zoneId)||token.length<12||passphrase.length<12)
  throw Error('Account ID, Zone ID, scoped token, and private Email Bank passphrase are required.');
 if(passphrase.length>4096||token.length>4096)throw Error('Cloudflare owner credentials are too long.');
 return {version:1,domain:'sng.sarl',accountId,zoneId,token,passphrase};
}
function makeOwnerLoginStore({baseDir,safeStorage,platform=process.platform}){
 if(typeof baseDir!=='string'||!baseDir)throw Error('Owner app storage directory is required.');
 const file=path.join(baseDir,DATA_FILE);
 function requireKeychain(){
  if(platform!=='darwin'||!safeStorage?.isEncryptionAvailable?.())
   throw Error('Mac Keychain-backed encryption is unavailable. Email Gen cannot remember secrets on this device.');
  if(typeof safeStorage.getSelectedStorageBackend==='function'&&
    safeStorage.getSelectedStorageBackend()==='basic_text')
   throw Error('Insecure credential storage is prohibited.');
 }
 function status(){return {saved:fs.existsSync(file),keychainAvailable:platform==='darwin'&&Boolean(safeStorage?.isEncryptionAvailable?.())};}
 function save(value){
  requireKeychain();const data=valid(value);
  fs.mkdirSync(baseDir,{recursive:true,mode:0o700});
  const encrypted=safeStorage.encryptString(JSON.stringify(data));
  if(!Buffer.isBuffer(encrypted)||encrypted.length<24)throw Error('Encrypted login store failed.');
  const temp=file+'.tmp-'+process.pid;
  try{
   fs.writeFileSync(temp,encrypted,{mode:0o600,flag:'wx'});
   fs.renameSync(temp,file);
   fs.chmodSync(file,0o600);
  }finally{try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return {saved:true};
 }
 function read(){
  if(!fs.existsSync(file))return null;
  requireKeychain();
  const bytes=fs.readFileSync(file);
  if(bytes.length>30000)throw Error('Saved Email Gen login data is invalid.');
  try{
   const parsed=JSON.parse(safeStorage.decryptString(bytes));
   if(parsed?.version!==1||parsed.domain!=='sng.sarl')throw Error('Unexpected login format.');
   return valid(parsed);
  }catch{throw Error('Saved Email Gen login could not be decrypted with this Mac Keychain. The existing bank was not changed.');}
 }
 function forget(){
  if(fs.existsSync(file))fs.unlinkSync(file);
  return {saved:false};
 }
 return {save,read,forget,status,path:file};
}
module.exports={makeOwnerLoginStore};
