"use strict";
const fs=require("node:fs/promises");
const path=require("node:path");
const {safeStorage,app}=require("electron");
const FILE="private-vault.aes";
function location(){return path.join(app.getPath("userData"),FILE);}
function encryptionReady(){return safeStorage.isEncryptionAvailable();}
const initial=()=>({version:1,sources:[],cards:[],addresses:[],rules:{},activity:[],licenseKey:""});
async function load(){
  if(!encryptionReady())throw Error("Operating system secure storage is unavailable. No private data was loaded.");
  let bytes;try{bytes=await fs.readFile(location());}catch(e){if(e.code==="ENOENT")return initial();throw e;}
  const data=JSON.parse(safeStorage.decryptString(bytes));
  if(data?.version!==1||!Array.isArray(data.sources)||!Array.isArray(data.cards)||!Array.isArray(data.addresses))
    throw Error("Stored private vault is not valid.");
  return data;
}
async function save(data){
  if(!encryptionReady())throw Error("Secure local encryption is unavailable; refusing to save unencrypted data.");
  const file=location();await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const ciphertext=safeStorage.encryptString(JSON.stringify(data));
  const tmp=file+"."+require("node:crypto").randomUUID()+".tmp";
  await fs.writeFile(tmp,ciphertext,{flag:"wx",mode:0o600});
  await fs.rename(tmp,file);
}
module.exports={load,save,initial,location,encryptionReady};
