'use strict';
// Multiple owner-only sender/receiver presets, encrypted at rest with native
// macOS Keychain-backed Electron safeStorage. No password reaches renderer via
// status, and test sends resolve an EXACT configured forwarding inbox.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const FILE='aco-emailgen-test-mail-credentials.encrypted';
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST=/^[a-z0-9](?:[a-z0-9.-]{1,248})[a-z0-9]$/i;
const ID_SEPARATOR='::';
function normalizeConfig(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Mail test accounts are required.');
 const mailbox=String(value.mailbox||'').trim().toLowerCase(),sender=String(value.sender||'').trim().toLowerCase();
 const password=String(value.password||''),senderPassword=String(value.senderPassword||'');
 const smtpHost=String(value.smtpHost||'').trim().toLowerCase();
 const imapHost=String(value.imapHost||'').trim().toLowerCase();
 const senderImapHost=String(value.senderImapHost||'').trim().toLowerCase();
 if(!EMAIL.test(mailbox)||!EMAIL.test(sender)||sender.endsWith('@sng.sarl'))
  throw Error('A valid forwarding inbox and separate sending account are required.');
 const gmailId=v=>{
  const [local,domain]=v.split('@');
  return ['gmail.com','googlemail.com'].includes(domain)?local.split('+')[0].replace(/\./g,'')+'@gmail.com':v;
 };
 if(gmailId(mailbox)===gmailId(sender))throw Error('Use a separate sender, not the forwarding destination.');
 if(!password||!senderPassword||password.length>256||senderPassword.length>256)
  throw Error('Both mail app passwords are required for secure saving.');
 for(const host of [smtpHost,imapHost,senderImapHost]){
  if(!HOST.test(host)||!host.includes('.')||/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host))
   throw Error('Use valid public SMTP and IMAP server names.');
 }
 return {mailbox,sender,password,senderPassword,smtpHost,imapHost,senderImapHost};
}
function keyOf(config){return config.mailbox+ID_SEPARATOR+config.sender;}
function metadata(config){
 return {mailbox:config.mailbox,sender:config.sender,smtpHost:config.smtpHost,
  imapHost:config.imapHost,senderImapHost:config.senderImapHost,
  updatedAt:config.updatedAt||null,key:keyOf(config)};
}
function makeMailTestStore({baseDir,safeStorage,platform=process.platform}){
 if(typeof baseDir!=='string'||!baseDir)throw Error('Owner application data directory is required.');
 const file=path.join(baseDir,FILE);
 function requireKeychain(){
  if(platform!=='darwin'||!safeStorage?.isEncryptionAvailable?.()||
    (typeof safeStorage.getSelectedStorageBackend==='function'&&safeStorage.getSelectedStorageBackend()==='basic_text'))
   throw Error('Secure Mac Keychain encryption is unavailable. Test passwords were not saved.');
 }
 function encryptWrite(items){
  requireKeychain();
  const data={version:2,accounts:items};
  fs.mkdirSync(baseDir,{recursive:true,mode:0o700});
  const encrypted=safeStorage.encryptString(JSON.stringify(data));
  if(!Buffer.isBuffer(encrypted)||encrypted.length<24)throw Error('Keychain encryption failed; no credentials were saved.');
  const temp=file+'.tmp-'+process.pid+'-'+crypto.randomBytes(4).toString('hex');
  try{fs.writeFileSync(temp,encrypted,{mode:0o600,flag:'wx'});
   fs.renameSync(temp,file);fs.chmodSync(file,0o600);
  }finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
 }
 function readAccounts(){
  if(!fs.existsSync(file))return [];
  requireKeychain();
  const bytes=fs.readFileSync(file);
  if(bytes.length>131072)throw Error('Saved mail credentials are invalid.');
  try{
   const parsed=JSON.parse(safeStorage.decryptString(bytes));
   const entries=parsed?.version===1?[parsed]:parsed?.version===2&&Array.isArray(parsed.accounts)?parsed.accounts:null;
   if(!entries||entries.length>60)throw Error('Unknown format.');
   const keys=new Set();
   return entries.map(item=>{
    const config=normalizeConfig(item),key=keyOf(config);
    if(keys.has(key))throw Error('Duplicate saved configuration.');
    keys.add(key);
    return {...config,updatedAt:typeof item.updatedAt==='string'&&Number.isFinite(Date.parse(item.updatedAt))?item.updatedAt:null};
   });
  }catch{throw Error('Saved mail test accounts could not be decrypted with this Mac Keychain. Re-enter their passwords.');}
 }
 function status(){
  const keychainAvailable=platform==='darwin'&&Boolean(safeStorage?.isEncryptionAvailable?.());
  if(!fs.existsSync(file))return {saved:false,keychainAvailable,profiles:[]};
  const accounts=readAccounts().map(metadata);
  return {saved:accounts.length>0,keychainAvailable,profiles:accounts};
 }
 function save(value){
  requireKeychain();
  const config=normalizeConfig(value),accounts=readAccounts();
  const key=keyOf(config),at=accounts.findIndex(item=>keyOf(item)===key);
  const updated={...config,updatedAt:new Date().toISOString()};
  if(at>=0)accounts.splice(at,1,updated);else accounts.push(updated);
  if(accounts.length>60)throw Error('Maximum 60 saved forwarding/sender pairs.');
  encryptWrite(accounts);
  return {saved:true,profile:metadata(updated),count:accounts.length};
 }
 function read({mailbox,sender}={}){
  requireKeychain();
  const accounts=readAccounts(),destination=String(mailbox||'').trim().toLowerCase(),from=String(sender||'').trim().toLowerCase();
  if(!destination)throw Error('Choose the forwarding inbox to test.');
  const matching=accounts.filter(item=>item.mailbox===destination&&(!from||item.sender===from))
   .sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
  return matching[0]||null;
 }
 function forget({mailbox,sender}={}){
  requireKeychain();
  const destination=String(mailbox||'').trim().toLowerCase(),from=String(sender||'').trim().toLowerCase();
  if(!destination||!from)throw Error('Choose an exact saved sender and receiver configuration to remove.');
  const accounts=readAccounts(),remaining=accounts.filter(item=>keyOf(item)!==destination+ID_SEPARATOR+from);
  if(remaining.length===accounts.length)return {saved:accounts.length>0,removed:false};
  if(!remaining.length){fs.unlinkSync(file);return {saved:false,removed:true};}
  encryptWrite(remaining);
  return {saved:true,removed:true,count:remaining.length};
 }
 return {save,read,status,forget,path:file};
}
module.exports={makeMailTestStore,normalizeConfig,keyOf};
