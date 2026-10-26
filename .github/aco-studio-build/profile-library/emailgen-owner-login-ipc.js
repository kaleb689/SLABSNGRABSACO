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
  let saved;
  try{saved=store.read();}
  catch(error){
   // Never return secrets or raw Keychain/Cloudflare exception text to the UI.
   const keychainUnavailable=/Keychain-backed encryption is unavailable|Insecure credential storage/.test(String(error?.message||''));
   return {stored:store.status().saved,restored:false,
    reason:keychainUnavailable?'keychain-unavailable':'keychain-decrypt-failed'};
  }
  if(!saved)return {stored:false,restored:false,reason:'not-saved'};
  // Keep credentials, original encrypted bank, and current owner account intact
  // if the provider rejects the token or the network is temporarily offline.
  try{
   await authorize({domain,accountId:saved.accountId,zoneId:saved.zoneId,token:saved.token},event);
   return {stored:true,restored:true,passphrase:saved.passphrase,accountId:saved.accountId,zoneId:saved.zoneId};
  }catch{
   return {stored:true,restored:false,networkOrAuthError:true,reason:'cloudflare-authorization-failed'};
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
