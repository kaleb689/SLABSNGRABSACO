"use strict";
const fs=require("node:fs/promises");
const path=require("node:path");
const crypto=require("node:crypto");
const {safeStorage,app}=require("electron");
const Portable=require("./portable-backup.cjs");
const FILE="private-vault.aes",BACKUP_DIR="encrypted-vault-backups",MAX_SNAPSHOTS=60;
function location(){return path.join(app.getPath("userData"),FILE);}
function backupDir(){return path.join(app.getPath("userData"),BACKUP_DIR);}
function encryptionReady(){return safeStorage.isEncryptionAvailable();}
const initial=()=>({version:1,sources:[],cards:[],addresses:[],rules:{},activity:[],licenseKey:""});
const valid=Portable.isValidVault;
function assertCrypto(){
 if(!encryptionReady())throw Error("Operating system secure storage is unavailable. No private data was loaded or written.");
}
function decrypt(bytes){
 const decoded=JSON.parse(safeStorage.decryptString(bytes));
 if(!valid(decoded))throw Error("Saved private vault has an invalid format.");
 return decoded;
}
async function snapshots(){
 try{
  const names=(await fs.readdir(backupDir())).filter(name=>/^vault-[0-9TZ-]{16,32}-[a-f0-9]{16}\.aes$/.test(name));
  const details=await Promise.all(names.map(async name=>{
   const stat=await fs.stat(path.join(backupDir(),name));
   return {name,createdAt:stat.mtime.toISOString(),size:stat.size,modified:stat.mtimeMs};
  }));
  return details.sort((a,b)=>b.modified-a.modified);
 }catch(e){if(e.code==="ENOENT")return [];throw e;}
}
async function preservePrevious(){
 let current;
 try{current=await fs.readFile(location());}
 catch(error){if(error.code==="ENOENT")return;throw error;}
 // Store raw OS-encrypted bytes, not plaintext. If the current vault is
 // damaged, keep a copy for investigation instead of overwriting history.
 const dir=backupDir();await fs.mkdir(dir,{recursive:true,mode:0o700});
 const name="vault-"+new Date().toISOString().replace(/[:.]/g,"-")+
   "-"+crypto.randomBytes(8).toString("hex")+".aes";
 await fs.writeFile(path.join(dir,name),current,{flag:"wx",mode:0o600});
 // Remove snapshots beyond the bounded retention, never the current vault.
 // Explicit portable backup exports are NOT in this folder and are untouched.
 const all=await snapshots();
 for(const old of all.slice(MAX_SNAPSHOTS)){
  await fs.rm(path.join(dir,old.name),{force:true}).catch(()=>{});
 }
}
async function load(){
 assertCrypto();
 let bytes;
 try{bytes=await fs.readFile(location());}
 catch(error){
  if(error.code!=="ENOENT")throw error;
  const backups=await snapshots();
  if(backups.length)throw Error("Local vault file is missing but encrypted recovery snapshots exist. Restore a snapshot instead of starting with an empty vault.");
  return initial();
 }
 try{return decrypt(bytes);}
 catch{throw Error("Encrypted vault could not be read. No data was cleared. Use Restore Backup in ACO STUDIO.");}
}
async function save(data){
 assertCrypto();if(!valid(data))throw Error("Refusing to replace the vault with invalid profile data.");
 const file=location();await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const ciphertext=safeStorage.encryptString(JSON.stringify(data));
 const temp=file+"."+crypto.randomUUID()+".tmp";
 await preservePrevious();
 try{
  await fs.writeFile(temp,ciphertext,{flag:"wx",mode:0o600});
  await fs.rename(temp,file);
 }catch(error){await fs.rm(temp,{force:true}).catch(()=>{});throw error;}
}
async function restoreSnapshot(name){
 assertCrypto();
 if(typeof name!=="string"||!/^vault-[0-9TZ-]{16,32}-[a-f0-9]{16}\.aes$/.test(name))
  throw Error("Choose an existing encrypted recovery snapshot.");
 const current=await snapshots();
 if(!current.some(x=>x.name===name))throw Error("This snapshot is unavailable.");
 const decoded=decrypt(await fs.readFile(path.join(backupDir(),name)));
 await save(decoded);
 return {restored:true,sources:decoded.sources.length,cards:decoded.cards.length,addresses:decoded.addresses.length};
}
async function exportPortable(passphrase){
 const state=await load();
 return Portable.encryptBackup(state,passphrase);
}
async function restorePortable(content,passphrase){
 const decoded=await Portable.decryptBackup(content,passphrase);
 await save(decoded);
 return {restored:true,sources:decoded.sources.length,cards:decoded.cards.length,addresses:decoded.addresses.length};
}
module.exports={load,save,initial,location,encryptionReady,snapshots,restoreSnapshot,exportPortable,restorePortable};
