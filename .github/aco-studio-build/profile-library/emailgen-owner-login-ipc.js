'use strict';
const {makeOwnerLoginStore}=require('./emailgen-owner-login-store');
// IPC is scoped to the actual owner Electron window and to an authorized
// Cloudflare session. The token never gets stored in renderer localStorage.
function registerOwnerLogin({ipcMain,baseDir,safeStorage,cloudflare,sessions,ownerSender,domain='sng.sarl',platform=process.platform}){
 const store=makeOwnerLoginStore({baseDir,safeStorage,platform});
 const authorize=async(config,event)=>{
  if(config.domain!==domain)throw Error('Unrecognized owner Cloudflare domain.');
  const result=await cloudflare.authorize(config);
  if(result?.authorized!==true||result?.domain!==domain)throw Error('Cloudflare did not authorize this account.');
  sessions.set(event.sender.id,{config:{...config,token:config.token.trim()},lastUsed:Date.now()});
  return result;
 };
 ipcMain.handle('cf:remember:save',(event,passphrase)=>{
  ownerSender(event);
  const authorized=sessions.get(event.sender.id);
  if(!authorized?.config||typeof passphrase!=='string'||passphrase.length<12)
   throw Error('Verify your Cloudflare account and unlock your Email Bank before saving.');
  return store.save({...authorized.config,passphrase});
 });
 ipcMain.handle('cf:remember:restore',async event=>{
  ownerSender(event);
  // Explicit diagnostic states: no saved login, unavailable Keychain,
  // failed decryption, Cloudflare authorization, and (renderer-side) bank
  // passphrase mismatch. Never return token or log credentials.
  if(!store.status().saved)return {stored:false,restored:false,reason:'NO_SAVED_LOGIN'};
  if(!store.status().keychainAvailable)return {stored:true,restored:false,reason:'KEYCHAIN_UNAVAILABLE'};
  let saved;
  try{saved=store.read();}
  catch{return {stored:true,restored:false,reason:'KEYCHAIN_DECRYPT_FAILED'};}
  // Do not erase saved credentials on network outages or stale tokens.
  try{
   await authorize({domain,accountId:saved.accountId,zoneId:saved.zoneId,token:saved.token},event);
   return {stored:true,restored:true,passphrase:saved.passphrase,accountId:saved.accountId,zoneId:saved.zoneId};
  }catch(error){
   const message=String(error?.message||'');
   const reason=/\b(401|403|unauthorized|forbidden|invalid.?token|permission|access.?denied)\b/i.test(message)
    ?'CLOUDFLARE_TOKEN_REJECTED':
    /\b(network|offline|timeout|timed out|dns|enotfound|econn|socket|fetch failed|unreachable)\b/i.test(message)
    ?'CLOUDFLARE_UNREACHABLE':'CLOUDFLARE_AUTH_FAILED';
   return {stored:true,restored:false,reason,networkOrAuthError:true};
  }
 });
 ipcMain.handle('cf:remember:status',event=>{ownerSender(event);return store.status();});
 ipcMain.handle('cf:remember:forget',event=>{
  ownerSender(event);
  sessions.delete(event.sender.id);
  return store.forget();
 });
 return {store,authorize};
}
module.exports={registerOwnerLogin};
