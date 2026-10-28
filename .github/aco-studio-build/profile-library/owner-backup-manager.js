'use strict';
// Local, encrypted-byte-only owner recovery checkpoints. Never decrypt into a
// renderer, upload a vault, or include reference values in metadata or logs.
const path=require('node:path'),crypto=require('node:crypto'),fsp=require('node:fs/promises');
const cache=new Map();
const sha=buf=>crypto.createHash('sha256').update(buf).digest('hex');
const validId=id=>typeof id==='string'&&/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{16}$/.test(id);
function createBackupManager({baseDir,safeStorage,fs=fsp,clock=()=>new Date()}={}){
 if(!baseDir||!safeStorage)throw Error('An encrypted local vault is required for backup management.');
 const root=path.join(baseDir,'encrypted-owner-workspace-checkpoints');
 const allowed=name=>/^[a-z0-9][a-z0-9_.-]*\.encrypted$/i.test(name)&&
  /(?:personal|aco|jig|studio|owner|customer|profile|card|address|email|vault)/i.test(name);
 const ensureCrypto=()=>{if(!safeStorage.isEncryptionAvailable())throw Error('OS encryption is unavailable. No backup or restore was performed.');};
 let pending=Promise.resolve(),previews=new Map();
 const serial=fn=>{const result=pending.then(fn);pending=result.catch(()=>{});return result;};
 async function sources(){
  let entries;try{entries=await fs.readdir(baseDir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const list=entries.filter(e=>e.isFile()&&allowed(e.name)).map(e=>e.name).sort();
  if(list.length>40)throw Error('Too many encrypted vault files for a safe checkpoint.');
  return list;
 }
 async function index(){
  let names;try{names=await fs.readdir(root);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const rows=[];
  for(const id of names.filter(validId)){
   try{
    const parsed=JSON.parse(await fs.readFile(path.join(root,id,'manifest.json'),'utf8'));
    if(parsed.version!==1||parsed.id!==id||!Array.isArray(parsed.files))continue;
    rows.push({id,createdAt:parsed.createdAt,reason:parsed.reason,files:parsed.files.length,
      bytes:parsed.files.reduce((a,v)=>a+v.size,0)});
   }catch{/* Partial checkpoint is never offered for restore. */}
  }
  return rows.sort((a,b)=>b.id.localeCompare(a.id));
 }
 async function createUnsafe(reason){
  ensureCrypto();
  const files=await sources();
  if(!files.length)return {created:false,reason:'No local encrypted vault files were present.'};
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const id=clock().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')+'-'+crypto.randomBytes(8).toString('hex');
  const dest=path.join(root,id);
  await fs.mkdir(dest,{mode:0o700});
  const manifest={version:1,id,createdAt:clock().toISOString(),reason,files:[]};
  try{
   for(const name of files){
    const source=path.join(baseDir,name),before=await fs.stat(source);
    if(!before.isFile()||before.size>40*1024*1024)throw Error('One encrypted file is unsupported or oversized.');
    const bytes=await fs.readFile(source);
    if(bytes.length!==before.size)throw Error('An encrypted vault changed during backup. Retry.');
    // The bytes must be decryptable by the same Mac. No decoded values leave this function.
    if(typeof safeStorage.decryptString!=='function'||typeof safeStorage.decryptString(bytes)!=='string')
     throw Error('A vault could not be authenticated with the device keychain.');
    const after=await fs.stat(source);
    if(before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw Error('A vault changed during backup. Retry.');
    await fs.writeFile(path.join(dest,name),bytes,{mode:0o600,flag:'wx'});
    manifest.files.push({name,size:bytes.length,digest:sha(bytes)});
   }
   await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest),{mode:0o600,flag:'wx'});
   return {created:true,id,createdAt:manifest.createdAt,files:manifest.files.length};
  }catch(e){await fs.rm(dest,{recursive:true,force:true}).catch(()=>{});throw e;}
 }
 async function checkpoint(reason='manual',options={}){
  if(!['manual','daily','pre-change','pre-restore'].includes(reason))throw Error('Unsupported checkpoint type.');
  return serial(async()=>{
   const rows=await index(),latest=rows.find(r=>r.reason===reason);
   const minAge=reason==='daily'?24*3600e3:reason==='pre-change'?2*60e3:0;
   if(latest&&minAge&&Date.now()-Date.parse(latest.createdAt)<minAge)return {created:false,id:latest.id,reason:'Recent encrypted checkpoint already exists.'};
   const result=await createUnsafe(reason);
   // Keep a rolling recent history and weekly/monthly anchors instead of
   // discarding all older checkpoints after 120 rapid edits.
   const all=await index(),keepers=new Set(all.slice(0,150).map(x=>x.id));
   const byMonth=new Set(),byWeek=new Set();
   for(const row of all){
    const month=row.createdAt.slice(0,7),week=Math.floor(Date.parse(row.createdAt)/(7*864e5));
    if(!byMonth.has(month)){byMonth.add(month);keepers.add(row.id);}
    if(!byWeek.has(week)){byWeek.add(week);keepers.add(row.id);}
   }
   for(const row of all)if(!keepers.has(row.id))await fs.rm(path.join(root,row.id),{recursive:true,force:true});
   return result;
  });
 }
 async function readVerified(id){
  if(!validId(id))throw Error('Choose a listed checkpoint.');
  const folder=path.join(root,id),m=JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8'));
  if(m.version!==1||m.id!==id||!Array.isArray(m.files)||!m.files.length||m.files.length>40)
   throw Error('This checkpoint is incomplete.');
  ensureCrypto();
  const records=[];
  for(const item of m.files){
   if(!allowed(item.name)||!Number.isSafeInteger(item.size)||item.size<1||!(/^[a-f0-9]{64}$/.test(item.digest)))
    throw Error('Checkpoint file manifest failed validation.');
   const bytes=await fs.readFile(path.join(folder,item.name));
   if(bytes.length!==item.size||sha(bytes)!==item.digest)throw Error('Checkpoint integrity failed. Current data was not modified.');
   if(typeof safeStorage.decryptString(bytes)!=='string')throw Error('Checkpoint cannot be decrypted on this Mac.');
   records.push({name:item.name,bytes});
  }
  return {manifest:m,records};
 }
 async function previewRestore(id){
  return serial(async()=>{
   const saved=await readVerified(id),current=await sources();
   const digest={};
   for(const name of current)digest[name]=sha(await fs.readFile(path.join(baseDir,name)));
   const token=crypto.randomBytes(16).toString('hex');
   previews.clear();previews.set(token,{id,at:Date.now(),digest});
   return {preview:true,token,checkpoint:id,createdAt:saved.manifest.createdAt,reason:saved.manifest.reason,
    affectedFiles:saved.records.length,newerFilesKept:current.filter(name=>!saved.records.some(x=>x.name===name)).length,
    note:'Restoring changes local encrypted files. A safety checkpoint of the current state is created first; other devices and website data are not changed.'};
  });
 }
 async function restore({token,confirmed}={}){
  if(confirmed!==true)throw Error('Explicit restore approval is required.');
  return serial(async()=>{
   const p=previews.get(String(token||''));previews.delete(token);
   if(!p||Date.now()-p.at>10*60000)throw Error('Backup restore preview expired. Choose a checkpoint again.');
   const saved=await readVerified(p.id),current=await sources();
   if(current.length!==Object.keys(p.digest).length)throw Error('Local vault files changed since preview. Nothing restored.');
   for(const name of current)if(sha(await fs.readFile(path.join(baseDir,name)))!==p.digest[name])
    throw Error('A local vault changed since preview. Nothing restored.');
   // A restore is reversible: preserve a complete encrypted snapshot immediately
   // before touching any vault, and fail closed if that safety copy cannot be made.
   const safeguard=await createUnsafe('pre-restore');
   if(!safeguard.created)throw Error('Safety checkpoint could not be created. Restore cancelled.');
   const originals=new Map();
   for(const item of saved.records)try{originals.set(item.name,await fs.readFile(path.join(baseDir,item.name)));}catch(e){if(e.code==='ENOENT')originals.set(item.name,null);else throw e;}
   let changed=0;
   try{
    for(const item of saved.records){
     const target=path.join(baseDir,item.name),temp=target+'.'+crypto.randomBytes(8).toString('hex')+'.restore';
     await fs.writeFile(temp,item.bytes,{mode:0o600,flag:'wx'});
     try{await fs.rename(temp,target);}catch(e){await fs.rm(temp,{force:true});throw e;}
     changed++;
    }
   }catch(error){
    for(const item of saved.records){
     const before=originals.get(item.name),target=path.join(baseDir,item.name);
     try{if(before===null)await fs.rm(target,{force:true});else if(before)await fs.writeFile(target,before,{mode:0o600});}
     catch{/* The safeguard checkpoint remains available for manual recovery. */}
    }
    throw Error('Restore failed; original encrypted files were reinstated where possible. Safety checkpoint '+safeguard.id+' was retained.');
   }
   return {restored:true,files:changed,safetyCheckpoint:safeguard.id,restartRequired:true};
  });
 }
 async function status(){const rows=await index(),files=await sources();return {automatic:true,encrypted:true,backupCount:rows.length,lastBackup:rows[0]?.createdAt||null,fileCount:files.length,checkpoints:rows.slice(0,50)};}
 return Object.freeze({checkpoint,status,previewRestore,restore});
}
function forVault(options){
 const key=path.resolve(options.baseDir);
 if(!cache.has(key))cache.set(key,createBackupManager(options));
 return cache.get(key);
}
module.exports={createBackupManager,forVault};