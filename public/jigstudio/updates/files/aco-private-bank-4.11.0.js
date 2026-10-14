'use strict';
// Owner-only encrypted ZIP+4 result bank and Smarty credentials.
// This is in Electron userData, never in App/, a web page, or the update feed.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const ZIP=/^\d{5}(?:-\d{4})?$/;
const PLUS4=/^\d{4}$/;
function norm(value){return String(value??'').normalize('NFKC').toUpperCase().trim().replace(/[.,]/g,' ').replace(/\s+/g,' ');}
function street(value){
 // Standard postal abbreviations are genuinely the same primary delivery point.
 return norm(value).replace(/\b(NORTHWEST|NORTHEAST|SOUTHWEST|SOUTHEAST|NORTH|SOUTH|EAST|WEST)\b/g,x=>({NORTHWEST:'NW',NORTHEAST:'NE',SOUTHWEST:'SW',SOUTHEAST:'SE',NORTH:'N',SOUTH:'S',EAST:'E',WEST:'W'}[x]))
   .replace(/\b(AVENUE|BOULEVARD|STREET|DRIVE|ROAD|LANE|TERRACE|COURT|CIRCLE|PARKWAY|PLACE)\b/g,x=>({AVENUE:'AVE',BOULEVARD:'BLVD',STREET:'ST',DRIVE:'DR',ROAD:'RD',LANE:'LN',TERRACE:'TER',COURT:'CT',CIRCLE:'CIR',PARKWAY:'PKWY',PLACE:'PL'}[x]));
}
function unit(value){return norm(value).replace(/^(?:APARTMENT|APT|SUITE|STE|UNIT|#)\s*#?\s*/,'#').replace(/^#\s*/,'#');}
function parsed(value){
 if(!value||typeof value!=='object')throw Error('Address must be an object.');
 const line1=street(value.address1||value.address||value.addressLine1);
 const line2=unit(value.address2||value.unit||value.addressLine2);
 const state=norm(value.state)==='FLORIDA'?'FL':norm(value.state);
 const zip=String(value.zip||value.zipCode||'').trim();
 if(!line1||line1.length>120||line2.length>100||!/^[A-Z]{2}$/.test(state)||!ZIP.test(zip))throw Error('A valid street, unit, state and five-digit ZIP are required.');
 return {key:[state,zip.slice(0,5),line1,line2].join('|'),state,zip5:zip.slice(0,5),unit:line2};
}
const addressKey=value=>parsed(value).key;
function makeStore({baseDir,safeStorage,lookupSmarty,lookupUsps}={}){
 if(!baseDir||!safeStorage||typeof safeStorage.isEncryptionAvailable!=='function')throw Error('Owner encrypted storage is not configured.');
 const credsFile=path.join(baseDir,'aco-smarty-credentials.bin');
 const zipFile=path.join(baseDir,'aco-verified-zip4.bin');
 let queue=Promise.resolve();
 const supported=()=>Boolean(safeStorage.isEncryptionAvailable());
 function requireEncryption(){if(!supported())throw Error('OS credential encryption is unavailable. No credentials or ZIP+4 results were written to disk.');}
 async function read(file,fallback){
  requireEncryption();
  try{
   const bytes=await fs.readFile(file);
   const obj=JSON.parse(safeStorage.decryptString(bytes));
   if(!obj||obj.version!==1||typeof obj.data!=='object')throw Error('Invalid saved settings.');
   return obj.data;
  }catch(e){if(e.code==='ENOENT')return fallback;throw Error('Could not decrypt stored ACO Studio data on this device. Existing records were not overwritten.');}
 }
 async function write(file,data){
  requireEncryption();
  const encrypted=safeStorage.encryptString(JSON.stringify({version:1,data}));
  const tmp=file+'.tmp-'+crypto.randomUUID();
  await fs.mkdir(baseDir,{recursive:true,mode:0o700});
  try{await fs.writeFile(tmp,encrypted,{mode:0o600,flag:'wx'});await fs.rename(tmp,file);}
  catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});throw e;}
 }
 function exclusive(work){const pending=queue.catch(()=>{}).then(work);queue=pending;return pending;}
 async function smartyStatus(){
  if(!supported())return {saved:false,encryptionAvailable:false};
  const stored=await read(credsFile,{});
  return {saved:!!(stored.authId&&stored.authToken),encryptionAvailable:true,authId:stored.authId?stored.authId.slice(0,4)+'…'+stored.authId.slice(-3):null};
 }
 async function saveSmarty({authId,authToken}={}){
  if(typeof authId!=='string'||!authId.trim()||authId.length>180||/[\r\n]/.test(authId)||typeof authToken!=='string'||!authToken.trim()||authToken.length>300||/[\r\n]/.test(authToken))throw Error('Enter a valid Smarty Auth ID and Auth Token.');
  return exclusive(async()=>{await write(credsFile,{authId:authId.trim(),authToken:authToken.trim()});return {saved:true,encryptionAvailable:true};});
 }
 async function clearSmarty(){return exclusive(async()=>{await fs.rm(credsFile,{force:true});return {saved:false};});}
 async function smartyCredentials(){const creds=await read(credsFile,{});if(!creds.authId||!creds.authToken)throw Error('Save your Smarty Auth ID and Auth Token in ACO Studio settings first.');return creds;}
 async function bank(){const data=await read(zipFile,{verified:{},aliases:{}});return {verified:data.verified&&typeof data.verified==='object'?data.verified:{},aliases:data.aliases&&typeof data.aliases==='object'?data.aliases:{}};}
 async function bankStatus(){if(!supported())return {count:0,encryptionAvailable:false};return {count:Object.keys((await bank()).verified).length,encryptionAvailable:true};}
 async function resolve(input){
  const data=await bank(),key=addressKey(input),base=data.aliases[key]||key,record=data.verified[base];
  if(!record||!PLUS4.test(record.zip4)||record.zip5!==parsed(input).zip5)return null;
  return {zip4:record.zip4,verifiedAt:record.verifiedAt,provider:record.provider,source:key===base?'original':'linked-variation',base};
 }
 async function registerAliases(pairs){
  if(!Array.isArray(pairs)||pairs.length>300)throw Error('The variation list is invalid.');
  return exclusive(async()=>{
   const data=await bank();let count=0;
   for(const pair of pairs){
    let a,b;
    try{a=parsed(pair?.original);b=parsed(pair?.variation);}catch{continue;}
    if(a.state!==b.state||a.zip5!==b.zip5||a.unit!==b.unit)continue; // distinct apartments never share delivery-point codes.
    const base=data.aliases[a.key]||a.key;
    if(!data.verified[base]||!PLUS4.test(data.verified[base].zip4))continue;
    if(b.key===base||data.verified[b.key]||data.aliases[b.key]&&data.aliases[b.key]!==base)continue;
    data.aliases[b.key]=base;count++;
   }
   if(count)await write(zipFile,data);
   return {linked:count};
  });
 }
 async function verify({addresses,provider='smarty',authId,authToken,uspsId,uspsSecret}={}){
  return exclusive(async()=>{
  if(!Array.isArray(addresses)||addresses.length<1||addresses.length>50)throw Error('Select 1 to 50 saved delivery addresses.');
  if(provider!=='smarty'&&provider!=='usps')throw Error('Select Smarty or USPS.');
  const inputs=addresses.map(a=>({address1:String(a?.address1||'').trim(),address2:String(a?.address2||'').trim(),city:String(a?.city||'').trim(),state:String(a?.state||'').trim(),zip:String(a?.zip||'').trim()}));
  const keys=inputs.map(addressKey);
  // Deduplicate by actual primary address+real unit+state+ZIP5, not per generated jig.
  // The canonical main house can share one result across variants linked at export.
  const data=await bank(),missing=new Map(),lookupFor=new Map();let cacheHits=0;
  const results=new Array(inputs.length);
  for(let i=0;i<inputs.length;i++){
   const base=data.aliases[keys[i]]||keys[i];const rec=data.verified[base];
   if(rec&&PLUS4.test(rec.zip4)&&rec.zip5===parsed(inputs[i]).zip5){results[i]={input:inputs[i],ok:true,zip4:rec.zip4,provider:rec.provider,fromBank:true};cacheHits++;}
   else{if(!missing.has(base))missing.set(base,inputs[i]);lookupFor.set(i,base);}
  }
  if(missing.size){
   let remote;
   if(provider==='smarty'){
    if(typeof lookupSmarty!=='function')throw Error('Smarty address verification is unavailable.');
    const supplied=authId&&authToken?{authId,authToken}:await smartyCredentials();
    remote=await lookupSmarty({...supplied,addresses:[...missing.values()]});
   }else{
    if(typeof lookupUsps!=='function')throw Error('USPS verification is unavailable.');
    remote=await lookupUsps({id:uspsId,secret:uspsSecret,addresses:[...missing.values()]});
   }
   const bases=[...missing.keys()];const responses=Array.isArray(remote?.results)?remote.results:[];
   for(let j=0;j<bases.length;j++){
    const r=responses[j];if(r?.ok&&PLUS4.test(r.zip4)){
     data.verified[bases[j]]={zip4:r.zip4,zip5:parsed(missing.get(bases[j])).zip5,verifiedAt:new Date().toISOString(),provider:provider==='smarty'?'Smarty':'USPS'};
    }
   }
   if(responses.some(r=>r?.ok&&PLUS4.test(r.zip4)))await write(zipFile,data);
   for(const [i,base] of lookupFor){const rec=data.verified[base],position=bases.indexOf(base);const fromRemote=responses[position];
    results[i]=rec?{input:inputs[i],ok:true,zip4:rec.zip4,provider:rec.provider,fromBank:false}:{input:inputs[i],ok:false,reason:String(fromRemote?.reason||'Address was not verified.').slice(0,160)};
   }
  }
  return {results,requested:inputs.length,uniqueLookups:missing.size,fromBank:cacheHits,verified:results.filter(r=>r?.ok).length,bankCount:Object.keys(data.verified).length};
  });
 }
 return {smartyStatus,saveSmarty,clearSmarty,smartyCredentials,bankStatus,resolve,verify,registerAliases,addressKey};
}
module.exports={makeStore,addressKey,parsed,street,unit};
