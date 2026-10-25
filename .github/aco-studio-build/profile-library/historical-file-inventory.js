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
module.exports={inventoryFolder,category};
