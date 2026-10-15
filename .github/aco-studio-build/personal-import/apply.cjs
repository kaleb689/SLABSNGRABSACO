'use strict';
// Apply a small additive overlay to the verified original desktop source.
// Missing/changed anchors fail the build rather than silently replacing newer work.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]||'build-src/App');
function edit(file,changes){const target=path.join(root,file);let s=fs.readFileSync(target,'utf8');
 for(const [from,to] of changes){if(s.split(from).length!==2)throw Error(file+': expected exactly one unchanged integration anchor: '+from.slice(0,80));s=s.replace(from,to);}
 fs.writeFileSync(target,s);
}
for(const name of ['personal-profile-import.js','personal-profile-import-ui.js','personal-profile-import.css'])fs.copyFileSync(path.join(__dirname,name),path.join(root,name));
fs.mkdirSync(path.join(root,'tests'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'personal-profile-import.test.js'),path.join(root,'tests/personal-profile-import.test.js'));
edit('main.js',[
 ["const AddressDistribution=require('./address-distribution');","const {registerPersonalImporter}=require('./personal-profile-import');\nconst AddressDistribution=require('./address-distribution');"],
 ["const personalGate=event=>{ownerSender(event);personalAccess.requireUnlocked();};",`const personalGate=event=>{ownerSender(event);personalAccess.requireUnlocked();};
 const personalImporter=registerPersonalImporter({ipcMain,requireAccess:personalGate,requireOwner:ownerSender,vault:profileVault,
  chooseFiles:()=>dialog.showOpenDialog(ownerWindow,{title:'Import Personal Profiles - PERSONAL ONLY',properties:['openFile','multiSelections'],filters:[{name:'Personal profile files',extensions:['csv','tsv','tab','psv','json','jsonl','ndjson','txt']}]}),
  webAccounts:()=>siteBridge?siteBridge.getLinkedAccountEmails():Promise.resolve({records:[],complete:false,reason:'Website Admin is not connected.'})});`],
 ["ipcMain.handle('personal:security:lock',event=>{ownerSender(event);return personalAccess.lock();});","ipcMain.handle('personal:security:lock',event=>{ownerSender(event);personalImporter.cancel(event);return personalAccess.lock();});"]
]);
edit('preload.js',[[" profileBanks:Object.freeze({",` personalProfileImport:Object.freeze({choose:retailer=>ipcRenderer.invoke('personal:profiles:choose',retailer),confirm:payload=>ipcRenderer.invoke('personal:profiles:confirm',payload),cancel:()=>ipcRenderer.invoke('personal:profiles:cancel')}),
 profileBanks:Object.freeze({`]]);
edit('profile-vault.js',[
 ["async function importRows({scope,customerId,retailer,rows,source='local',status='active'}={}){","async function importRows({scope,customerId,retailer,rows,source='local',status='active',personalImportGuard=false,beforeWrite=null}={}){\n  if(personalImportGuard&&(scope!=='personal'||customerId||typeof beforeWrite!=='function'))throw Error('Personal import requires a fixed Personal destination and access guard.');"],
 ["// A repeated exact email/retailer entry in one bank is not reimported automatically.",`// The dedicated Personal importer rechecks BOTH local banks inside the
   // same serialized transaction used by every profile write. No race can
   // introduce an already-owned customer email into Personal after preview.
   if(personalImportGuard){
    const other=await read('aco');
    // Cross-retailer email reuse is intentional. The serialized guard only
    // rejects an email that already exists in the SAME retailer pool.
    const used=new Set([...existing,...Object.values(other.groups).flat()]
      .filter(x=>x.retailer===retailer).map(x=>x.email));
    for(const row of mapped){if(used.has(row.email))throw Error('This email already exists in the selected retailer pool. Choose files again to recheck duplicates; nothing was imported.');used.add(row.email);}
   }
   // A repeated exact email/retailer entry in one bank is not reimported automatically.`],
 ["d.groups[key]=existing;for(const item of added)auditRecord(d,key,'import',item.email,{retailer:item.retailer});await write(scope,d);", "d.groups[key]=existing;for(const item of added)auditRecord(d,key,'import',item.email,{retailer:item.retailer});if(personalImportGuard)beforeWrite();await write(scope,d);"]
]);
edit('app.js',[
 ["async function ingestFiles(list,acoCustomerId=null){","async function ingestFiles(list,acoCustomerId=null,personalOnly=false){\n if(personalOnly&&acoCustomerId)throw Error('Personal-only files cannot be assigned to customers.');"],
 ["originScope:customer?'aco':'personal',acoCustomerId:customer,importKey:crypto.randomUUID(),error:null","originScope:customer?'aco':'personal',acoCustomerId:customer,personalOnly:personalOnly===true,savedToProfileBank:personalOnly===true,importKey:crypto.randomUUID(),error:null"],
 ["window.JigStudioLocalImport=Object.freeze({",`document.addEventListener('jigstudio:personal-locked',()=>{
 if(!app.files.some(f=>f.personalOnly))return;
 const current=fileEntry();app.files=app.files.filter(f=>!f.personalOnly);
 app.selected=Math.max(0,app.files.indexOf(current));app.results.clear();render();
 document.dispatchEvent(new CustomEvent('jigstudio:bank-context-updated'));
});
window.JigStudioLocalImport=Object.freeze({
 async loadPersonalImport(entries){
  if(!Array.isArray(entries)||!entries.length)throw Error('No confirmed Personal import files returned.');
  const start=app.files.length;
  await ingestFiles(entries.map(({name,text})=>new File([text],name,{type:'text/plain'})),null,true);
  const added=app.files.slice(start);
  if(added.length!==entries.length||added.some(x=>x.error))throw Error('Saved Personal profiles could not be loaded into the workspace.');
  return {scope:'personal',profiles:added.reduce((n,f)=>n+f.parsed.records.length,0)};
 },`],
 ["const id=customerId==null?'':String(customerId);\n  if(id", "if(f.personalOnly)throw Error('This file was imported through Personal Jigs. Its destination is locked to Personal; customer and shared pools cannot receive it.');\n  const id=customerId==null?'':String(customerId);\n  if(id"],
 ["customerId:f.acoCustomerId||null,isWebsiteImport:!!f.websiteImport,bankApplied:!!f.bankAddresses", "customerId:f.acoCustomerId||null,isWebsiteImport:!!f.websiteImport,personalOnly:!!f.personalOnly,savedToProfileBank:!!f.savedToProfileBank,bankApplied:!!f.bankAddresses"],
 ["b.textContent=(f.error?'", "b.textContent=(f.personalOnly?'[Personal only] ':'')+(f.error?'"]
]);
edit('jig-banks-ui.js',[
 ["bind.hidden=!ctx||ctx.isWebsiteImport;","bind.hidden=!ctx||ctx.isWebsiteImport||ctx.personalOnly;"],
 ["$('jigBindMember').disabled=!ctx||ctx.isWebsiteImport||!members.length;","$('jigBindMember').disabled=!ctx||ctx.isWebsiteImport||ctx.personalOnly||!members.length;"],
 ["$('jigUnbindMember').disabled=!ctx||ctx.isWebsiteImport||ctx.scope!=='aco';","$('jigUnbindMember').disabled=!ctx||ctx.isWebsiteImport||ctx.personalOnly||ctx.scope!=='aco';"]
]);
edit('profile-bank-ui.js',[
 ["function normalizeImports(){const target=context();if(!target||!target.count)return [];","function normalizeImports(){const target=context();if(!target||!target.count||target.savedToProfileBank)return [];"],
 ["function backgroundScan(){clearTimeout(debounce);debounce=", "function backgroundScan(){clearTimeout(debounce);if(context()?.savedToProfileBank)return;debounce="],
 ["window.ACOProfileBank=Object.freeze({openCustomer:", "window.ACOProfileBank=Object.freeze({openPersonal:async retailer=>{if(retailerNames[retailer]){$('profileImportRetailer').value=retailer;store.activeRetailer=retailer;}await choose('personal',null);},openCustomer:"]
]);
edit('index.html',[
 ["</head>","<link rel=\"stylesheet\" href=\"./personal-profile-import.css\"></head>"],
 ["<script src=\"./profile-bank-ui.js\"></script>","<script src=\"./profile-bank-ui.js\"></script><script src=\"./personal-profile-import-ui.js\"></script>"]
]);
const pkgPath=path.join(root,'package.json'),pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8'));
for(const name of ['personal-profile-import.js','personal-profile-import-ui.js','personal-profile-import.css'])if(!pkg.build.files.includes(name))pkg.build.files.push(name);
fs.writeFileSync(pkgPath,JSON.stringify(pkg,null,2)+'\n');
console.log('Applied Personal-only import overlay. Existing addresses, card pools and customer data are untouched.');
