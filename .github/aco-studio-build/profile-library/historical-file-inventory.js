'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const LIMIT=5000,MAX_DEPTH=6,MAX_MS=30000;
const SKIP_FOLDERS=new Set(['node_modules','.git','.cache','cache','caches','tmp','temp']);
function category(name){
 const n=String(name||'').toLowerCase();
 const vault=/(?:profile|retailer|jig|studio|card|vault)/.test(n);
 if(vault&&/\.encrypted(?:\.(?:bak|backup|old|prev|copy))?$/.test(n))return 'encryptedVaultCopies';
 if(vault&&/\.(?:bak|backup|old|prev|copy)$/.test(n))return 'historicBackupCopies';
 if(/\.(?:csv|json|tsv|txt)$/.test(n)&&/(?:profile|shikari|valor|target|walmart|pkc|pokemon|costco|sams|export|import)/.test(n))return 'possibleOriginalFiles';
 if(vault&&/\.(?:zip|tar|gz|7z)$/.test(n))return 'archives';
 return null;
}
// Native folder selection happens in the privileged main process. Never read
// file contents, follow symlinks, return file paths, log credentials, or write.
async function inventoryFolder(root,{check=()=>{},fileSystem=fs,now=Date.now}={}){
 if(typeof root!=='string'||!path.isAbsolute(root))throw Error('Select a directory through the Mac folder picker.');
 const start=now(),stat=await fileSystem.lstat(root);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Choose a real directory (not a shortcut).');
 const result={readOnly:true,folders:0,files:0,examined:0,skippedLinks:0,deniedDirectories:0,limited:false,
  categories:{encryptedVaultCopies:0,historicBackupCopies:0,possibleOriginalFiles:0,archives:0},
  oldest:null,newest:null,contentsInspected:false,pathsExposed:false};
 const queue=[{dir:root,depth:0}];
 while(queue.length){
  check();
  if(result.examined>=LIMIT||now()-start>MAX_MS){result.limited=true;break;}
  const {dir,depth}=queue.shift();
  let entries;
  try{entries=await fileSystem.readdir(dir,{withFileTypes:true});}
  catch{result.deniedDirectories++;continue;}
  result.folders++;
  for(const entry of entries){
   if(result.examined>=LIMIT||now()-start>MAX_MS){result.limited=true;break;}
   result.examined++;
   if(entry.isSymbolicLink()){result.skippedLinks++;continue;}
   if(entry.isDirectory()){
    if(depth<MAX_DEPTH&&!SKIP_FOLDERS.has(entry.name.toLowerCase()))
     queue.push({dir:path.join(dir,entry.name),depth:depth+1});
    continue;
   }
   if(!entry.isFile())continue;
   result.files++;
   const kind=category(entry.name);
   if(!kind)continue;
   let st;
   try{st=await fileSystem.lstat(path.join(dir,entry.name));}
   catch{continue;}
   if(!st.isFile()||st.isSymbolicLink())continue;
   result.categories[kind]++;
   const date=st.mtime.toISOString().slice(0,10);
   if(result.oldest===null||date<result.oldest)result.oldest=date;
   if(result.newest===null||date>result.newest)result.newest=date;
  }
 }
 check();
 return result;
}

// The owner explicitly authorizes one folder in the native macOS picker.
// File contents remain in the privileged main process and are *only* handed
// to the existing read-only reference review. Never send paths or contents
// to the renderer, write to disk, or follow symlinks.
async function collectOriginalFiles(root,{check=()=>{},fileSystem=fs,now=Date.now,validate=()=>true}={}){
 if(typeof root!=='string'||!path.isAbsolute(root))throw Error('Choose a folder in macOS.');
 const st=await fileSystem.lstat(root);
 if(!st.isDirectory()||st.isSymbolicLink())throw Error('Select an actual directory.');
 const start=now(),maxEntries=5000,maxDepth=6,maxBytes=26*1024*1024,maxFiles=20;
 const stats={candidates:0,scanned:0,skippedOther:0,skippedSensitiveNames:0,
  skippedLarge:0,unreadable:0,incompatible:0,limited:false,contentsInspected:true};
 const names=[],queue=[{dir:root,depth:0}];let seen=0;
 while(queue.length){
  check();
  if(seen>=maxEntries||now()-start>30000){stats.limited=true;break;}
  const {dir,depth}=queue.shift();
  let entries;
  try{entries=await fileSystem.readdir(dir,{withFileTypes:true});}
  catch{stats.unreadable++;continue;}
  for(const item of entries){
   if(seen>=maxEntries||now()-start>30000){stats.limited=true;break;}
   seen++;
   if(item.isSymbolicLink())continue;
   if(item.isDirectory()){
    if(depth<maxDepth&&!SKIP_FOLDERS.has(item.name.toLowerCase()))
     queue.push({dir:path.join(dir,item.name),depth:depth+1});
    continue;
   }
   if(!item.isFile())continue;
   if(!/\.(?:csv|json|tsv|txt)$/i.test(item.name))continue;
   // Never inspect password lists, authentication exports, or unrelated
   // free-text data. JSON/CSV profile exports need not have "profile" in name.
   if(/(?:password|credential|secret|token|apikey|api[_-]?key|emails?[_-]?list|studio[_-]?emails)/i.test(item.name)){
    stats.skippedSensitiveNames++;continue;
   }
   if(/\.txt$/i.test(item.name)&&category(item.name)!=='possibleOriginalFiles'){
    stats.skippedOther++;continue;
   }
   let fileStat;
   try{fileStat=await fileSystem.lstat(path.join(dir,item.name));}
   catch{stats.unreadable++;continue;}
   if(!fileStat.isFile()||fileStat.isSymbolicLink())continue;
   stats.candidates++;
   if(fileStat.size>maxBytes||fileStat.size===0){stats.skippedLarge++;continue;}
   names.push({fileName:item.name,full:path.join(dir,item.name),size:fileStat.size,mtime:fileStat.mtimeMs});
  }
 }
 // Earlier originals are more likely to predate accidental data loss.
 names.sort((a,b)=>a.mtime-b.mtime||a.fileName.localeCompare(b.fileName));
 const files=[];let total=0;
 for(const item of names){
  check();
  if(files.length>=maxFiles||total+item.size>maxBytes||now()-start>30000){
   stats.limited=true;break;
  }
  let text;
  try{text=await fileSystem.readFile(item.full,'utf8');}
  catch{stats.unreadable++;continue;}
  try{if(!validate(item.fileName,text)){stats.incompatible++;continue;}}
  catch{stats.incompatible++;continue;}
  total+=Buffer.byteLength(text);
  files.push({fileName:item.fileName,text});
  stats.scanned++;
 }
 check();
 return {files,stats};
}
module.exports={inventoryFolder,category,collectOriginalFiles};
