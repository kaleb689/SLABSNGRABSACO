'use strict';
// Owner-only mail test credentials. Only the main Electron process decrypts them.
// The native macOS Keychain-backed Electron safeStorage key protects this file.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const FILE='aco-emailgen-test-mail-credentials.encrypted';
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST=/^[a-z0-9](?:[a-z0-9.-]{1,248})[a-z0-9]$/i;
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
 return {version:1,mailbox,sender,password,senderPassword,smtpHost,imapHost,senderImapHost};
}
function makeMailTestStore({baseDir,safeStorage,platform=process.platform}){
 if(typeof baseDir!=='string'||!baseDir)throw Error('Owner application data directory is required.');
 const file=path.join(baseDir,FILE);
 function requireKeychain(){
  if(platform!=='darwin'||!safeStorage?.isEncryptionAvailable?.()||
    (typeof safeStorage.getSelectedStorageBackend==='function'&&safeStorage.getSelectedStorageBackend()==='basic_text'))
   throw Error('Secure Mac Keychain encryption is unavailable. Test passwords were not saved.');
 }
 function status(){
  return {saved:fs.existsSync(file),keychainAvailable:platform==='darwin'&&Boolean(safeStorage?.isEncryptionAvailable?.())};
 }
 function save(value){
  requireKeychain();
  const data=normalizeConfig(value);
  fs.mkdirSync(baseDir,{recursive:true,mode:0o700});
  const encrypted=safeStorage.encryptString(JSON.stringify(data));
  if(!Buffer.isBuffer(encrypted)||encrypted.length<24)throw Error('Keychain encryption failed; no credentials were saved.');
  const temp=file+'.tmp-'+process.pid+'-'+crypto.randomBytes(4).toString('hex');
  try{
   fs.writeFileSync(temp,encrypted,{mode:0o600,flag:'wx'});
   fs.renameSync(temp,file);fs.chmodSync(file,0o600);
  }finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return {saved:true,mailbox:data.mailbox,sender:data.sender,smtpHost:data.smtpHost,
   imapHost:data.imapHost,senderImapHost:data.senderImapHost};
 }
 function read(){
  if(!fs.existsSync(file))return null;
  requireKeychain();
  const bytes=fs.readFileSync(file);
  if(bytes.length>16384)throw Error('Saved mail test credentials are invalid. Re-enter them.');
  try{return normalizeConfig(JSON.parse(safeStorage.decryptString(bytes)));}
  catch{throw Error('Saved mail test credentials could not be unlocked with this Mac Keychain. Re-enter both passwords.');}
 }
 function publicStatus(){
  const s=status();
  if(!s.saved)return s;
  try{
   const {mailbox,sender,smtpHost,imapHost,senderImapHost}=read();
   return {...s,mailbox,sender,smtpHost,imapHost,senderImapHost};
  }catch{return {...s,readable:false};}
 }
 function forget(){
  if(fs.existsSync(file))fs.unlinkSync(file);
  return {saved:false,keychainAvailable:status().keychainAvailable};
 }
 return {save,read,status:publicStatus,forget,path:file};
}
module.exports={makeMailTestStore,normalizeConfig};
