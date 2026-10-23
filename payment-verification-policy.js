import fsDefault from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const forbidden=new Set(['cvv','cvv2','cvc','cvc2','cid','csc','cc_cvv','securitycode','security_code','accountsecuritycode','customsecuritycode','custom_security_code','cardverificationvalue']);
export function stripPaymentVerifiers(value,depth=0){
 if(depth>60)throw Error('Payment data nesting exceeds supported depth.');
 if(Array.isArray(value))return value.map(x=>stripPaymentVerifiers(x,depth+1));
 if(!value||typeof value!=='object')return value;
 const out={};for(const [k,v]of Object.entries(value)){
  if(['__proto__','constructor','prototype'].includes(k))continue;
  out[k]=forbidden.has(k.toLowerCase())?'':stripPaymentVerifiers(v,depth+1);
 }return out;
}
// Before accepting traffic, remove legacy verifier values from existing JSON
// stores, including encrypted nested records and encrypted backup archives.
// Atomic replacement; never create a second copy containing the old values.
export async function purgeLegacyPaymentVerifiers({directory,decryptRaw,encrypt,fs=fsDefault}={}){
 let changedFiles=0,scannedFiles=0,unreadableEncryptedRecords=0;
 async function rewrite(value,depth=0){
  if(depth>60)throw Error('Legacy payment data nesting exceeds supported depth.');
  if(!value||typeof value!=='object')return value;
  if(value.alg==='AES-256-GCM'&&value.iv&&value.tag&&value.data){
   let original;try{original=decryptRaw(value);}catch{unreadableEncryptedRecords++;return value;}
   const next=await rewrite(original,depth+1);
   return JSON.stringify(original)===JSON.stringify(next)?value:encrypt(next);
  }
  if(Array.isArray(value))return Promise.all(value.map(x=>rewrite(x,depth+1)));
  const out={};for(const [k,v]of Object.entries(value)){
   if(['__proto__','constructor','prototype'].includes(k))continue;
   out[k]=forbidden.has(k.toLowerCase())?'':await rewrite(v,depth+1);
  }return out;
 }
 async function walk(dir){
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
   if(entry.isSymbolicLink())continue;
   const file=path.join(dir,entry.name);
   if(entry.isDirectory()){await walk(file);continue;}
   if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
   let original;try{original=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error instanceof SyntaxError)continue;throw error;}
   scannedFiles++;const next=await rewrite(original);
   if(JSON.stringify(next)===JSON.stringify(original))continue;
   const tmp=file+'.payment-cleanup-'+crypto.randomUUID()+'.tmp';
   try{await fs.writeFile(tmp,JSON.stringify(next,null,2),{mode:0o600,flag:'wx'});await fs.rename(tmp,file);}catch(error){await fs.rm(tmp,{force:true}).catch(()=>{});throw error;}
   changedFiles++;
  }
 }
 await walk(directory);return {changedFiles,scannedFiles,unreadableEncryptedRecords};
}
