'use strict';
/** Two physically separate encrypted owner profile stores.
 * Personal profile rows NEVER enter the ACO file or customer APIs. ACO rows
 * remain grouped by authenticated website customer ID and retailer.
 * Cross-bank duplicate discovery is read-only; it does not merge profile data.
 */
const crypto=require('node:crypto');
const Completion=require('./profile-completion-core');
const JigCore=require('./app');
const JigAssignments=require('./jig-bank-assignment');
const fsDefault=require('node:fs/promises');
const path=require('node:path');
const RETAILERS=Object.freeze(['target','walmart','pokemoncenter','costco','sams']);
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const name=s=>String(s??'').trim().slice(0,200);
function memberId(input){const s=name(input);if(!/^[a-z0-9_-]{1,150}$/i.test(s))throw Error('Choose a valid membership customer.');return s;}
function retailerId(input){const s=name(input).toLowerCase();const id={pkc:'pokemoncenter',pokemon_center:'pokemoncenter',"sam's":'sams',sam:'sams'}[s]||s;
 if(!RETAILERS.includes(id))throw Error('Select Target, Walmart, Pokémon Center, Costco or Sam’s.');return id;}
function emailFrom(row){
 if(!row||typeof row!=='object'||Array.isArray(row))return '';
 const candidates=[row.loginEmail,row.login_email,row.email,row.login,row.username,row.accountEmail,row.account_email,row.emailAddress,row.retailerEmail,row.profile_email,row?.account?.email,row?.retailer?.username];
 return candidates.map(v=>name(v).toLowerCase()).find(s=>EMAIL.test(s))||'';
}
function normalizeEmail(value){const v=name(value).toLowerCase();return EMAIL.test(v)?v:'';}
// Security Code is an independently named profile reference, not a payment verifier.
// Only explicit payment-verification fields are stripped. Keep unrelated profile
// security_code, custom_security_code and profileSecurityCode on both sides.
const redactKeys=new Set(['cvv','cvc','cid','cc_cvv','cvc2','cvv2','verificationcode','cardverificationvalue','cardverificationcode']);
function stripVerifiers(input,depth=0,scope='redacted'){if(depth>8)throw Error('Profile nesting limit exceeded.');if(Array.isArray(input))return input.map(x=>stripVerifiers(x,depth+1,scope));if(input&&typeof input==='object'){
  const out={};for(const [key,value] of Object.entries(input)){
   if(redactKeys.has(key.toLowerCase())){out[key]='';continue;}
   if(key==='__proto__'||key==='constructor'||key==='prototype')continue;
   out[key]=stripVerifiers(value,depth+1,scope);
  }
   // Legacy imports sometimes used a field labeled CVV for an independent
   // profile-specific security reference. Preserve that supplied value in a
   // separate profile field before retiring legacy verifier column names.
   // Never overwrite an existing nonempty independent Security Code.
   if(depth===0&&!String(out.profileSecurityCode||out.security_code||out.custom_security_code||out.card?.custom_security_code||'').trim()){
    const legacy=[input.cc_cvv,input.cvv,input.cvc,input.card?.cvv,input.card?.cvc,input.card?.cid,input.card?.cvv2]
      .find(value=>typeof value==='string'&&value.length&&value.length<=100);
    if(legacy!==undefined)out.profileSecurityCode=legacy;
   }
   return out;
 }return typeof input==='string'?input.slice(0,5000):input;
}
function makeProfileVault({baseDir,safeStorage,fs=fsDefault,uuid=crypto.randomUUID,now=()=>new Date().toISOString()}={}){
 if(!baseDir||!safeStorage)throw Error('OS-encrypted profile vault required.');
 const paths={personal:path.join(baseDir,'personal-retailer-profiles.encrypted'),aco:path.join(baseDir,'aco-customer-retailer-profiles.encrypted')};
 let pending=Promise.resolve();
 const codeRecoveryPreviews=new Map();
 const requireCrypto=()=>{if(!safeStorage.isEncryptionAvailable())throw Error('OS keychain encryption is unavailable. Profile vault was not written.');};
 async function read(scope){requireCrypto();try{const body=JSON.parse(safeStorage.decryptString(await fs.readFile(paths[scope])));
  if(body?.version!==1||!body?.groups||typeof body.groups!=='object')throw Error('Unrecognized encrypted profile file.');for(const [key,rows] of Object.entries(body.groups))for(const row of rows)Completion.synchronize(row,body.audit?.[key]||[],now);return body;
 }catch(e){if(e.code==='ENOENT'){if((await backupList(scope)).length)throw Error('Encrypted '+scope+' profile bank is missing, but recovery snapshots exist. Restore a snapshot before modifying saved information.');return {version:1,groups:{},audit:{}};}throw Error('Unable to open encrypted '+scope+' profile bank; data was preserved.');}}

 const snapshotsDir=path.join(baseDir,'encrypted-owner-profile-snapshots');
 const scopeValue=scope=>{if(scope!=='personal'&&scope!=='aco')throw Error('Unknown owner profile backup scope.');return scope;};
 async function backupList(scope){
   scopeValue(scope);requireCrypto();let names;
   try{names=await fs.readdir(snapshotsDir);}
   catch(e){if(e.code==='ENOENT')return [];throw e;}
   const pattern=new RegExp('^'+scope+'-[0-9TZ-]{16,32}-[a-f0-9]{16}\\.encrypted$');
   const rows=await Promise.all(names.filter(name=>pattern.test(name)).map(async name=>{
     const st=await fs.stat(path.join(snapshotsDir,name));
     return {name,scope,createdAt:st.mtime.toISOString(),mtimeMs:st.mtimeMs,bytes:st.size};
   }));
   return rows.sort((a,b)=>b.mtimeMs-a.mtimeMs);
 }
 async function backupPrevious(scope){
   scopeValue(scope);let original;
   try{original=await fs.readFile(paths[scope]);}
   catch(e){if(e.code==='ENOENT')return;throw e;}
   await fs.mkdir(snapshotsDir,{recursive:true,mode:0o700});
   const iso=now().replace(/[:.]/g,'-');
   const name=scope+'-'+iso+'-'+crypto.randomBytes(8).toString('hex')+'.encrypted';
   await fs.writeFile(path.join(snapshotsDir,name),original,{mode:0o600,flag:'wx'});
   const list=await backupList(scope);
   for(const expired of list.slice(120))
     await fs.rm(path.join(snapshotsDir,expired.name),{force:true}).catch(()=>{});
 }
 // Every Personal-vault save reconciles all non-PKC retailer identities into
 // unused PKC emails; it never uses a customer record as an email source.
 async function seedPersonalPkc(d,other){
  const key='owner',rows=d.groups?.[key]||[],emails=d.emailBanks?.[key]||[];
  const candidates=new Set([...rows.filter(x=>x.retailer!=='pokemoncenter').map(x=>normalizeEmail(x.email)),
    ...emails.filter(x=>x.retailer!=='pokemoncenter').map(x=>normalizeEmail(x.email))].filter(Boolean));
  const used=new Set(rows.filter(x=>x.retailer==='pokemoncenter').map(x=>normalizeEmail(x.email)).filter(Boolean));
  const reserved=new Set(emails.filter(x=>x.retailer==='pokemoncenter').map(x=>normalizeEmail(x.email)).filter(Boolean));
  d.emailBanks||={};d.emailBanks[key]||=[];
  let added=0;
  for(const email of candidates){
   if(used.has(email)||reserved.has(email))continue;
   if(d.emailBanks[key].length>=20000)throw Error('Personal PKC email bank capacity reached; original data was not overwritten.');
   d.emailBanks[key].push({id:uuid(),email,retailer:'pokemoncenter',createdAt:now(),profileId:null,source:'personal-retailer-auto-pkc'});
   reserved.add(email);added++;
  }
  if(added)bankAuditRecord(d,key,'auto-personal-pkc-email-reconciliation',{added,candidates:candidates.size});
  return {added,candidates:candidates.size,alreadyUsed:[...candidates].filter(x=>used.has(x)).length};
 }
 async function write(scope,data,{allowedReferenceEdits=new Set(),allowVerifiedSnapshotRestore=false}={}){
   scopeValue(scope);
   if(scope==='personal'){
    // Reconcile automatically when new non-PKC Personal profile/email identities
    // arrive. A deliberate bank-entry removal alone is not re-created by that
    // same transaction; the next PKC inventory scan still repairs legacy gaps.
    const candidates=body=>new Set([
     ...(body.groups?.owner||[]).filter(x=>x.retailer!=='pokemoncenter').map(x=>normalizeEmail(x.email)),
     ...(body.emailBanks?.owner||[]).filter(x=>x.retailer!=='pokemoncenter').map(x=>normalizeEmail(x.email))
    ].filter(Boolean));
    const previous=candidates(await read('personal')),current=candidates(data);
    if([...current].some(email=>!previous.has(email)))
     await seedPersonalPkc(data);
   }
   if(!data||data.version!==1||!data.groups||typeof data.groups!=='object')
     throw Error('Refusing to overwrite profile data with an invalid vault.');
   for(const rows of Object.values(data.groups))for(const row of rows)row.data=stripVerifiers(row.data,0,scope);
   // Fail closed if any existing profile would silently lose or change its
   // independent, non-payment profile reference during a routine save.
   // The guard compares the same immutable profile ID within the same owner
   // bank. It never reads CVV/CVC fields and never logs code values.
   // An authenticated manual code edit or explicitly confirmed full snapshot
   // restore can authorize a reference change; ordinary imports/jigs cannot.
   const previous=await read(scope);
   if(!allowVerifiedSnapshotRestore){
    for(const [ownerKey,previousRows] of Object.entries(previous.groups||{})){
     const updated=new Map((data.groups[ownerKey]||[]).filter(row=>row?.id).map(row=>[row.id,row]));
     for(const oldRow of previousRows){
      const next=updated.get(oldRow.id);
      if(!next)continue; // Explicit deletions are handled by their own commands.
      const oldReference=independentCode(oldRow.data);
      if(!oldReference)continue;
      if(independentCode(next.data)!==oldReference&&
         !allowedReferenceEdits.has(ownerKey+'|'+oldRow.id))
       throw Error('An existing independent profile reference would be replaced or cleared without an explicit code edit. No information was saved.');
     }
    }
   }
   for(const [key,rows] of Object.entries(data.groups))for(const row of rows)Completion.synchronize(row,data.audit?.[key]||[],now);
   requireCrypto();await fs.mkdir(baseDir,{recursive:true,mode:0o700});
   const tmp=paths[scope]+'.'+uuid()+'.tmp';
   try{
     await backupPrevious(scope);
     await fs.writeFile(tmp,safeStorage.encryptString(JSON.stringify(data)),{mode:0o600,flag:'wx'});
     await fs.rename(tmp,paths[scope]);
   }catch(e){await fs.rm(tmp,{force:true}).catch(()=>{});throw e;}
 }
 async function backupRestore(scope,name){
   scopeValue(scope);requireCrypto();
   return serial(async()=>{
     if(typeof name!=='string'||!(await backupList(scope)).some(item=>item.name===name))
       throw Error('Choose an existing encrypted owner profile recovery snapshot.');
     let body;
     try{
       body=JSON.parse(safeStorage.decryptString(await fs.readFile(path.join(snapshotsDir,name))));
       if(body?.version!==1||!body?.groups||typeof body.groups!=='object')throw Error('Invalid saved snapshot.');
     }catch{throw Error('Encrypted owner profile backup cannot be decrypted on this device. Current vault preserved.');}
     await write(scope,body,{allowVerifiedSnapshotRestore:true});
     return {restored:true,scope,groups:Object.keys(body.groups).length};
   });
 }

 // Explicit user-reviewed recovery: read existing encrypted snapshots without
 // overwriting any current nonempty code or altering unrelated vault records.
 function independentCode(data,allowLegacy=false){
  if(!data||typeof data!=='object')return '';
  const values=[data.profileSecurityCode,data.security_code,data.custom_security_code,data.card?.custom_security_code,
   ...(allowLegacy?[data.cc_cvv,data.cvv,data.cvc,data.card?.cvv,data.card?.cvc,data.card?.cid,data.card?.cvv2]:[])];
  return values.find(v=>typeof v==='string'&&v.length>0&&v.length<=100)||'';
 }
 async function codeRecovery(scope,customerId,{confirmed=false,token=null,independentOnly=false}={},beforeWrite=null){
  const key=bank(scope,customerId);scopeValue(scope);
  if(typeof beforeWrite!=='function')throw Error('Unlocked vault authorization is required for code recovery.');
  return serial(async()=>{
   const current=await read(scope),rows=current.groups?.[key]||[];
   const eligible=new Map(rows.filter(row=>row?.id&&!independentCode(row.data)).map(row=>[row.id,row]));
   const found=new Map(),snapshots=await backupList(scope);
   let readable=0,skipped=0;
   for(const entry of snapshots){
    if(found.size===eligible.size)break;
    let previous;
    try{
     previous=JSON.parse(safeStorage.decryptString(await fs.readFile(path.join(snapshotsDir,entry.name))));
     if(previous?.version!==1||!previous.groups||!Array.isArray(previous.groups[key])){skipped++;continue;}
    }catch{skipped++;continue;}
    readable++;
    const older=previous.groups[key];
    const byId=new Map(older.filter(row=>row?.id).map(row=>[row.id,row]));
    const byEmail=new Map();
    for(const row of older){
     if(!row?.retailer||!normalizeEmail(row.email))continue;
     const identity=row.retailer+'|'+normalizeEmail(row.email);
     if(byEmail.has(identity))byEmail.set(identity,null);
     else byEmail.set(identity,row);
    }
    for(const row of eligible.values()){
     if(found.has(row.id))continue;
     const identity=row.retailer+'|'+normalizeEmail(row.email);
     const olderRow=byId.get(row.id)||byEmail.get(identity);
     if(!olderRow||olderRow.retailer!==row.retailer||normalizeEmail(olderRow.email)!==normalizeEmail(row.email))continue;
     // If a record was recreated under the same email, do not carry a code
     // across a changed card number.
     // Never assign a historical reference on an email match alone.
     // Both complete card numbers must be present and identical digit for digit.
     if(!require('./profile-library-core').exactFullCardMatch(olderRow.data,row.data))continue;
     const code=independentCode(olderRow.data,!independentOnly);
     if(code)found.set(row.id,{code,revision:row.revision||0,email:row.email,retailer:row.retailer});
    }
   }
   const counts={};
   for(const [id,item]of found){counts[item.retailer]=(counts[item.retailer]||0)+1;}
   if(!confirmed){
    const recoveryToken=uuid();
    codeRecoveryPreviews.set(recoveryToken,{scope,key,at:Date.now(),found});
    if(codeRecoveryPreviews.size>20)codeRecoveryPreviews.delete(codeRecoveryPreviews.keys().next().value);
    return {preview:true,token:recoveryToken,recoverable:found.size,stillMissing:eligible.size-found.size,scannedBackups:readable,unreadableBackups:skipped,byRetailer:counts};
   }
   const preview=codeRecoveryPreviews.get(String(token||''));codeRecoveryPreviews.delete(String(token||''));
   if(!preview||preview.scope!==scope||preview.key!==key||Date.now()-preview.at>10*60_000)throw Error('Recovery preview expired. Review again.');
   if(preview.found.size!==found.size||[...preview.found].some(([id,item])=>found.get(id)?.code!==item.code))
    throw Error('Available recovery data changed. Review again.');
   for(const [id,item]of found){
    const row=rows.find(r=>r.id===id);
    if(!row||row.retailer!==item.retailer||row.email!==item.email||(row.revision||0)!==item.revision||independentCode(row.data))
     throw Error('A profile changed since recovery preview; nothing was restored.');
   }
   beforeWrite();
   if(found.size){
    for(const [id,item]of found){
     const row=rows.find(r=>r.id===id);
     row.data.profileSecurityCode=item.code;
     row.revision=(row.revision||0)+1;
     auditRecord(current,key,'security-code-snapshot-recovery',row.email,{retailer:row.retailer});
    }
    await write(scope,current); // backs up current encrypted vault before modifying
   }
   return {restored:found.size,stillMissing:eligible.size-found.size,scannedBackups:readable,byRetailer:counts};
  });
 }
 // Read-only inventory of historical encrypted profile vault COPIES left in the
 // existing app data directory. Standard snapshots are reviewed separately.
 // Never send plaintext references, card numbers, or customer records to UI.
 async function historicSourceReview(scope,customerId,beforeCheck=()=>{}){
  const key=bank(scope,customerId);scopeValue(scope);requireCrypto();
  return serial(async()=>{
   beforeCheck();
   const current=await read(scope),missing=(current.groups[key]||[]).filter(row=>row?.id&&!independentCode(row.data));
   const byId=new Map(missing.map(row=>[row.id,row])),byIdentity=new Map();
   for(const row of missing){
    const identity=row.retailer+'|'+normalizeEmail(row.email);
    if(byIdentity.has(identity))byIdentity.set(identity,null);
    else byIdentity.set(identity,row);
   }
   const dirs=new Set(['backup','backups','history','historical','old','legacy','archive','archives','recovery']);
   const candidates=[],seen=new Set(),stats={found:0,readable:0,unreadable:0,oversized:0,skipped:0,matched:0,conflicting:0,oldest:null,newest:null,cardHistoryFiles:0};
   // The scan cannot see Time Machine or arbitrary folders without user-granted
   // filesystem access. Do not follow symbolic links or traverse other vaults.
   async function visit(dir,depth){
    if(seen.size>2500)return;
    let entries;
    try{entries=await fs.readdir(dir,{withFileTypes:true});}
    catch(e){if(e.code!=='ENOENT')stats.skipped++;return;}
    for(const item of entries){
     if(seen.size>=2500)break;
     if(item.isSymbolicLink())continue;
     if(item.isDirectory()){
      if(depth<2&&dirs.has(item.name.toLowerCase()))await visit(path.join(dir,item.name),depth+1);
      continue;
     }
     if(!item.isFile())continue;
     const filename=item.name.toLowerCase();
     if((scope==='personal'&&filename.includes('aco-customer'))||
        (scope==='aco'&&filename.includes('personal-retailer')))continue;
     if(/card/.test(filename)&&((depth>0&&/\.encrypted$/.test(filename))||/\.(?:bak|backup|old|prev|copy)(?:$|\.)/.test(filename))){
      stats.cardHistoryFiles++;continue;
     }
     const labelled=filename.includes(scope)&&(/(?:profile|retailer)/.test(filename)||/^(personal|aco)-[0-9tz-]{16,32}-[a-f0-9]{16}\.encrypted$/.test(filename));
     if(!labelled||!/(?:\.encrypted|\.bak|\.backup|\.old|\.prev|\.copy)(?:$|\.)/.test(filename))continue;
     const full=path.join(dir,item.name);
     if(full===paths[scope]||seen.has(full))continue;
     seen.add(full);candidates.push(full);
    }
   }
   await visit(baseDir,0);
   stats.found=candidates.length;
   const matched=new Map(),conflicted=new Set();
   for(const filename of candidates){
    let encrypted,previous,st;
    try{
     st=await fs.stat(filename);
     if(!st.isFile()||st.size>50*1024*1024){stats.oversized++;continue;}
     encrypted=await fs.readFile(filename);
     previous=JSON.parse(safeStorage.decryptString(encrypted));
     if(previous?.version!==1||!Array.isArray(previous.groups?.[key])){stats.unreadable++;continue;}
    }catch{stats.unreadable++;continue;}
    stats.readable++;
    const iso=st.mtime.toISOString();
    if(!stats.oldest||iso<stats.oldest)stats.oldest=iso;
    if(!stats.newest||iso>stats.newest)stats.newest=iso;
    for(const older of previous.groups[key]){
     if(!older?.data||!older?.retailer)continue;
     let row=byId.get(older.id);
     const identity=older.retailer+'|'+normalizeEmail(older.email);
     if(!row)row=byIdentity.get(identity);
     if(!row||row.retailer!==older.retailer||normalizeEmail(row.email)!==normalizeEmail(older.email))continue;
     const currentCard=String(row.data?.cc_number||row.data?.card?.number||'').replace(/\D/g,'');
     const olderCard=String(older.data?.cc_number||older.data?.card?.number||'').replace(/\D/g,'');
     if(!/^\d{12,19}$/.test(currentCard)||!/^\d{12,19}$/.test(olderCard)||currentCard!==olderCard)continue;
     const reference=independentCode(older.data,false);
     if(!reference||reference.length>100||/[\x00-\x1f\x7f]/.test(reference))continue;
     if(conflicted.has(row.id))continue;
     if(matched.has(row.id)&&matched.get(row.id)!==reference){matched.delete(row.id);conflicted.add(row.id);}
     else matched.set(row.id,reference);
    }
   }
   stats.matched=matched.size;stats.conflicting=conflicted.size;
   beforeCheck();
   return stats;
  });
 }
 function serial(action){const task=pending.catch(()=>{}).then(action);pending=task.then(()=>{},()=>{});return task;}
 const bank=(scope,id)=>{if(scope==='personal'){if(id)throw Error('Personal profiles cannot belong to ACO customers.');return 'owner';}if(scope!=='aco')throw Error('Unknown Personal/ACO profile bank.');return memberId(id);};
 const brief=p=>{const completion=Completion.synchronize(p,[],now);return {stage:p.stage,missing:completion.missing,completedAt:p.completedAt||null,bank:p.bank||'working',id:p.id,email:p.email,retailer:p.retailer,label:p.label,status:p.status,source:p.source,createdAt:p.createdAt,revision:Number.isSafeInteger(p.revision)?p.revision:0};};
 function auditRecord(data,key,action,profileEmail,detail={}){
  data.audit||={};const list=data.audit[key]||[];
  list.push({id:uuid(),at:now(),action,email:profileEmail,...detail});
  data.audit[key]=list.slice(-3000);
 }
 // Inventory maintenance is a bank-level event, never a profile-level event.
 // Do not put a blank email into Personal profile audit entries. Older tests
 // (and consumers) expect every profile audit entry to belong to a real email.
 function bankAuditRecord(data,key,action,detail={}){
  data.bankAudit||={};const entries=data.bankAudit[key]||[];
  entries.push({id:uuid(),at:now(),action,...detail});
  data.bankAudit[key]=entries.slice(-1000);
 }
 async function audit(scope,customerId){await pending;const key=bank(scope,customerId),data=await read(scope);
  return {scope,customerId:scope==='aco'?key:null,entries:[...(data.audit?.[key]||[])].reverse().slice(0,100)};
 }
 async function list(scope,customerId){await pending;const key=bank(scope,customerId),data=await read(scope);const rows=data.groups[key]||[];return {scope,customerId:scope==='aco'?key:null,profiles:rows.map(brief),counts:Object.fromEntries(RETAILERS.map(r=>[r,rows.filter(p=>p.retailer===r).length]))};}
 async function preview(scope,customerId,profileId){await pending;const key=bank(scope,customerId),data=await read(scope);const row=(data.groups[key]||[]).find(r=>r.id===profileId);if(!row)throw Error('Profile not found in the selected bank.');return {scope,customerId:scope==='aco'?key:null,profile:structuredClone(row)};}
 async function importRows({scope,customerId,retailer,rows,source='local',status='active',personalImportGuard=false,beforeWrite=null}={}){
  if(personalImportGuard&&(scope!=='personal'||customerId||typeof beforeWrite!=='function'))throw Error('Personal import requires a fixed Personal destination and access guard.');
  const key=bank(scope,customerId),r=retailerId(retailer);
  if(!Array.isArray(rows)||rows.length<1||rows.length>500)throw Error('Import between 1 and 500 profiles at once.');
  if(!['active','available','needs-repair'].includes(status))throw Error('Invalid profile state.');
  const mapped=rows.map((item,i)=>{
   const data=stripVerifiers(item,0,scope),email=emailFrom(data);if(!email)throw Error('Profile '+(i+1)+' has no valid account email; complete it before import.');
   if(JSON.stringify(data).length>16000)throw Error('Profile '+(i+1)+' exceeds the encrypted bank record size limit.');
   return {id:uuid(),label:name(data.profile_name||data.profileName||data.name||data.id||email),email,retailer:r,status,source:name(source).slice(0,50),createdAt:now(),revision:0,data};
  });
  return serial(async()=>{
   const d=await read(scope),existing=d.groups[key]||[];if(existing.length+mapped.length>10000)throw Error('Customer profile bank limit reached.');
   // The dedicated Personal importer rechecks BOTH local banks inside the
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
   // A repeated exact email/retailer entry in one bank is not reimported automatically.
   const keys=new Set(existing.map(x=>x.retailer+'|'+x.email));const added=[];const skipped=[];
   for(const item of mapped){const token=item.retailer+'|'+item.email;if(keys.has(token)){skipped.push(item.email);continue;}keys.add(token);existing.push(item);added.push(brief(item));}
   d.groups[key]=existing;for(const item of added)auditRecord(d,key,'import',item.email,{retailer:item.retailer});if(personalImportGuard)beforeWrite();await write(scope,d);return {scope,customerId:scope==='aco'?key:null,added,skipped};
  });
 }
 async function remove(scope,customerId,profileId){const key=bank(scope,customerId);return serial(async()=>{
  const d=await read(scope),rows=d.groups[key]||[],rest=rows.filter(row=>row.id!==profileId);
  if(rest.length===rows.length)throw Error('The profile is no longer in this specific bank.');
  const old=rows.find(row=>row.id===profileId);if(old.source==='website-linked-profile'&&old.sourceLinked===true)throw Error('Unlink the authoritative website account before removing this local mirror.');auditRecord(d,key,'delete',old.email,{retailer:old.retailer});
  d.groups[key]=rest;await write(scope,d);return {deleted:true,scope};
 });}
 async function setStatus(scope,customerId,profileId,status){const key=bank(scope,customerId);if(!['active','available','needs-repair'].includes(status))throw Error('Invalid status.');return serial(async()=>{
  const d=await read(scope),p=(d.groups[key]||[]).find(x=>x.id===profileId);if(!p)throw Error('Profile is not in this bank.');if(p.source==='website-linked-profile'&&p.sourceLinked===true)throw Error('Change the linked account status in the live website pool controls.');p.status=status;p.revision=(p.revision||0)+1;await write(scope,d);return brief(p);
 });}
 async function swapWithAvailable(scope,customerId,duplicateId,replacementId){const key=bank(scope,customerId);return serial(async()=>{
  const d=await read(scope),rows=d.groups[key]||[],old=rows.find(x=>x.id===duplicateId),fresh=rows.find(x=>x.id===replacementId);
  if(!old||!fresh||old.id===fresh.id||old.retailer!==fresh.retailer||fresh.status!=='available')throw Error('Choose an unused replacement from the same retailer and the SAME Personal/customer bank.');
  if([old,fresh].some(x=>x.source==='website-linked-profile'&&x.sourceLinked===true))throw Error('Replace active website accounts through Linked account actions.');
  if(rows.some(x=>x.id!==fresh.id&&x.email===fresh.email))throw Error('Replacement profile email is already in use; choose another unused account.');
  d.groups[key]=rows.filter(x=>x.id!==old.id);fresh.status='active';fresh.revision=(fresh.revision||0)+1;fresh.replacedProfile=old.id;auditRecord(d,key,'same-bank-replace',old.email,{retailer:old.retailer,replacementEmail:fresh.email});await write(scope,d);return {replaced:brief(old),with:brief(fresh)};
 });}

 // Read-only preview and explicit commit share the identical rule computation.
 // Every address is selected by main.js from the already-authorized local bank;
 // renderer-provided addresses are NEVER accepted at the vault boundary.
 function buildAddressJig(baseAddress,ruleIds,usage=0,combine=false){
  if(!Array.isArray(ruleIds)||ruleIds.length<1||ruleIds.length>80||ruleIds.some(x=>typeof x!=='string'))throw Error('Choose one or more jig rules.');
  const valid=new Set(JigCore.RULES.map(x=>x.id));
  if(ruleIds.some(x=>!valid.has(x)))throw Error('Unknown jig variation requested.');
  const input={address1:baseAddress.address1,address2:baseAddress.address2||'',city:baseAddress.city,state:baseAddress.state,zip:baseAddress.zip};
  const variants=[];const seen=new Set();
  function add(value,ids){if(!value||typeof value!=='object'||!value.address1||!value.city||!value.zip)return;
   const fingerprint=JigCore.addressFingerprint(value);if(fingerprint===JigCore.addressFingerprint(input)||seen.has(fingerprint))return;
   seen.add(fingerprint);variants.push({address:{...input,...value},rules:ids});}
  for(const id of ruleIds){const rule=JigCore.RULES.find(x=>x.id===id);try{add(rule.apply(input),[id]);}catch(_){/* nonapplicable rule */}}
  if(combine&&ruleIds.length>1){let chained={...input},ids=[];
   for(const id of ruleIds.slice(0,3)){try{chained=JigCore.RULES.find(x=>x.id===id).apply(chained);}catch(_){chained=null;}if(!chained)break;ids.push(id);add(chained,[...ids]);}
  }
  if(!variants.length)throw Error('The selected formatting rules do not apply to this address. Choose other checkboxes.');
  const chosen=variants[Math.min(Math.max(0,usage),1000000)%variants.length];
  return {address:chosen.address,ruleIds:chosen.rules,variants:variants.length};
 }
 async function jigProfile(scope,customerId,profileId,baseAddress,ruleIds,{combine=false,commit=false,usage=0}={}){
  const key=bank(scope,customerId),chosen=buildAddressJig(baseAddress,ruleIds,usage,combine);
  return serial(async()=>{
   const d=await read(scope),profile=(d.groups[key]||[]).find(x=>x.id===profileId);
   if(!profile)throw Error('The profile does not belong to this customer/Personal bank.');
   if(commit&&profile.source==='website-linked-profile'&&profile.sourceLinked===true)throw Error('Use the linked profile jig preview to publish changes to the website.');
   const mapping=JigCore.autoMap([profile.data]);
   const changed=JigAssignments.assign({records:[profile.data],mapping,indices:[0],addresses:[chosen.address],scope,origin:scope,
    customerId:scope==='aco'?key:null,sourceCustomerId:scope==='aco'?key:null},JigCore);
   const before=JigCore.get(profile.data,mapping['shipping.address1']);
   const after=JigCore.get(changed.records[0],mapping['shipping.address1']);
   if(!after||before===after&&chosen.address.address2===JigCore.get(profile.data,mapping['shipping.address2']))throw Error('No shipping address fields would change.');
   if(commit){profile.jiggedAt=now();profile.data=stripVerifiers(require('./profile-library-core').syncCardholderToProfile(changed.records[0]),0,scope);profile.revision=(profile.revision||0)+1;auditRecord(d,key,'address-jig',profile.email,{retailer:profile.retailer,addressId:baseAddress.id,ruleIds:chosen.ruleIds});await write(scope,d);}
   return {profileId:profile.id,email:profile.email,retailer:profile.retailer,original:before,preview:chosen.address,ruleIds:chosen.ruleIds,availableVariants:chosen.variants,saved:commit};
  });
 }


 /** Save one confirmed, previously previewed, local-only distribution atomically.
  * The Electron main process, not the renderer, derives rows from saved addresses.
  * No website records, credentials, cards, or non-address data are modified.
  */
 async function applyShippingPlan(scope,customerId,retailer,planRows){
  const key=bank(scope,customerId),r=retailerId(retailer);
  if(!Array.isArray(planRows)||!planRows.length||planRows.length>500||
     planRows.some(x=>!x||typeof x.profileId!=='string'||!x.profileId||!x.addressId||x.retailer!==r))
   throw Error('Choose actual saved retailer profiles for local application.');
  const ids=planRows.map(x=>x.profileId);
  if(new Set(ids).size!==ids.length)throw Error('A profile may only be updated once in a batch.');
  return serial(async()=>{
   const d=await read(scope),bankRows=d.groups[key]||[],changes=[];
   // Construct every change before saving any. A bad field mapping aborts all.
   for(const change of planRows){
    const profile=bankRows.find(x=>x.id===change.profileId&&x.retailer===r);
    if(!profile)throw Error('A selected profile is no longer in the authorized bank and retailer.');
    if(profile.source==='website-linked-profile'&&profile.sourceLinked===true)throw Error('Publish linked address changes through the live Profiles editor.');
    if((Number.isSafeInteger(profile.revision)?profile.revision:0)!==change.expectedRevision)throw Error('This saved profile changed since preview. Review the batch again; nothing was modified.');
    if(!change.address1||!change.city||!change.state||!change.zip)throw Error('Incomplete shipping address in reviewed plan.');
    const mapping=JigCore.autoMap([profile.data]);
    for(const part of ['address1','city','state','zip'])if(!mapping['shipping.'+part])
     throw Error('This profile has no mapped shipping '+part+' field. All edits were cancelled.');
    if(change.address2&&!mapping['shipping.address2'])throw Error('Profile has no address line 2 field to preserve its real unit. All edits were cancelled.');
    const rewritten=JigAssignments.assign({records:[profile.data],mapping,indices:[0],addresses:[change],scope,origin:scope,
      customerId:scope==='aco'?key:null,sourceCustomerId:scope==='aco'?key:null},JigCore);
    changes.push({profile,data:stripVerifiers(require('./profile-library-core').syncCardholderToProfile(rewritten.records[0]),0,scope),addressId:change.addressId});
   }
   for(const update of changes){
    update.profile.jiggedAt=now();update.profile.data=update.data;update.profile.revision=(update.profile.revision||0)+1;
    auditRecord(d,key,'address-distribution',update.profile.email,{retailer:r,addressId:update.addressId});
   }
   await write(scope,d);
   return {updated:changes.length,scope,customerId:scope==='aco'?key:null,retailer:r};
  });
 }

 // Main-process-only snapshots. Renderer APIs receive only masked data.
 async function fieldSnapshot(scope,customerId){await pending;const key=bank(scope,customerId),d=await read(scope);return structuredClone(d.groups[key]||[]);}
 async function createBlank(scope,customerId,retailer,format,data,beforeWrite){const key=bank(scope,customerId),r=retailerId(retailer);return serial(async()=>{
  const d=await read(scope),rows=d.groups[key]||[],email=emailFrom(data);if(rows.length>=10000)throw Error('Profile vault is full.');
  if(email&&rows.some(x=>x.email===email&&x.retailer===r))throw Error('This account email already has a profile in the same vault and retailer.');
  const row={id:uuid(),label:name(data.profile_name||data.name||'Blank profile'),email,retailer:r,format,status:'draft',source:'owner-created-profile',createdAt:now(),revision:0,assetRefs:{},data:stripVerifiers(data,0,scope)};
  d.groups[key]=[...rows,row];auditRecord(d,key,'create-blank-profile',email,{retailer:r});beforeWrite();await write(scope,d);return {...brief(row),format};
 });}
 async function editBlank(scope,customerId,profileId,revision,fields,beforeWrite){const key=bank(scope,customerId);return serial(async()=>{
  const d=await read(scope),rows=d.groups[key]||[],row=rows.find(x=>x.id===profileId);
  if(!row||row.source!=='owner-created-profile')throw Error('Choose a profile created in this vault to edit its form.');
  if(row.sourceLinked===true)throw Error('Edit linked profiles through the live Profiles editor.');
  if(row.revision!==revision)throw Error('This profile changed. Reopen its form before editing.');
  const next=require('./profile-draft-core').manualEdit(row.data,fields),email=emailFrom(next);
  if(email&&rows.some(x=>x.id!==profileId&&x.email===email&&x.retailer===row.retailer))throw Error('Duplicate email in this vault and retailer.');
  row.data=next;row.email=email;row.label=name(next.profile_name||next.name);row.revision++;
  auditRecord(d,key,'edit-draft-fields',email,{retailer:row.retailer});beforeWrite();await write(scope,d);return brief(row);
 });}
 async function applyFieldBatch(scope,customerId,changes,choices,resources,beforeWrite){const key=bank(scope,customerId);const Fields=require('./jig-field-core');Fields.selection(choices);
  if(!Array.isArray(changes)||!changes.length||changes.length>500||new Set(changes.map(x=>x.profileId)).size!==changes.length||typeof beforeWrite!=='function')throw Error('Invalid selected profile batch.');
  return serial(async()=>{
   const d=await read(scope),rows=d.groups[key]||[];
   if(choices.card&&resources.unusedOnly){for(const c of resources.cards){if(rows.some(x=>x.assetRefs?.cardId===c.id||String(x.data?.cc_number||x.data?.card?.number||'').replace(/[ -]/g,'')===c.number))throw Error('A selected card is no longer unused. Preview again.');}}
   const updates=changes.map(c=>{
    const row=rows.find(x=>x.id===c.profileId&&x.retailer===c.retailer);
    if(!row||(row.revision||0)!==c.expectedRevision||Fields.hash(row.data)!==c.expectedHash)throw Error('A saved profile changed since preview. Nothing was overwritten.');
    if(row.source==='website-linked-profile'&&row.sourceLinked===true)throw Error('Edit linked profiles in the live Profiles editor so changes synchronize.');
    Fields.verify([row.data],[c.data],[new Set(c.allowed)],[0]);
    return {row,data:require('./profile-library-core').syncCardholderToProfile(structuredClone(c.data)),refs:c.assetRefs};
   });
   if(choices.card){
    const CardPolicy=require('./card-pool-policy'),settings=d.librarySettings?.[key]||{};
    const excluded=new Set(updates.map(u=>u.row.id));
    const staged=rows.filter(row=>!excluded.has(row.id));
    for(const update of updates){
     const n=CardPolicy.fromProfile({data:update.data});
     if(n){
      CardPolicy.checkAllocation(staged,update.row.retailer,[n],settings);
      staged.push({id:update.row.id,retailer:update.row.retailer,data:update.data});
     }
    }
   }
   for(const u of updates){if(resources.jigged)u.row.jiggedAt=now();u.row.data=u.data;u.row.revision=(u.row.revision||0)+1;u.row.assetRefs||={};
    if(choices.address)u.row.assetRefs.addressId=u.refs.addressId;
    if(choices.card)u.row.assetRefs.cardId=u.refs.cardId;
    if(choices.name)u.row.label=name(u.data.profile_name||u.data.name||u.row.label);
    auditRecord(d,key,'selected-fields',u.row.email,{retailer:u.row.retailer,fields:Object.keys(choices).filter(k=>choices[k])});
   }
   beforeWrite();await write(scope,d);return {updated:updates.length,scope,customerId:scope==='aco'?key:null};
  });
 }


 // Email banks live in the same encrypted transaction as profiles. Consuming an
 // email and saving its profile is one atomic write, including concurrent jobs.
 const emailRows=(d,key)=>d.emailBanks?.[key]||[];
 async function usedEmails(scope,customerId,retailer){
  const key=bank(scope,customerId),d=await read(scope);
  return new Set([...(d.groups[key]||[]),...(d.emailBanks?.[key]||[])]
    .filter(x=>x.retailer===retailer).map(x=>normalizeEmail(x.email)).filter(Boolean));
 }
 // An available retailer row is an account, not a second email to import.
 function freeAccounts(rows,retailer){return rows.filter(x=>x.retailer===retailer&&x.status==='available'&&x.bank!=='live'&&!x.sourceLinked&&!x.websiteAuthoritative);}
 function creationInventory(rows,allProfiles,emails,retailer){
  const free=freeAccounts(rows,retailer),freeIds=new Set(free.map(x=>x.id));
  const used=new Set(allProfiles.filter(x=>x.retailer===retailer&&!freeIds.has(x.id)).map(x=>normalizeEmail(x.email)));
  const seen=new Set(used),accounts=[];
  for(const row of free){const email=normalizeEmail(row.email);if(email&&!seen.has(email)){seen.add(email);accounts.push({email,account:row});}}
  for(const entry of emails){if(entry.retailer===retailer&&!entry.profileId&&!seen.has(entry.email)){seen.add(entry.email);accounts.push({email:entry.email,entry});}}
  return {accounts,used};
 }

 // Repair historical Target Live imports without changing the Target records.
 // An existing PKC profile or reserved PKC bank email already accounts for that
 // email: only genuinely missing PKC email-bank entries are created.
 function backfillTargetLivePkc(d,other,key){
  const rows=d.groups[key]||[],targets=rows.filter(x=>x.retailer==='target'&&x.bank==='live');
  const sourceEmails=[...new Set((key==='owner'?
   [...rows.filter(x=>x.retailer!=='pokemoncenter'),...(d.emailBanks?.[key]||[]).filter(x=>x.retailer!=='pokemoncenter')]
   :targets).map(x=>normalizeEmail(x.email)).filter(Boolean))];
  d.emailBanks||={};d.emailBanks[key]||=[];
  const pkcProfiles=new Set((d.groups[key]||[]).filter(x=>x.retailer==='pokemoncenter').map(x=>normalizeEmail(x.email)).filter(Boolean));
  const bankEmails=new Set((d.emailBanks[key]||[]).filter(x=>x.retailer==='pokemoncenter').map(x=>normalizeEmail(x.email)).filter(Boolean));
  let added=0;
  for(const email of sourceEmails){
   if(pkcProfiles.has(email)||bankEmails.has(email))continue;
   d.emailBanks[key].push({id:uuid(),email,retailer:'pokemoncenter',createdAt:now(),profileId:null,source:'target-live-reconciliation'});
   bankEmails.add(email);added++;
  }
  const covered=sourceEmails.filter(email=>pkcProfiles.has(email)||bankEmails.has(email)).length;
  return {targetLiveProfiles:targets.length,targetUniqueEmails:sourceEmails.length,
   targetDuplicateEmails:targets.length-sourceEmails.length,
   alreadyPkcProfiles:sourceEmails.filter(email=>pkcProfiles.has(email)).length,
   pkcCoverage:covered,unmatchedTargetEmails:sourceEmails.length-covered,added,
   personalAllRetailers:key==='owner',personalEligibleEmails:key==='owner'?sourceEmails.length:0};
 }
 async function reconcileTargetLivePkcEmails(scope,customerId,beforeWrite){
  const key=bank(scope,customerId);
  return serial(async()=>{
   const d=await read(scope);
   const report=backfillTargetLivePkc(d,null,key);
   if(report.added){
    bankAuditRecord(d,key,'reconcile-target-live-pkc',{added:report.added,sourceProfiles:report.targetLiveProfiles});
    if(beforeWrite)beforeWrite();
    await write(scope,d);
   }
   return {scope,customerId:scope==='aco'?key:null,...report};
  });
 }
 async function emailInventory(scope,customerId,retailer){const r=retailerId(retailer);const reconciled=r==='pokemoncenter'?await reconcileTargetLivePkcEmails(scope,customerId):null;await pending;const key=bank(scope,customerId),d=await read(scope);
  const rows=d.groups[key]||[],allProfiles=rows;
  const inventory=creationInventory(rows,allProfiles,emailRows(d,key),r);
  const retailerProfiles=rows.filter(x=>x.retailer===r);
   const reserved=(emailRows(d,key)||[]).filter(x=>x.retailer===r);
   const live=retailerProfiles.filter(x=>x.bank==='live').length;
   const linkedAccountIds=new Set(retailerProfiles.map(x=>x.id));
   const staleReservations=reserved.filter(x=>x.profileId&&!linkedAccountIds.has(x.profileId)).length;
   const retailerStats={profileCount:retailerProfiles.length,liveProfileCount:live,workingProfileCount:retailerProfiles.length-live,
    readyForExportCount:retailerProfiles.filter(x=>x.bank!=='live'&&x.stage==='completed').length,
    unusedAccountCount:inventory.accounts.length,unusedEmailCount:inventory.accounts.filter(x=>x.entry).length,
    unusedExistingAccountCount:inventory.accounts.filter(x=>x.account).length,staleReservationCount:staleReservations};
   return {scope,customerId:scope==='aco'?key:null,retailer:r,retailerStats,freeAccounts:inventory.accounts.filter(x=>x.account).length,availableForCreation:inventory.accounts.length,...(reconciled?{targetLiveReconciliation:{...reconciled,pkcUnusedTotal:inventory.accounts.length,pkcProfileCount:retailerProfiles.length,pkcLiveProfileCount:live,pkcStaleReservationCount:staleReservations}}:{}),emails:inventory.accounts.map(x=>({id:x.account?.id||x.entry.id,email:x.email,status:'available',source:x.account?'account':'email'})).concat(emailRows(d,key).filter(x=>x.retailer===r&&!inventory.accounts.some(a=>a.email===x.email)).map(x=>({id:x.id,email:x.email,status:'used'})))};
 }
 async function importEmails(scope,customerId,retailer,values,beforeWrite){const key=bank(scope,customerId),r=retailerId(retailer);
  if(!Array.isArray(values)||!values.length||values.length>5000||typeof beforeWrite!=='function')throw Error('Import 1-5000 emails.');
  const normalized=values.map(v=>typeof v==='string'&&v.length<=200?normalizeEmail(v):'');
  return serial(async()=>{const d=await read(scope),used=await usedEmails(scope,customerId,r),rows=emailRows(d,key),added=[];let invalid=0,skipped=0;
   for(const email of normalized){if(!email){invalid++;continue;}if(used.has(email)){skipped++;continue;}used.add(email);const row={id:uuid(),email,retailer:r,createdAt:now(),profileId:null};rows.push(row);added.push({id:row.id,email});}
   if(rows.length>20000)throw Error('Email vault limit reached.');d.emailBanks||={};d.emailBanks[key]=rows;
   auditRecord(d,key,'import-email-bank','',{retailer:r,added:added.length,skipped,invalid});beforeWrite();await write(scope,d);
   return {scope,customerId:scope==='aco'?key:null,retailer:r,added:added.length,skipped,invalid};
  });
 }
 async function createEmailProfiles(scope,customerId,retailer,count,build,beforeWrite,selectedEmailIds=null){const key=bank(scope,customerId),r=retailerId(retailer);
  if(!Number.isInteger(count)||count<1||count>500||typeof build!=='function'||typeof beforeWrite!=='function')throw Error('Create 1-500 profiles.');
  return serial(async()=>{const d=await read(scope),rows=d.groups[key]||[];
   const allProfiles=rows;
   const available=creationInventory(rows,allProfiles,emailRows(d,key),r).accounts;
   if(available.length<count)throw Error('Not enough unused emails or free accounts in this vault and retailer.');
   let chosen;
   if(selectedEmailIds!==null){
    if(!Array.isArray(selectedEmailIds)||selectedEmailIds.length!==count||new Set(selectedEmailIds).size!==count)
     throw Error('Select exactly the requested count of distinct unused account IDs.');
    const availableById=new Map(available.map(x=>[x.account?.id||x.entry?.id,x]));
    chosen=selectedEmailIds.map(id=>{
     if(typeof id!=='string'||!availableById.has(id))
      throw Error('A selected account is no longer unused in this retailer and exact owner vault. Refresh before jigging.');
     return availableById.get(id);
    });
   }else chosen=available.slice(0,count);
   const newCount=chosen.filter(x=>!x.account).length;
   if(rows.length+newCount>10000)throw Error('Profile vault is full.');
   const built=await build(chosen.map(x=>x.email),structuredClone(rows),chosen.map(x=>x.account?structuredClone(x.account):null),structuredClone(d.librarySettings?.[key]||{}));
   if(!Array.isArray(built)||built.length!==count)throw Error('Profile generation failed. Nothing was saved.');
   const added=built.map((item,i)=>{if(emailFrom(item.data)!==chosen[i].email)throw Error('Email assignment mismatch.');const prior=chosen[i].account;return {...prior,id:prior?.id||uuid(),email:chosen[i].email,label:name(item.data.profile_name||item.data.name),retailer:r,format:item.format,status:'draft',source:'owner-created-profile',createdAt:prior?.createdAt||now(),revision:(prior?.revision??-1)+1,assetRefs:{...item.assetRefs,...(chosen[i].entry?{emailId:chosen[i].entry.id}:{})},data:stripVerifiers(item.data,0,scope)};});
   for(let i=0;i<added.length;i++){const entry=chosen[i].entry;if(entry){entry.profileId=added[i].id;entry.usedAt=now();}for(const e of emailRows(d,key))if(e.retailer===r&&e.email===added[i].email){e.profileId=added[i].id;e.usedAt=now();}auditRecord(d,key,'create-from-pools',added[i].email,{retailer:r});}
   const consumed=new Set(chosen.filter(x=>x.account).map(x=>x.account.id));
   d.groups[key]=[...rows.filter(x=>!consumed.has(x.id)),...added];beforeWrite();await write(scope,d);return {scope,customerId:scope==='aco'?key:null,retailer:r,created:added.length,profiles:added.map(brief)};
  });
 }

 // Live profiles stay in their owner vault, with durable bank membership independent of readiness.
 async function importLiveProfiles(scope,customerId,entries,{updateExisting=false,batchId=null,fileNames=[]}={},beforeWrite){
  const key=bank(scope,customerId);
  if(!Array.isArray(entries)||!entries.length||entries.length>10000||typeof beforeWrite!=='function')throw Error('Choose 1-10000 live profiles.');
  return serial(async()=>{
   const d=await read(scope),rows=d.groups[key]||[],seen=new Map(),prepared=[];
   for(const item of entries){
    const retailer=retailerId(item.retailer),data=stripVerifiers(item.data,0,scope),email=normalizeEmail(emailFrom(data)),token=retailer+'|'+email;
    if(!email)throw Error('Every live profile needs a valid account email.');
    const occurrence=seen.get(token)||0;seen.set(token,occurrence+1);
    const matches=rows.filter(x=>x.retailer===retailer&&x.email===email);
    // Existing duplicates are retained for review; importing must not erase or block them.
    const prior=updateExisting&&occurrence===0&&matches.length===1?matches[0]:null;
    if(prior&&(prior.sourceLinked||prior.websiteAuthoritative||prior.source==='website-linked-profile'))throw Error('Edit this website-linked account through its customer profile; a live import cannot replace it.');
    // Without explicit replacement, create an independently editable Live record.
    if(prior&&require('./jig-field-core').hash(prior)!==item.expectedHash)throw Error('Stored profile changed after preview. Preview the import again.');
    if(!prior&&item.expectedHash&&updateExisting&&occurrence===0&&matches.length===1)throw Error('Stored profile changed after preview. Preview the import again.');
    prepared.push({...prior,id:prior?.id||uuid(),retailer,email,label:name(data.profile_name||data.name||email),group:retailer,source:'owner-created-profile',status:'active',bank:'live',liveSince:prior?.liveSince||now(),createdAt:prior?.createdAt||now(),revision:(prior?.revision??-1)+1,importBatchId:prior?.importBatchId||(!prior?batchId:null),data,format:item.format,assetRefs:prior?.assetRefs||{}});
   }
   if(rows.length+prepared.filter(x=>!rows.some(r=>r.id===x.id)).length>10000)throw Error('Profile vault is full.');
   const ids=new Set(prepared.map(x=>x.id));d.groups[key]=[...rows.filter(x=>!ids.has(x.id)),...prepared];
   d.emailBanks||={};d.emailBanks[key]||=[];
   const usedPkc=new Set([...rows,...prepared].filter(x=>x.retailer==='pokemoncenter').map(x=>normalizeEmail(x.email)));
   for(const x of d.emailBanks[key]||[])if(x.retailer==='pokemoncenter')usedPkc.add(x.email);
   let pkcEmailsAdded=0;
   for(const row of prepared){
    for(const entry of d.emailBanks[key])if(entry.retailer===row.retailer&&entry.email===row.email){entry.profileId=row.id;entry.usedAt=now();}
    if(row.retailer!=='pokemoncenter'&&!usedPkc.has(row.email)){d.emailBanks[key].push({id:uuid(),email:row.email,retailer:'pokemoncenter',createdAt:now(),profileId:null,source:'live-profile-import'});usedPkc.add(row.email);pkcEmailsAdded++;}
    auditRecord(d,key,'live-profile-import',row.email,{retailer:row.retailer,bank:'live'});
   }
   if(d.emailBanks[key].length>20000)throw Error('Email vault limit reached.');
   if(batchId){
    if(typeof batchId!=='string'||batchId.length>100)throw Error('Invalid import batch ID.');
    d.importBatches||={};d.importBatches[key]||=[];
    const created=prepared.filter(x=>!rows.some(y=>y.id===x.id));
    d.importBatches[key].push({id:batchId,at:now(),bank:'live',retailers:[...new Set(prepared.map(x=>x.retailer))],
     fileNames:fileNames.slice(0,100).map(s=>String(s).slice(0,200)),createdIds:created.map(x=>x.id),
     imported:prepared.length,updatedExisting:prepared.length-created.length,removedAt:null});
   }
   beforeWrite();await write(scope,d);return {imported:prepared.length,pkcEmailsAdded,bank:'live',batchId};
  });
 }
 // History tracks only NEW local profile IDs created by each import; a batch
 // cannot delete any pre-existing profile that was explicitly updated by a live import.
 function importBatchFingerprint(rows,batch){
  const profiles=(batch.createdIds||[]).map(id=>rows.find(x=>x.id===id))
    .filter(x=>x&&x.importBatchId===batch.id);
  return crypto.createHash('sha256').update(profiles.map(x=>x.id+':'+(x.revision||0)).sort().join('|')).digest('hex');
 }
 async function importHistory(scope,customerId){
  await pending;const key=bank(scope,customerId),data=await read(scope),rows=data.groups[key]||[];
  return (data.importBatches?.[key]||[]).map(batch=>{
   const present=(batch.createdIds||[]).filter(id=>rows.some(x=>x.id===id&&x.importBatchId===batch.id));
   const protectedCount=present.filter(id=>rows.some(x=>x.id===id&&x.source==='website-linked-profile'&&x.sourceLinked)).length;
   return {id:batch.id,at:batch.at,bank:batch.bank,retailers:batch.retailers||[],fileNames:batch.fileNames||[],
    imported:batch.imported,updatedExisting:batch.updatedExisting||0,created:(batch.createdIds||[]).length,
    remaining:present.length,protectedCount,removedAt:batch.removedAt||null,
    fingerprint:importBatchFingerprint(rows,batch)};
  }).reverse();
 }
 async function removeImportBatch(scope,customerId,{batchId,fingerprint,confirmed}={},beforeWrite){
  if(confirmed!==true||typeof batchId!=='string'||typeof fingerprint!=='string'||typeof beforeWrite!=='function')throw Error('Review and confirm an exact import batch.');
  const key=bank(scope,customerId);
  return serial(async()=>{
   const d=await read(scope),batch=(d.importBatches?.[key]||[]).find(x=>x.id===batchId);
   if(!batch||batch.removedAt)throw Error('Import history changed. Reload it.');
   const rows=d.groups[key]||[];
   if(importBatchFingerprint(rows,batch)!==fingerprint)throw Error('Profiles changed after import history loaded. Reload and review before removal.');
   const ids=new Set(batch.createdIds||[]);
   const removed=rows.filter(x=>ids.has(x.id)&&x.importBatchId===batchId);
   if(removed.some(x=>x.source==='website-linked-profile'&&x.sourceLinked))throw Error('An imported profile is now linked to the website; unlink it before removing its batch.');
   d.groups[key]=rows.filter(x=>!ids.has(x.id)||x.importBatchId!==batchId);
   for(const item of d.emailBanks?.[key]||[])if(ids.has(item.profileId)){item.profileId=null;item.usedAt=null;}
   batch.removedAt=now();
   auditRecord(d,key,'remove-import-batch','',{batchId,removed:removed.length});
   beforeWrite();await write(scope,d);
   return {deleted:removed.length,updatedExistingPreserved:batch.updatedExisting||0};
  });
 }
 async function bulkManage(scope,customerId,{operation,retailer,fromBank,toBank,profileIds,revisions,confirmed}={},beforeWrite){
  if(confirmed!==true||!['move','delete'].includes(operation)||!RETAILERS.includes(retailer)||
    !['working','live'].includes(fromBank)||!Array.isArray(profileIds)||!profileIds.length||profileIds.length>500||
    new Set(profileIds).size!==profileIds.length||!Array.isArray(revisions)||revisions.length!==profileIds.length||
    typeof beforeWrite!=='function')throw Error('Choose 1-500 profiles in one bank and confirm the bulk action.');
  if(operation==='move'&&(!['working','live'].includes(toBank)||toBank===fromBank))throw Error('Choose a different Working/Live bank.');
  const key=bank(scope,customerId);
  return serial(async()=>{
   const d=await read(scope),rows=d.groups[key]||[];
   const found=profileIds.map((id,i)=>{
    const row=rows.find(x=>x.id===id);
    if(!row||row.retailer!==retailer||(row.bank==='live'?'live':'working')!==fromBank||
      (row.revision||0)!==revisions[i])throw Error('A selected profile changed. Reload before any bulk change.');
    if(row.source==='website-linked-profile'&&row.sourceLinked===true)
      throw Error('Linked website accounts cannot be moved or deleted locally. Use the linked-account controls.');
    return row;
   });
   if(operation==='move')for(const row of found){row.bank=toBank;if(toBank==='live')row.liveSince=row.liveSince||now();row.revision=(row.revision||0)+1;}
   else{
    const ids=new Set(profileIds);
    d.groups[key]=rows.filter(x=>!ids.has(x.id));
    for(const email of d.emailBanks?.[key]||[])if(ids.has(email.profileId)){email.profileId=null;email.usedAt=null;}
   }
   auditRecord(d,key,operation==='move'?'bulk-move-local':'bulk-delete-local','',
    {retailer,fromBank,toBank:operation==='move'?toBank:null,count:found.length});
   beforeWrite();await write(scope,d);
   return {saved:true,count:found.length,operation,bank:toBank||fromBank};
  });
 }

 async function librarySettings(scope,customerId){await pending;const key=bank(scope,customerId),d=await read(scope);return structuredClone(d.librarySettings?.[key]||{});}
 async function libraryTransaction(scope,customerId,action,beforeWrite){
  const key=bank(scope,customerId);
  if(typeof action!=='function'||typeof beforeWrite!=='function')throw Error('Invalid profile transaction.');
  return serial(async()=>{
   const d=await read(scope);
   d.groups[key]||=[];d.emailBanks||={};d.emailBanks[key]||=[];
   d.importBatches||={};d.importBatches[key]||=[];
   const original=JSON.stringify(d),allowedReferenceEdits=new Set();
   const context={
    rows:d.groups[key],emails:d.emailBanks[key],importBatches:d.importBatches[key],
    audit:(action,email,detail)=>auditRecord(d,key,action,email,detail),
    settings:d.librarySettings?.[key]||{},
    allowIndependentReferenceEdit:profileId=>{
     if(!d.groups[key].some(row=>row.id===profileId))
      throw Error('Reference change authorization requires an existing profile in this vault.');
     allowedReferenceEdits.add(key+'|'+profileId);
    }
   };
   const result=await action(context);
   if(context.rows.length>10000)throw Error('Profile vault limit reached.');
   d.groups[key]=context.rows;
   d.librarySettings||={};d.librarySettings[key]=context.settings;
   beforeWrite();
   if(JSON.stringify(d)!==original)await write(scope,d,{allowedReferenceEdits});
   return result;
  });
 }
 async function scanRows(imports=[],webRecords=[],allowPersonalDetail=false){await pending;
  if(!Array.isArray(imports)||imports.length>500)throw Error('Too many imported rows to scan.');
  const [personal,aco]=await Promise.all([read('personal'),read('aco')]);
  // Retailers intentionally use separate email namespaces. Never report
  // Target and Pokemon Center use of one login as the same retailer account.
  const index=new Map(),details=[];
  const include=entry=>{
   const email=normalizeEmail(entry.email);if(!email)return;
   const retailer=retailerId(entry.retailer),key=retailer+'|'+email;
   const arr=index.get(key)||[];arr.push({...entry,retailer,email});index.set(key,arr);
  };
  for(const row of personal.groups.owner||[])include({scope:'personal',owner:'owner',id:row.id,retailer:row.retailer,email:row.email,label:row.label,status:row.status,revision:row.revision||0});
  const linkedMirrors=new Set(),localCounts=new Map();
  for(const [owner,rows] of Object.entries(aco.groups))for(const row of rows){
   const retailer=retailerId(row.retailer),email=normalizeEmail(row.email),key=owner+'|'+retailer+'|'+email;
   include({scope:'aco',owner,id:row.id,retailer,email,label:row.label,status:row.status,revision:row.revision||0});
   if(email)localCounts.set(key,(localCounts.get(key)||0)+1);
   // A locally synchronized website assignment already represents one
   // physical retailer account. Do not count it twice in the web feed.
   if(row.source==='website-linked-profile'&&row.remoteKey)
    linkedMirrors.add(key+'|'+retailer+'|'+(row.remoteManagedId||String(row.remoteKey).split('|').slice(1).join('|')));
  }
  const seenWeb=new Set(),uniqueWeb=[];
  for(const w of webRecords){
   if(!w||!w.email)continue;
   const owner=memberId(w.customerId),retailer=retailerId(w.retailer),email=normalizeEmail(w.email),id=name(w.id);
   if(!email)continue;
   const key=owner+'|'+retailer+'|'+email,identity=key+'|'+id;
   if(seenWeb.has(identity))continue;
   seenWeb.add(identity);uniqueWeb.push({scope:'website',owner,id,retailer,email,label:'Website linked account',status:'linked',key});
  }
  const mirroredCount=new Map(),unmatchedWeb=[];
  for(const entry of uniqueWeb){
   if(entry.id&&linkedMirrors.has(entry.key+'|'+entry.retailer+'|'+entry.id)){
    mirroredCount.set(entry.key,(mirroredCount.get(entry.key)||0)+1);
   }else unmatchedWeb.push(entry);
  }
  // Email equality alone does not prove that two source records are mirrors.
  // Only an explicit remoteKey suppresses the website copy above.
  for(const entry of unmatchedWeb)include(entry);
  for(let i=0;i<imports.length;i++){
   const imp=imports[i],email=normalizeEmail(imp.email||emailFrom(imp.data||imp));if(!email)continue;
   const scope=imp.scope||'personal',owner=scope==='aco'?memberId(imp.customerId):'owner';
   include({scope:'import',owner,importScope:scope,id:'import-'+i,index:i,retailer:retailerId(imp.retailer),email,label:'Import row '+(i+1),status:'pending'});
  }
  for(const group of index.values()){
   if(group.length<2)continue;
   const email=group[0].email,retailer=group[0].retailer,hasPersonal=group.some(x=>x.scope==='personal');
   // When locked, never disclose a Personal profile's email or ID, even
   // indirectly by putting its matching email in a dialog heading.
   const publicItems=group.map(item=>item.scope==='personal'&&!allowPersonalDetail?
    {scope:'personal',owner:'Personal vault - locked',id:null,retailer:item.retailer,status:'private match',label:'Owner Personal vault (locked)',email:null}:
    {...item,email:item.email});
   const identity=crypto.createHash('sha256').update(retailer+'|'+group.map(x=>[x.scope,x.owner,x.id].join(':')).sort().join('|')).digest('hex');
   const signature=crypto.createHash('sha256').update(group.map(x=>[x.scope,x.owner,x.id,x.email,x.status,x.label,x.revision||0].join(':')).sort().join('|')).digest('hex');
   details.push({conflictId:identity,signature,email:hasPersonal&&!allowPersonalDetail?'Email also exists in locked Personal vault':email,retailer,count:group.length,items:publicItems});
  }
  return {scannedAt:now(),duplicates:details.sort((a,b)=>b.count-a.count||a.retailer.localeCompare(b.retailer)),scanned:[...index.values()].reduce((n,items)=>n+items.length,0),personalDetailsVisible:Boolean(allowPersonalDetail)};
 }
 return Object.freeze({paths,backupList,backupRestore,codeRecovery,historicSourceReview,retailers:RETAILERS,importHistory,removeImportBatch,bulkManage,librarySettings,libraryTransaction,importLiveProfiles,reconcileTargetLivePkcEmails,emailInventory,importEmails,createEmailProfiles,list,preview,importRows,remove,setStatus,swapWithAvailable,scanRows,audit,jigProfile,applyShippingPlan,fieldSnapshot,createBlank,editBlank,applyFieldBatch});
}
module.exports={makeProfileVault,normalizeEmail,emailFrom,retailerId,memberId,stripVerifiers};

