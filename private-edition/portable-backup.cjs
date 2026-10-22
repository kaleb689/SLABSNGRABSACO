"use strict";
const crypto = require("node:crypto");
const {promisify} = require("node:util");
const derive = promisify(crypto.scrypt);
const MARKER = "ACO-STUDIO-ENCRYPTED-BACKUP";
const maximum = 64 * 1024 * 1024;

function isValidVault(data) {
 return !!(data && typeof data === "object" && data.version === 1 &&
  Array.isArray(data.sources) && Array.isArray(data.cards) &&
  Array.isArray(data.addresses) && data.sources.every(source =>
    source && typeof source.id === "string" && typeof source.retailer === "string" &&
    source.file && Array.isArray(source.file.rows)));
}
function passwordCheck(passphrase) {
 if(typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 512)
  throw Error("Use a backup passphrase of at least 12 characters.");
 return passphrase;
}
async function keyFor(password, salt) {
 return derive(password,salt,32,{N:32768,r:8,p:1,maxmem:128*1024*1024});
}
async function encryptBackup(data,passphrase) {
 if(!isValidVault(data))throw Error("The saved customer profile bank has an invalid format.");
 const raw=Buffer.from(JSON.stringify(data),"utf8");
 if(raw.length>maximum)throw Error("The backup is too large.");
 const salt=crypto.randomBytes(32),iv=crypto.randomBytes(12);
 const key=await keyFor(passwordCheck(passphrase),salt);
 const encrypt=crypto.createCipheriv("aes-256-gcm",key,iv);
 const ciphertext=Buffer.concat([encrypt.update(raw),encrypt.final()]);
 key.fill(0);raw.fill(0);
 return JSON.stringify({format:MARKER,version:1,createdAt:new Date().toISOString(),
  kdf:"scrypt",cipher:"aes-256-gcm",
  salt:salt.toString("base64"),iv:iv.toString("base64"),
  tag:encrypt.getAuthTag().toString("base64"),
  ciphertext:ciphertext.toString("base64")});
}
async function decryptBackup(content,passphrase) {
 if(typeof content!=="string"||Buffer.byteLength(content,"utf8")>maximum*1.5)
  throw Error("The backup is too large or unreadable.");
 let payload;
 try{payload=JSON.parse(content);}catch{throw Error("Invalid encrypted backup file.");}
 if(payload?.format!==MARKER||payload?.version!==1||payload?.kdf!=="scrypt"||
  payload?.cipher!=="aes-256-gcm")
  throw Error("This file is not an ACO STUDIO encrypted backup.");
 const b64=(field,min,max)=>{
  if(typeof payload[field]!=="string"||!/^[A-Za-z0-9+/]*={0,2}$/.test(payload[field])||
    payload[field].length>max*1.4+8)throw Error("The backup is damaged.");
  const data=Buffer.from(payload[field],"base64");
  if(data.length<min||data.length>max)throw Error("The backup is damaged.");
  return data;
 };
 const salt=b64("salt",32,32),iv=b64("iv",12,12),tag=b64("tag",16,16),
  encrypted=b64("ciphertext",1,maximum);
 const key=await keyFor(passwordCheck(passphrase),salt);
 let contentBytes;
 try{
  const decipher=crypto.createDecipheriv("aes-256-gcm",key,iv);
  decipher.setAuthTag(tag);
  contentBytes=Buffer.concat([decipher.update(encrypted),decipher.final()]);
 }catch{throw Error("The backup passphrase is incorrect or the backup is damaged.");}
 finally{key.fill(0);}
 let restored;
 try{restored=JSON.parse(contentBytes.toString("utf8"));}
 catch{throw Error("The decrypted backup contains invalid data.");}
 finally{contentBytes.fill(0);}
 if(!isValidVault(restored))throw Error("The encrypted backup is not a valid ACO STUDIO profile bank.");
 return restored;
}
module.exports={encryptBackup,decryptBackup,isValidVault};
