'use strict';
const path=require('node:path'),crypto=require('node:crypto'),Core=require('./app'),D=require('./profile-draft-core'),C=require('./profile-library-core'),Completion=require('./profile-completion-core');
function createLibrary({authorize,guard,profiles,cardVault,addressBanks,chooseSave,confirmExport,writeFile=require('node:fs/promises').writeFile,getCustomerProfileSource,saveCustomerProfile,getCustomerSavedData,updateCustomerSavedData,changeCustomerAssignment,now=Date.now,uuid=crypto.randomUUID}={}){
 const plans=new Map(),jigPlans=new Map(),epochs=new Map();
 const supportedRule=id=>id===C.FL_PHONE_RULE||Boolean(C.ruleById(id));
 const nonStackingRules=ids=>{let targetPrimary=false;return ids.filter(id=>{if(C.ruleById(id)?.family!=='target-primary')return true;if(targetPrimary)return false;targetPrimary=true;return true;});};
 const ep=e=>epochs.get(e.sender.id)||0;
 function cancel(e){epochs.set(e.sender.id,ep(e)+1);for(const [id,p] of plans)if(p.sender===e.sender.id)plans.delete(id);for(const [id,p] of jigPlans)if(p.sender===e.sender.id)jigPlans.delete(id);}
 async function access(e,p){require('./jig-field-core').scopeKey(p?.scope,p?.customerId);const epoch=ep(e);const id=await authorize(e,p.scope,p.customerId);if(p.scope==='aco'&&id!==p.customerId)throw Error('Customer vault mismatch.');guard(e,p.scope);if(ep(e)!==epoch)throw Error('Vault closed during authorization.');return {scope:p.scope,id,check:()=>{guard(e,p.scope);if(ep(e)!==epoch)throw Error('Vault closed during this operation.');}};}
 const cardKey=(s,id)=>s==='personal'?'personal:owner':id;
 const profileOwnerLabel=value=>String(value||'Customer').trim().split(/\s+/)[0]||'Customer';
 function view(row){const result=Completion.inspect(row);return {id:row.id,revision:row.revision||0,retailer:row.retailer,bank:row.bank||'working',liveSince:row.liveSince||null,group:row.group||row.retailer,stage:result.ready?'completed':'in-progress',status:row.status||'active',missing:result.missing,label:row.label,email:row.email,data:structuredClone(row.data),source:row.source,sourceLinked:row.source==='website-linked-profile'&&row.sourceLinked===true,localOnly:row.source!=='website-linked-profile'||row.sourceLinked===false,pendingWebsiteData:row.pendingSourceData?structuredClone(row.pendingSourceData):null,remoteManagedId:row.remoteManagedId||null,remoteType:row.remoteType||null,remoteUpdatedAt:row.remoteUpdatedAt||null,needsReview:!!row.needsReview};}
 async function list(e,p){const a=await access(e,p),rows=await profiles.fieldSnapshot(a.scope,a.id);a.check();const counts=new Map();for(const r of rows){for(const [kind,key]of Object.entries({email:C.email(C.values(r.data).email),name:C.nameKey(r.data),card:C.payment(r.data).number})){if(key){const k=r.retailer+'|'+kind+'|'+key;counts.set(k,(counts.get(k)||0)+1);}}}return {scope:a.scope,customerId:a.id,profiles:rows.map(r=>({...view(r),duplicates:Object.entries({email:C.email(C.values(r.data).email),name:C.nameKey(r.data),card:C.payment(r.data).number}).filter(([k,v])=>v&&counts.get(r.retailer+'|'+k+'|'+v)>1).map(([k])=>k)}))};}
 async function detail(e,p){const a=await access(e,p),r=await profiles.preview(a.scope,a.id,p.profileId);a.check();return view(r.profile);}
 function detectedRetailer(value){
  const v=String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
  if(v.includes('pokemoncenter')||v.includes('pkc'))return 'pokemoncenter';
  if(v.includes('target'))return 'target';if(v.includes('walmart'))return 'walmart';
  if(v.includes('costco')||v.includes('cosco'))return 'costco';if(v.includes('sams'))return 'sams';return null;
 }
 async function livePreview(e,p,a,parsed){
  const existing=await profiles.fieldSnapshot(a.scope,a.id),entries=[],occurrences=new Map(),counts={};
  for(const raw of parsed.records){
   const retailer=detectedRetailer(raw.retailerId||raw.retailer||raw.store||raw.site)||detectedRetailer(p.fileName.replace(/\.[^.]+$/,''))||p.retailer;C.retailer(retailer);
   const native=(Object.hasOwn(raw,'cc_number')&&C.format(retailer)==='shikari')||(raw.card&&raw.shipping&&C.format(retailer)==='valor');
   const data=native?structuredClone(raw):C.normalized(raw,retailer),email=C.email(C.values(data).email);
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Every live profile needs a valid account email.');data.email=email;
   if(JSON.stringify(data).length>16000)throw Error('A profile exceeds the supported record size.');
   const key=retailer+'|'+email,occurrence=occurrences.get(key)||0;occurrences.set(key,occurrence+1);
   const matches=existing.filter(x=>x.retailer===retailer&&x.email===email);
   entries.push({retailer,data,format:C.format(retailer),occurrence,expectedHash:matches.length===1?require('./jig-field-core').hash(matches[0]):null,storedMatches:matches.length});counts[retailer]=(counts[retailer]||0)+1;
  }
  const token=uuid();a.check();for(const [id,plan]of plans)if(now()-plan.at>600000)plans.delete(id);if(plans.size>30)throw Error('Close an older import preview first.');
  plans.set(token,{sender:e.sender.id,scope:a.scope,id:a.id,bank:'live',entries,fileNames:p.fileNames||[p.fileName],at:now(),epoch:ep(e)});
  const duplicates=entries.filter(x=>x.storedMatches>0||occurrences.get(x.retailer+'|'+x.data.email)>1);
   return {token,bank:'live',count:entries.length,counts,matches:entries.filter(x=>x.expectedHash&&x.occurrence===0).length,duplicateCount:duplicates.length,duplicateGroups:[...new Set(duplicates.map(x=>x.retailer+'|'+x.data.email))].length,profiles:entries.map(x=>({email:x.data.email,retailer:x.retailer,duplicates:x.storedMatches>0||occurrences.get(x.retailer+'|'+x.data.email)>1?['email']:[]}))};
 }
 async function importPreview(e,p){const a=await access(e,p);C.retailer(p.retailer);
 if(p.bank==='live'&&Array.isArray(p.files)){
  if(!p.files.length||p.files.length>100)throw Error('Select 1-100 profile files.');let bytes=0;const records=[];
  for(const file of p.files){if(typeof file.fileName!=='string'||file.fileName!==path.basename(file.fileName)||file.fileName.length>200||typeof file.text!=='string')throw Error('Choose local profile files.');bytes+=Buffer.byteLength(file.text);if(bytes>26*1024*1024)throw Error('Choose profile files totaling less than 26 MB.');
   const parsed=Core.parseFile(file.fileName,file.text);for(const row of parsed.records||[]){if(row.scope&&row.scope!==a.scope||row.customerId&&row.customerId!==a.id||row.acoCustomerId&&row.acoCustomerId!==a.id)throw Error('Imported profile ownership does not match this vault.');records.push({...row,retailer:row.retailerId||row.retailer||row.store||row.site||detectedRetailer(file.fileName.replace(/\.[^.]+$/,''))||p.retailer});}}
  if(!records.length||records.length>10000)throw Error('Import 1-10000 live profiles.');return livePreview(e,{...p,fileName:'live-profiles.json',fileNames:p.files.map(f=>f.fileName)},a,{records});
 }
 if(typeof p.fileName!=='string'||p.fileName!==path.basename(p.fileName)||p.fileName.length>200||typeof p.text!=='string'||Buffer.byteLength(p.text)>26*1024*1024)throw Error('Choose a local profile file.');const parsed=Core.parseFile(p.fileName,p.text);if(!parsed.records?.length||parsed.records.length>(p.bank==='live'?10000:500))throw Error(p.bank==='live'?'Import 1-10000 live profiles.':'Import 1-500 profiles.');
 for(const row of parsed.records)if(row.scope&&row.scope!==a.scope||row.customerId&&row.customerId!==a.id||row.acoCustomerId&&row.acoCustomerId!==a.id)throw Error('Imported profile ownership does not match this vault.');
 if(p.bank==='live')return livePreview(e,p,a,parsed);
 const data=parsed.records.map(row=>C.normalized(row,p.retailer));if(data.some(x=>JSON.stringify(x).length>16000))throw Error('A profile exceeds the supported record size.');const existing=await profiles.fieldSnapshot(a.scope,a.id),duplicates=C.collisions(data,existing,p.retailer),token=uuid();a.check();for(const [id,plan]of plans)if(now()-plan.at>600000)plans.delete(id);if(plans.size>30)throw Error('Close an older import preview first.');plans.set(token,{sender:e.sender.id,scope:a.scope,id:a.id,retailer:p.retailer,fileName:p.fileName,data,at:now(),epoch:ep(e)});return {token,count:data.length,profiles:data.map((row,i)=>({email:C.values(row).email,name:C.nameKey(row),cardLast4:C.payment(row).number.slice(-4),duplicates:duplicates[i]}))};}
 async function withCards(a,ids,fn){if(!Array.isArray(ids)||ids.length>500||ids.some(x=>typeof x!=='string')||new Set(ids).size!==ids.length)throw Error('Choose saved cards in this vault.');return ids.length?cardVault(a.scope).withSelectedForJig(cardKey(a.scope,a.id),ids,fn):fn([]);}
 function resolve(data,retailer,ctx,options,cards){const existing=ctx.rows.filter(x=>x.retailer===retailer),seen=existing.map(x=>({retailer,data:x.data})),usedNames=new Set(existing.map(x=>C.nameKey(x.data))),usedEmails=new Set(existing.map(x=>C.email(x.email))),usedCards=new Set(ctx.rows.map(x=>C.payment(x.data).number));const added=[];
 for(let index=0;index<data.length;index++){let row=structuredClone(data[index]);const flags=C.collisions([row],seen,retailer)[0];
  if(options.name&&(flags.includes('name')||options.all)){row=C.randomName(row,usedNames);}
  if(options.email&&(flags.includes('email')||options.all)){const email=ctx.emails.find(x=>x.retailer===retailer&&!x.profileId&&!usedEmails.has(x.email));if(!email)throw Error('Not enough unused emails in this vault and retailer.');row.email=email.email;email.profileId='pending-'+index;}
  if(options.card&&(flags.includes('card')||options.all)){const card=cards.find(c=>!c.previouslyAssigned&&!usedCards.has(c.number));if(!card)throw Error('Not enough unused cards in this vault.');C.putCard(row,card);usedCards.add(card.number);}
  const after=C.collisions([row],seen,retailer)[0];if(after.includes('email'))throw Error('Duplicate email remains. Select Replace duplicate emails.');if(after.length&&!options.allowShared)throw Error('Duplicate name or card remains. Repair it or explicitly allow shared names/cards.');
  if(!C.values(row).email)throw Error('A profile email is missing.');usedEmails.add(C.email(row.email));usedNames.add(C.nameKey(row));seen.push({retailer,data:row});added.push(row);
 }return added;}
 async function importCommit(e,p){const plan=plans.get(p.token);if(!plan||plan.sender!==e.sender.id||now()-plan.at>600000||plan.epoch!==ep(e))throw Error('Import preview expired. Preview again.');const a=await access(e,{scope:plan.scope,customerId:plan.id});if(p.confirmed!==true)throw Error('Review the import first.');if(plan.bank==='live'){const result=await profiles.importLiveProfiles(a.scope,a.id,plan.entries,{updateExisting:p.updateExisting===true,batchId:uuid(),fileNames:plan.fileNames||[]},()=>{a.check();if(plans.get(p.token)!==plan)throw Error('Import was already saved.');});plans.delete(p.token);return result;}return withCards(a,p.cardIds||[],cards=>profiles.libraryTransaction(a.scope,a.id,ctx=>{if(plans.get(p.token)!==plan)throw Error('Import was already saved.');const data=resolve(plan.data,plan.retailer,ctx,p.repairs||{},cards),importBatchId=uuid(),customerLabel=profileOwnerLabel(p.customerName||p.group),existingCustomerCount=ctx.rows.filter(x=>x.source==='owner-created-profile').length,added=data.map((row,index)=>{const id=uuid(),email=C.email(row.email),label=a.scope==='personal'?email:customerLabel+' '+(existingCustomerCount+index+1),named=C.syncCardholderToProfile(D.manualEdit(row,{...D.toValues(row),label})),entry={id,retailer:plan.retailer,email,label,group:a.scope==='personal'?plan.retailer:customerLabel,source:'owner-created-profile',importBatchId,status:p.asAvailable===true?'available':'active',jiggedAt:p.alreadyJigged?new Date(now()).toISOString():null,createdAt:new Date(now()).toISOString(),revision:0,data:named,format:C.format(plan.retailer),assetRefs:{}};for(const bank of ctx.emails)if(bank.retailer===plan.retailer&&bank.email===email&&(!bank.profileId||String(bank.profileId).startsWith('pending-')))bank.profileId=id;ctx.rows.push(entry);ctx.audit('library-import',email,{retailer:plan.retailer});return entry;});ctx.importBatches.push({id:importBatchId,at:new Date(now()).toISOString(),bank:'working',retailers:[plan.retailer],fileNames:[plan.fileName||'import'],createdIds:added.map(x=>x.id),imported:added.length,updatedExisting:0,removedAt:null});plans.delete(p.token);return {imported:added.length,batchId:importBatchId};},a.check));}
 async function repair(e,p){const a=await access(e,p);return withCards(a,p.cardIds||[],cards=>profiles.libraryTransaction(a.scope,a.id,async ctx=>{
  const row=ctx.rows.find(x=>x.id===p.profileId);if(!row||row.revision!==p.revision)throw Error('Profile changed. Reopen it.');
  const linked=a.scope==='aco'&&row.source==='website-linked-profile'&&row.sourceLinked===true;
  if(row.needsReview)throw Error('Resolve the website conflict before repairing this profile.');
  if(linked&&p.repairs?.email)throw Error('Replace the linked retailer account from its unused account bank; do not change its login email locally.');
  const peers=ctx.rows.filter(x=>x.id!==row.id),target={...ctx,rows:peers};const [data]=resolve([row.data],row.retailer,target,{...p.repairs,all:true,allowShared:true},cards);
  let remote;if(linked){if(!saveCustomerProfile||!row.remoteManagedId)throw Error('Website profile is not verified.');remote=await saveCustomerProfile(a.id,{managedAccountId:row.remoteManagedId,type:row.remoteType,retailer:row.retailer,updatedAt:row.remoteUpdatedAt},{fields:C.values(data),...(p.repairs?.card?{card:C.payment(data)}:{})});if(!remote?.saved)throw Error('The website did not confirm the profile repair.');a.check();}
  row.data=data;row.email=C.email(data.email);row.revision++;row.manualOverride=!linked;
  if(linked){row.remoteUpdatedAt=remote.updatedAt;row.sourceHash=require('./jig-field-core').hash(data);row.websiteAuthoritative=true;}
  for(const bank of ctx.emails)if(bank.email===row.email&&bank.retailer===row.retailer&&String(bank.profileId).startsWith('pending-'))bank.profileId=row.id;
  ctx.audit(linked?'website-library-repair':'library-repair',row.email,{retailer:row.retailer});return {updated:true,remoteSaved:linked};
 },a.check));}
 async function edit(e,p){
  const a=await access(e,p);
  // The native app never silently reports a website save when only a local
  // profile has changed. Owner-confirmed linked edits use the website API.
  return profiles.libraryTransaction(a.scope,a.id,async ctx=>{
   const row=ctx.rows.find(x=>x.id===p.profileId);
   if(!row||row.revision!==p.revision)throw Error('Profile changed. Reopen it before editing.');
   if(row.needsReview)throw Error('Resolve the website conflict before editing this profile. Nothing was overwritten.');
   const data=D.manualEdit(row.data,p.fields),email=C.email(data.email);
    if(p.profileSecurityCode!==undefined){
     if(typeof p.profileSecurityCode!=='string'||p.profileSecurityCode.length>100||/[\x00-\x1f\x7f]/.test(p.profileSecurityCode))throw Error('Invalid separate profile code.');
     data.profileSecurityCode=p.profileSecurityCode;
    }
   if(email!==row.email&&ctx.rows.some(x=>x.id!==row.id&&x.retailer===row.retailer&&x.email===email))throw Error('Email already used in this retailer pool.');
   const requestedPoolEmail=p.poolEmail!==undefined?C.email(p.poolEmail):null;
   if(requestedPoolEmail!==null){
    if(row.sourceLinked||row.websiteAuthoritative||row.source==='website-linked-profile')throw Error('Website-linked logins must be replaced through their authorized retailer account pool.');
    if(!requestedPoolEmail||requestedPoolEmail!==email||requestedPoolEmail===row.email)throw Error('Select a different unused email from the same retailer pool.');
    if(!ctx.emails.some(x=>x.retailer===row.retailer&&x.email===requestedPoolEmail&&!x.profileId))throw Error('Selected email is no longer available in this retailer email pool. Refresh and try again.');
   }
   if(p.card){
    const c=p.card;
    if(!/^\d{12,19}$/.test(String(c.number||'').replace(/\D/g,''))||!/^(0[1-9]|1[0-2])$/.test(c.month||'')||!/^20\d\d$/.test(c.year||'')||!String(c.cardholder||'').trim()||String(c.cardholder).length>120||String(c.customSecurityCode||'').length>64)throw Error('Enter complete card number, holder and expiration.');
    C.putCard(data,c);
   }
   if(p.cardCvv!==undefined){
    if(a.scope!=='personal')throw Error('Card-code editing is available only in your unlocked Personal vault.');
    if(row.sourceLinked||row.websiteAuthoritative||row.source==='website-linked-profile')throw Error('Use the local imported profile to edit its card code.');
    if(typeof p.cardCvv!=='string'||!/^\d{3,4}$|^$/.test(p.cardCvv))throw Error('Enter a 3- or 4-digit CVV, or leave it blank.');
    for(const holder of [data,data.card])if(holder)for(const key of ['cvv','cvc','cid','cc_cvv','cvv2','securityCode','security_code'])if(Object.hasOwn(holder,key))holder[key]='';
    for(const holder of [data,data.card])if(holder&&/^\d{3,4}$/.test(String(holder.custom_security_code||'')))holder.custom_security_code='';
    if(D.formatOf(data)==='shikari')data.cc_cvv=p.cardCvv;else{data.card||={};data.card.cvv=p.cardCvv;}
   }
   const linked=a.scope==='aco'&&row.source==='website-linked-profile'&&row.sourceLinked!==false;
   let remote=null;
   if(linked){
    if(email!==row.email)throw Error('Linked retailer login email is managed in the website account pool. Edit that account there first, then sync ACO Studio.');
    if(!row.remoteManagedId||!['free','rented'].includes(row.remoteType)||!saveCustomerProfile)
     throw Error('This linked profile has not been verified against its website assignment. Sync customer data first; nothing was saved.');
    a.check();
    remote=await saveCustomerProfile(a.id,{managedAccountId:row.remoteManagedId,type:row.remoteType,retailer:row.retailer,updatedAt:row.remoteUpdatedAt}, {fields:C.values(data),card:p.card});
    if(!remote?.saved)throw Error('The website did not confirm the change; local details were preserved.');
    a.check();
   }
   row.data=data;row.email=email;row.label=C.values(data).label;
   row.group=String(p.group||row.group||row.retailer).slice(0,100);
   row.revision++;row.manualOverride=!linked;row.needsReview=false;
   if(linked){row.remoteUpdatedAt=remote.updatedAt||row.remoteUpdatedAt;row.sourceHash=remote.sourceHash||require('./jig-field-core').hash(data);
    // Once Studio explicitly publishes this profile's shipping/address data,
    // the website is the canonical copy. Never jig its returned value again.
    row.websiteAuthoritative=true;}
   else if(row.pendingSourceHash){row.sourceHash=row.pendingSourceHash;delete row.pendingSourceHash;}
   if(requestedPoolEmail!==null){
    for(const bank of ctx.emails)if(bank.retailer===row.retailer&&bank.profileId===row.id&&bank.email!==email){bank.profileId=null;bank.usedAt=null;}
   }
   for(const bank of ctx.emails)if(bank.email===email&&bank.retailer===row.retailer&&!bank.profileId){bank.profileId=row.id;bank.usedAt=now();}
   ctx.audit(linked?'website-and-library-edit':'library-edit',email,{retailer:row.retailer});
   return {updated:true,remoteSaved:linked,localOnly:!linked};
  },a.check);
 }
 async function exportFile(e,p){const a=await access(e,p);C.retailer(p.retailer);if(!Array.isArray(p.profileIds)||!p.profileIds.length||p.profileIds.length>500||new Set(p.profileIds).size!==p.profileIds.length)throw Error('Select 1-500 profiles.');const all=await profiles.fieldSnapshot(a.scope,a.id),rows=p.profileIds.map(id=>all.find(x=>x.id===id&&x.retailer===p.retailer));if(rows.some(x=>!x))throw Error('Every exported profile must still belong to this vault and retailer.');const content=C.exportRows(rows,p.retailer,p.customerName||'Personal');if(!await confirmExport(e))return {cancelled:true};const ext=path.extname(content.name),choice=await chooseSave(e,{name:content.name,extension:ext.slice(1)});if(choice.canceled||!choice.filePath)return {cancelled:true};if(path.extname(choice.filePath)!==ext)throw Error('Keep the retailer export format.');const latest=await profiles.fieldSnapshot(a.scope,a.id);if(rows.some(x=>require('./jig-field-core').hash(x)!==require('./jig-field-core').hash(latest.find(y=>y.id===x.id))))throw Error('Profiles changed while exporting. Try again.');a.check();await writeFile(choice.filePath,content.body,{encoding:'utf8',mode:0o600});return {saved:true,count:rows.length,name:path.basename(choice.filePath)};}
 async function exportArchive(e,p){
  const a=await access(e,p);
  C.retailer(p.retailer);
  if(!Array.isArray(p.profileIds)||!p.profileIds.length||p.profileIds.length>500||
    new Set(p.profileIds).size!==p.profileIds.length)throw Error('Select 1-500 profiles.');
  const before=await profiles.fieldSnapshot(a.scope,a.id);
  const rows=p.profileIds.map(id=>before.find(row=>row.id===id&&row.retailer===p.retailer));
  if(rows.some(row=>!row))throw Error('Profiles must belong to this vault and retailer.');
  const content=C.exportArchiveRows(rows,p.retailer,p.customerName||'Personal');
  if(!await confirmExport(e))return {cancelled:true};
  const choice=await chooseSave(e,{name:content.name,extension:'json'});
  if(choice.canceled||!choice.filePath)return {cancelled:true};
  if(path.extname(choice.filePath).toLowerCase()!=='.json')throw Error('Choose a JSON file.');
  const latest=await profiles.fieldSnapshot(a.scope,a.id);
  if(rows.some(row=>require('./jig-field-core').hash(row)!==
   require('./jig-field-core').hash(latest.find(item=>item.id===row.id))))
    throw Error('Profiles changed during export. Try again.');
  a.check();
  await writeFile(choice.filePath,content.body,{encoding:'utf8',mode:0o600});
  return {saved:true,count:rows.length,name:path.basename(choice.filePath)};
 }
 async function syncCustomer(e,p){
  if(p?.scope!=='aco')throw Error('Linked website profiles can only enter that customer vault.');
  const a=await access(e,p);if(!getCustomerProfileSource)throw Error('Customer profile synchronization unavailable.');
  const source=await getCustomerProfileSource(a.id);
  if(source.customer?.id!==a.id||(source.linked||[]).some(x=>x.customerId!==a.id))throw Error('Website customer identity mismatch.');a.check();
  const active=(source.linked||[]).filter(x=>x.active),createdAt=new Date(now()).toISOString();
  return profiles.libraryTransaction('aco',a.id,ctx=>{
   let created=0,updated=0,needsReview=0;const keys=new Set();
   for(const item of active){
    const retailer=C.retailer(item.retailer),key=retailer+'|'+item.assignmentId;keys.add(key);
    const previous=ctx.rows.find(x=>x.remoteKey===key),data=C.normalized(item.data,retailer);
    if(C.format(retailer)==='valor'){const hex=crypto.createHash('sha256').update(a.id+'|'+key).digest('hex');data.id=previous?.data?.id||hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20,32);}
    const hash=require('./jig-field-core').hash(data),remoteUpdatedAt=String(item.remoteUpdatedAt||'');
    if(previous){
     const changed=previous.sourceHash!==hash;
     if(changed&&previous.manualOverride){
      if(previous.pendingSourceHash!==hash||previous.pendingRemoteUpdatedAt!==remoteUpdatedAt){previous.revision++;previous.pendingSourceHash=hash;previous.pendingSourceData=data;previous.pendingRemoteUpdatedAt=remoteUpdatedAt;}
      previous.needsReview=true;needsReview++;continue;
     }
     if(changed||previous.sourceLinked===false||previous.needsReview||String(previous.remoteUpdatedAt||'')!==remoteUpdatedAt)previous.revision++;
     if(!changed&&previous.needsReview){previous.needsReview=false;delete previous.pendingSourceData;delete previous.pendingSourceHash;delete previous.pendingRemoteUpdatedAt;}
     previous.sourceLinked=true;previous.remoteUpdatedAt=remoteUpdatedAt;previous.remoteManagedId=item.managedAccountId||null;previous.remoteType=item.assignmentType||null;
     if(changed){previous.data=data;previous.email=C.email(data.email);previous.sourceHash=hash;updated++;}
     continue;
    }
    // Never implicitly link an imported record merely because its email matches.
    ctx.rows.push({id:uuid(),retailer,email:C.email(data.email),label:profileOwnerLabel(source.customer.name)+' '+(ctx.rows.filter(x=>x.source==='website-linked-profile').length+1),group:source.customer.name,source:'website-linked-profile',status:'active',createdAt,revision:0,data,format:C.format(retailer),remoteKey:key,remoteManagedId:item.managedAccountId||null,remoteType:item.assignmentType||null,remoteUpdatedAt,sourceHash:hash,sourceLinked:true,websiteAuthoritative:true,jiggedAt:createdAt,assetRefs:{}});created++;
    ctx.audit('linked-profile-created',C.email(data.email),{retailer});
   }
   for(const row of ctx.rows)if(row.source==='website-linked-profile'&&row.sourceLinked!==false&&!keys.has(row.remoteKey)){row.sourceLinked=false;row.revision++;row.status='unlinked';}
   return {created,updated,needsReview};
  },a.check);
 }
 async function resolveSourceConflict(e,p){
  const a=await access(e,p);
  if(p.confirmed!==true||!['website','studio'].includes(p.choice))throw Error('Choose and confirm which profile values to keep.');
  return profiles.libraryTransaction(a.scope,a.id,async ctx=>{
   const row=ctx.rows.find(x=>x.id===p.profileId);
   if(!row||row.revision!==p.revision||!row.needsReview||!row.pendingSourceData)throw Error('This conflict changed. Reopen the latest comparison.');
   if(a.scope!=='aco'||row.source!=='website-linked-profile'||!row.sourceLinked)throw Error('This is not an active website-linked conflict.');
   if(p.choice==='studio'){
    if(!saveCustomerProfile)throw Error('Website saves are unavailable.');
    const result=await saveCustomerProfile(a.id,{managedAccountId:row.remoteManagedId,type:row.remoteType,retailer:row.retailer,updatedAt:row.pendingRemoteUpdatedAt},{fields:C.values(row.data),card:C.payment(row.data)});
    if(!result?.saved)throw Error('The website did not confirm this resolution.');a.check();row.remoteUpdatedAt=result.updatedAt;
   }else{row.data=row.pendingSourceData;row.email=C.email(row.data.email);row.remoteUpdatedAt=row.pendingRemoteUpdatedAt;}
   row.sourceHash=require('./jig-field-core').hash(row.data);row.revision++;row.manualOverride=false;row.needsReview=false;row.websiteAuthoritative=true;
   delete row.pendingSourceData;delete row.pendingSourceHash;delete row.pendingRemoteUpdatedAt;
   ctx.audit('resolve-website-conflict',row.email,{retailer:row.retailer,choice:p.choice});return {saved:true,remoteSaved:p.choice==='studio'};
  },a.check);
 }
 async function changeAssignment(e,p){
  const a=await access(e,p);
  if(a.scope!=='aco'||p.confirmed!==true||!['unlink','replace','reassign'].includes(p.operation)||!changeCustomerAssignment)throw Error('Confirm an authorized linked account action.');
  const row=(await profiles.preview(a.scope,a.id,p.profileId)).profile;a.check();
  if(row.revision!==p.revision||row.source!=='website-linked-profile'||row.sourceLinked!==true||!row.remoteManagedId)throw Error('Reopen the current linked profile before changing its assignment.');
  const result=await changeCustomerAssignment(a.id,{id:row.remoteManagedId,type:row.remoteType,retailer:row.retailer,updatedAt:row.remoteUpdatedAt},p.operation,{replacementId:p.replacementId,targetCustomerId:p.targetCustomerId,durationType:p.durationType});
  if(result?.saved!==true)throw Error('The website did not confirm the assignment action.');a.check();
  await syncCustomer(e,{scope:'aco',customerId:a.id});return result;
 }
 async function linkLocal(e,p){
  const a=await access(e,p);if(a.scope!=='aco'||p.confirmed!==true||!saveCustomerProfile)throw Error('Confirm linking this customer record to its exact website assignment.');
  return profiles.libraryTransaction(a.scope,a.id,async ctx=>{
   const row=ctx.rows.find(x=>x.id===p.profileId),mirror=ctx.rows.find(x=>x.id===p.mirrorId);
   if(!row||!mirror||row.id===mirror.id||row.revision!==p.revision||mirror.revision!==p.mirrorRevision)throw Error('The selected local or website record changed. Reopen both records.');
   if(row.source==='website-linked-profile'||mirror.source!=='website-linked-profile'||mirror.sourceLinked!==true||row.retailer!==mirror.retailer||row.email!==mirror.email||mirror.needsReview)throw Error('Link only a matching local email to an active assignment in this customer and retailer.');
   const result=await saveCustomerProfile(a.id,{managedAccountId:mirror.remoteManagedId,type:mirror.remoteType,retailer:mirror.retailer,updatedAt:mirror.remoteUpdatedAt},{fields:C.values(row.data),card:C.payment(row.data)});
   if(!result?.saved)throw Error('The website did not confirm this link. Both local records were preserved.');a.check();
   Object.assign(row,{source:'website-linked-profile',sourceLinked:true,remoteKey:mirror.remoteKey,remoteManagedId:mirror.remoteManagedId,remoteType:mirror.remoteType,remoteUpdatedAt:result.updatedAt,sourceHash:require('./jig-field-core').hash(row.data),websiteAuthoritative:true,manualOverride:false,needsReview:false,revision:row.revision+1});
   ctx.rows.splice(ctx.rows.findIndex(x=>x.id===mirror.id),1);
   ctx.audit('explicit-link-replace-local-mirror',row.email,{retailer:row.retailer,replacedMirrorId:mirror.id});return {saved:true,remoteSaved:true};
  },a.check);
 }
 async function removeLocal(e,p){
  const a=await access(e,p);if(p.confirmed!==true)throw Error('Confirm deletion of this exact local profile.');
  return profiles.libraryTransaction(a.scope,a.id,ctx=>{
   const index=ctx.rows.findIndex(x=>x.id===p.profileId),row=ctx.rows[index];
   if(!row||row.revision!==p.revision)throw Error('Profile changed. Reopen it before deleting.');
   if(row.source==='website-linked-profile'&&row.sourceLinked===true)throw Error('Return this linked account to its website pool before deleting its local profile.');
   ctx.rows.splice(index,1);for(const bank of ctx.emails)if(bank.profileId===row.id){bank.profileId=null;bank.usedAt=null;}
   ctx.audit('delete-local-profile',row.email,{retailer:row.retailer});return {deleted:true,localOnly:true};
  },a.check);
 }
 
 // Customer-only Jig resource inventory: website account, Studio banks, and cards
 // already assigned to customer profiles. Only masked card metadata reaches UI.
 async function jigSources(a){
  if(a.scope!=='aco'||!getCustomerProfileSource)throw Error('Choose a linked customer.');
  const website=await getCustomerProfileSource(a.id);
  if(website.customer?.id!==a.id)throw Error('Customer account mismatch.');
  const localAddresses=addressBanks?await addressBanks.listAco(a.id):{addresses:[]};
  const localCards=cardVault?await cardVault('aco').list(cardKey('aco',a.id)):{cards:[]};
  const ownedProfiles=await profiles.fieldSnapshot('aco',a.id);a.check();
  return {website:website.jigResources||{},localAddresses:localAddresses.addresses||[],
   localCards:localCards.cards||[],ownedProfiles};
 }
 async function jigAssets(e,p){
  const a=await access(e,p),resources=await jigSources(a);
  const siteA=resources.website.addresses||[],siteC=resources.website.cards||[];
  const addressLabel=x=>[x.address1||x.address||x.addressLine1,x.address2||x.addressLine2,x.city,x.state,x.zip||x.zipCode].filter(Boolean).join(', ');
  const last4=x=>String(x.acoCardNumber||x.cardNumber||x.number||x.maskedNumber||x.last4||'').replace(/\D/g,'').slice(-4);
  return {customerId:a.id,addresses:[
   ...siteA.map((x,i)=>({id:'website:'+i,label:x.label||'Website address '+(i+1),summary:addressLabel(x)})),
   ...resources.localAddresses.map((x,i)=>({id:'local:'+x.id,label:x.label||'Studio address '+(i+1),summary:addressLabel(x)}))],
   cards:[
    ...siteC.map((x,i)=>({id:'website:'+i,label:x.cardLabel||x.label||'Website card '+(i+1),last4:last4(x)})),
    ...resources.localCards.map((x,i)=>({id:'local:'+x.id,label:x.label||'Studio card '+(i+1),last4:last4(x)})),
    ...resources.ownedProfiles.filter(x=>/^\d{12,19}$/.test(C.payment(x.data).number)).map(x=>({
      id:'profile:'+x.id,label:(x.label||x.email)+' profile card',last4:C.payment(x.data).number.slice(-4)}))
   ]};
 }
 async function jigResource(a,kind,id){
  if(!id)return null;
  if(typeof id!=='string'||id.length>225||!/^(website|local|profile):/.test(id))throw Error('Invalid customer resource.');
  const [origin,...remainder]=id.split(':'),ref=remainder.join(':');
  const r=await jigSources(a);let item;
  if(origin==='website'){
   const set=kind==='address'?r.website.addresses:r.website.cards;
   if(!/^\d+$/.test(ref)||!Array.isArray(set)||Number(ref)>=set.length)throw Error('Saved website resource changed. Reopen Jig.');
   item=set[Number(ref)];
  }else if(origin==='local'){
   if(kind==='address')item=r.localAddresses.find(x=>String(x.id)===ref);
   else if(cardVault){const cards=await cardVault('aco').selectedForJig(cardKey('aco',a.id),[ref]);item=cards.find(x=>String(x.id)===ref);}
  }else if(origin==='profile'&&kind==='card'){
   const profile=r.ownedProfiles.find(x=>x.id===ref);
   if(profile){const c=C.payment(profile.data);item={number:c.number,cardholder:c.cardholder,month:c.month,year:c.year};}
  }
  a.check();if(!item)throw Error('Selected resource no longer belongs to this customer.');
  if(kind==='address'){
   const address={address1:String(item.address1||item.address||item.addressLine1||''),
    address2:String(item.address2||item.addressLine2||''),city:String(item.city||''),
    state:String(item.state||''),zip:String(item.zip||item.zipCode||'')};
   if(!address.address1||!address.city||!address.state||!address.zip)throw Error('Selected saved address is incomplete.');
   return address;
  }
  const card={number:String(item.acoCardNumber||item.cardNumber||item.number||'').replace(/\D/g,''),
    cardholder:String(item.cardholder||item.holder||''),month:String(item.expMonth||item.month||'').padStart(2,'0'),
    year:String(item.expYear||item.year||'')};
  if(!/^\d{12,19}$/.test(card.number)||!/^(0[1-9]|1[0-2])$/.test(card.month)||!/^20\d\d$/.test(card.year))
   throw Error('This saved card has only masked details; choose a full card in the customer Studio bank. No data was changed.');
  return card;
 }
 async function previewLinkedJig(e,p){
  const a=await access(e,p);if(a.scope!=='aco')throw Error('Choose an active website-linked customer profile.');
  const row=(await profiles.preview(a.scope,a.id,p.profileId)).profile;a.check();
  if(row.revision!==p.revision||row.source!=='website-linked-profile'||row.sourceLinked!==true||row.needsReview)throw Error('Reopen the current linked profile before previewing jigs.');
  if(!Array.isArray(p.ruleIds)||!p.ruleIds.length||p.ruleIds.length>100||p.ruleIds.some(id=>/^prefix_three/.test(id)||!supportedRule(id)))throw Error('Choose supported retailer jig options.');
  const batches=p.combine?[nonStackingRules(p.ruleIds)]:p.ruleIds.map(id=>[id]),candidates=[];
  for(const batch of batches){let data=structuredClone(row.data);const addressRules=batch.filter(id=>id!==C.FL_PHONE_RULE);for(const rule of addressRules)data=C.jig(data,row.retailer,1,[rule]);if(batch.includes(C.FL_PHONE_RULE))data=C.applyFloridaPhone(data,uuid(),0);const v=C.values(data),address=Object.fromEntries(['address1','address2','city','state','zip'].map(k=>[k,v['shipping.'+k]]));if(address.address1&&JSON.stringify(address)!==JSON.stringify(Object.fromEntries(Object.keys(address).map(k=>[k,C.values(row.data)['shipping.'+k]])))||batch.includes(C.FL_PHONE_RULE))candidates.push({ruleIds:batch,address,phone:v.phone});}
  return {revision:row.revision,candidates};
 }
 async function publishLinkedJig(e,p){
  const a=await access(e,p);
  if(a.scope!=='aco'||p.confirmed!==true)throw Error('Confirm the website-linked customer profile before publishing a jig.');
  const address=p.address||{};
  if(!address.address1||!address.city||!address.state||!address.zip||
      ['address1','address2','city','state','zip'].some(k=>typeof (address[k]??'')!=='string'||String(address[k]??'').length>300))
   throw Error('Choose a complete approved address-jig preview before publishing.');
  const result=await profiles.preview(a.scope,a.id,p.profileId);
  a.check();
  const row=result.profile;
  if(row.revision!==p.expectedRevision)throw Error('The linked profile changed after your preview. Reopen and preview it again.');
  if(row.source!=='website-linked-profile'||row.sourceLinked!==true)
   throw Error('This profile is local-only. Use the local jig button or link it to the website first.');
  const fields=D.toValues(row.data);
  for(const k of ['address1','address2','city','state','zip']){fields['shipping.'+k]=String(address[k]??'').trim();if(p.billingSameAsShipping)fields['billing.'+k]=String(address[k]??'').trim();}
  const jigged=C.syncCardholderToProfile(D.manualEdit(row.data,fields));
  const saved=await edit(e,{scope:'aco',customerId:a.id,profileId:row.id,revision:row.revision,fields:C.values(jigged),group:row.group,card:C.payment(jigged)});
  if(saved?.remoteSaved!==true)throw Error('Website did not confirm this jig. Do not treat it as a synchronized change.');
  return {saved:true,remoteSaved:true,profileId:row.id,retailer:row.retailer};
 }
 function addressView(data){
  const v=C.values(data);
  return {...Object.fromEntries(['address1','address2','city','state','zip'].map(k=>[k,String(v['shipping.'+k]||'')])),phone:String(v['shipping.phone']||v.phone||'')};
 }
 function normalizedAddressPart(v){return String(v||'').trim().toUpperCase().replace(/\s+/g,' ');}
 function mainAddressKey(row){
  const v=C.values(row.data);
  return ['shipping.address1','shipping.address2','shipping.city','shipping.state','shipping.zip'].map(k=>normalizedAddressPart(v[k])).join('|');
 }
 function isHardRule(id){return C.ruleById(id)?.family==='target-primary';}
 function applyOne(data,row,id){return C.jig(data,row.retailer,1,[id]);}
 function bulkJigData(row,ruleIds,groupPosition,combine,billingSameAsShipping,phoneSeed,globalIndex=0){
  let data=structuredClone(row.data),addressRules=ruleIds.filter(id=>id!==C.FL_PHONE_RULE),phoneJig=ruleIds.includes(C.FL_PHONE_RULE);
  // Position zero in every main-address group is intentionally untouched.
  if(groupPosition>0&&addressRules.length){
   const soft=addressRules.filter(id=>!isHardRule(id)),hard=addressRules.filter(isHardRule);
   if(combine){
    // Explicit Combine is the only mode allowed to stack multiple hard Target
    // primary-number changes. Soft formatting can accompany them.
    const ordered=[...soft,...hard];
    for(const id of ordered.slice(0,Math.max(1,Math.min(ordered.length,4))))data=applyOne(data,row,id);
   }else{
    // First use each applicable soft style by itself. After that, rotate the
    // harder variants and pair each with a soft style when one exists. This
    // keeps a batch varied without stacking two hard jigs.
    const slot=groupPosition-1;
    if(slot<soft.length)data=C.jig(data,row.retailer,slot+1,soft);
    else if(hard.length){
     const hardId=hard[(slot-soft.length)%hard.length];
     data=applyOne(data,row,hardId);
     if(soft.length)data=applyOne(data,row,soft[(slot-soft.length)%soft.length]);
    }else data=C.jig(data,row.retailer,groupPosition,addressRules);
   }
  }
  if(phoneJig)data=C.applyFloridaPhone(data,phoneSeed,globalIndex);
  const before=D.toValues(row.data),after=D.toValues(data),edits={...after};
  if(billingSameAsShipping){for(const key of ['address1','address2','city','state','zip'])edits['billing.'+key]=after['shipping.'+key];}
  else for(const key of ['first','last','phone','address1','address2','city','state','zip','country'])if(!(phoneJig&&key==='phone'))edits['billing.'+key]=before['billing.'+key];
  return C.syncCardholderToProfile(D.manualEdit(data,edits));
 }

 const HARD_KINDS=['fraction','hyphen','doubleLetter','randomUnit'];
 function hardCounts(value){
  if(value==null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!HARD_KINDS.includes(k)))throw Error('Invalid hard jig categories.');
  const counts={};
  for(const kind of HARD_KINDS){const n=value[kind]??0;if(!Number.isInteger(n)||n<0||n>500)throw Error('Hard jig counts must be whole numbers between 0 and 500.');counts[kind]=n;}
  return counts;
 }
 function hardEdit(data,kind,variant){
  const v=D.toValues(data),street=String(v['shipping.address1']||'').trim(),unit=String(v['shipping.address2']||'').trim();
  if(!street)return null;
  let next=street,nextUnit=unit;
  if(kind==='fraction'){
   if(!/^\d+\s+/.test(street))return null;
   const values=['1/2','1/3','1/4'];if(variant>=values.length)return null;
   next=street.replace(/^(\d+)(\s+)/,'$1 '+values[variant]+' ');
  }else if(kind==='hyphen'){
   if(!/^\d+\s+/.test(street)||variant>=8)return null;
   next=street.replace(/^(\d+)(?=\s)/,'$1-'+String.fromCharCode(65+variant));
  }else if(kind==='doubleLetter'){
   const match=/^(\d+\s+)([A-Za-z]{3,})(.*)$/.exec(street);
   if(!match||variant>=match[2].length)return null;
   const pos=variant,word=match[2];next=match[1]+word.slice(0,pos+1)+word[pos]+word.slice(pos+1)+match[3];
  }else if(kind==='randomUnit'){
   // Never manufacture an additional unit for an address with an existing one.
   if(unit||/(?:\b(?:apt|apartment|unit|suite|ste|condo|floor|fl|room|rm)\b|#\s*\w)/i.test(street)||variant>=500)return null;
   nextUnit='Unit '+String(101+variant);
  }else return null;
  if(next===street&&nextUnit===unit)return null;
  return D.manualEdit(data,{...v,'shipping.address1':next,'shipping.address2':nextUnit});
 }
 function newBulkJigData(row,kind,variant,soft,combine,billingSameAsShipping,phoneSeed,globalIndex){
  let data=structuredClone(row.data);
  const before=D.toValues(row.data);
  if(kind){
   const changed=hardEdit(data,kind,variant);if(!changed)return null;data=changed;
   // Soft formatting may accompany one hard jig, but another hard category may not.
   if(soft?.length){const attempt=C.jig(data,row.retailer,1+(globalIndex%soft.length),soft);if(attempt)data=attempt;}
  }else if(soft?.length)data=C.jig(data,row.retailer,1+globalIndex,soft);
  const after=D.toValues(data),edits={...after};
  if(billingSameAsShipping)for(const key of ['address1','address2','city','state','zip'])edits['billing.'+key]=after['shipping.'+key];
  else for(const key of ['first','last','phone','address1','address2','city','state','zip','country'])edits['billing.'+key]=before['billing.'+key];
  if(combine&&kind==='fraction'){/* Explicit combine retained as opt-in, never implicit. */}
  return C.syncCardholderToProfile(D.manualEdit(data,edits));
 }
 function perAddressHardRows(selected,p,phoneSeed){
  const counts=hardCounts(p.hardCounts),soft=p.ruleIds.filter(id=>id!==C.FL_PHONE_RULE&&!isHardRule(id)),phone=p.ruleIds.includes(C.FL_PHONE_RULE);
  const groups=new Map();
  selected.forEach((row,index)=>{const key=mainAddressKey(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push({row,index});});
  const outcome=new Array(selected.length);
  for(const [key,items] of groups){
   const seen=new Set(),remaining={...counts},used={fraction:0,hyphen:0,doubleLetter:0,randomUnit:0};
   const originalRequired=items.length>1;
   const originalAddress=addressView(items[0].row.data);
   for(let i=0;i<items.length;i++){
    const {row,index}=items[i],original=originalRequired&&i===0;
    let data=structuredClone(row.data),kind=original?'original':'soft',selectedVariant=null;
    if(!original){
     let found=false;
     // Rotate category choices so per-address counts apply to categories,
     // not specific 1/2, 1/3, -A, etc. Every category has a strict cap.
     const available=HARD_KINDS.filter(k=>remaining[k]>0);
     const priorities=available.sort((a,b)=>(used[a]-used[b])||(HARD_KINDS.indexOf(a)-HARD_KINDS.indexOf(b)));
     for(const category of priorities){
      for(let attempt=0;attempt<500;attempt++){
       const next=newBulkJigData(row,category,attempt,soft,p.combine===true,p.billingSameAsShipping===true,phoneSeed,index);
       if(!next)break;
       const candidate=mainAddressKey({data:next});
       if(candidate!==key&&!seen.has(candidate)){data=next;kind=category;selectedVariant=attempt;remaining[category]--;used[category]++;found=true;break;}
      }
      if(found)break;
     }
     if(!found&&soft.length){
      for(let attempt=0;attempt<soft.length;attempt++){
       const next=newBulkJigData(row,null,0,[soft[(i+attempt)%soft.length]],false,p.billingSameAsShipping===true,phoneSeed,index);
       const candidate=mainAddressKey({data:next});
       if(candidate!==key&&!seen.has(candidate)){data=next;kind='soft';found=true;break;}
      }
     }
     if(!found)throw Error('Not enough unique eligible jig variations for '+originalAddress.address1+'. Adjust category counts, enable more soft rules, or select fewer profiles. Existing unit addresses cannot use Random unit.');
    }
    if(phone)data=C.applyFloridaPhone(data,phoneSeed,index);
    const addressKey=mainAddressKey({data});if(seen.has(addressKey))throw Error('A jig would duplicate an existing address. Adjust category counts.');seen.add(addressKey);
    outcome[index]={data,kind,variant:selectedVariant,original,mainAddress:originalAddress};
   }
  }
  return outcome;
 }
 async function batchJigPreview(e,p){
  const a=await access(e,p),retailer=C.retailer(p.retailer);
  if(!Array.isArray(p.profileIds)||!p.profileIds.length||p.profileIds.length>500||new Set(p.profileIds).size!==p.profileIds.length)throw Error('Select 1-500 profiles to jig together.');
  const requestedCounts=hardCounts(p.hardCounts),hasHard=requestedCounts&&HARD_KINDS.some(k=>requestedCounts[k]>0);
  if(!Array.isArray(p.ruleIds)||p.ruleIds.length>100||p.ruleIds.some(id=>typeof id!=='string'||/^prefix_three/.test(id)||!supportedRule(id))||(!p.ruleIds.length&&!hasHard))throw Error('Choose supported retailer rules or enable at least one hard jig category.');
  const all=await profiles.fieldSnapshot(a.scope,a.id),selected=p.profileIds.map(id=>all.find(x=>x.id===id&&x.retailer===retailer));
  if(selected.some(x=>!x))throw Error('Every selected profile must still belong to this vault and retailer.');
  if(selected.some(x=>x.needsReview))throw Error('Resolve website conflicts before bulk jigging.');
  const phoneSeed=uuid(),positions=new Map(),groupSizes=new Map(),hardResults=requestedCounts?perAddressHardRows(selected,p,phoneSeed):null;
  for(const row of selected){const key=mainAddressKey(row);groupSizes.set(key,(groupSizes.get(key)||0)+1);}
  const rows=selected.map((row,index)=>{
   const key=mainAddressKey(row),groupPosition=positions.get(key)||0;positions.set(key,groupPosition+1);
   // A singleton must still be jigged when explicitly selected. Reserve an
   // untouched original only when this batch contains multiple same-base profiles.
   const jigPosition=groupSizes.get(key)===1?1:groupPosition;
   const data=hardResults?hardResults[index].data:bulkJigData(row,p.ruleIds,jigPosition,p.combine===true,p.billingSameAsShipping===true,phoneSeed,index),before=addressView(row.data),after=addressView(data);
   if(!after.address1||!after.city||!after.state||!after.zip)throw Error('A selected profile is missing a complete shipping address.');
   return {profileId:row.id,revision:row.revision||0,hash:require('./jig-field-core').hash(row.data),email:row.email,label:row.label,retailer:row.retailer,linked:a.scope==='aco'&&row.source==='website-linked-profile'&&row.sourceLinked!==false,before,after,data,group:row.group||row.retailer,category:hardResults?.[index].kind||((groupPosition===0&&groupSizes.get(key)>1)?'original':'legacy'),mainAddress:hardResults?.[index].mainAddress||before};
  });
  if(rows.every(x=>JSON.stringify(x.before)===JSON.stringify(x.after)))throw Error('The selected jig rules did not change any selected profile.');
  const token=uuid();
  for(const [id,plan] of jigPlans)if(now()-plan.at>600000)jigPlans.delete(id);
  jigPlans.set(token,{sender:e.sender.id,scope:a.scope,id:a.id,retailer,rows,at:now(),epoch:ep(e)});
  return {token,count:rows.length,changed:rows.filter(x=>JSON.stringify(x.before)!==JSON.stringify(x.after)).length,linked:rows.filter(x=>x.linked).length,profiles:rows.map(x=>({profileId:x.profileId,email:x.email,label:x.label,before:x.before,after:x.after,linked:x.linked,category:x.category,mainAddress:x.mainAddress}))};
 }
 async function batchJigCommit(e,p){
  const plan=jigPlans.get(p.token);
  if(!plan||plan.sender!==e.sender.id||now()-plan.at>600000||plan.epoch!==ep(e))throw Error('Bulk jig preview expired. Preview the selected profiles again.');
  if(p.confirmed!==true)throw Error('Confirm the reviewed bulk jig before saving.');
  const a=await access(e,{scope:plan.scope,customerId:plan.id}),latest=await profiles.fieldSnapshot(plan.scope,plan.id);
  for(const change of plan.rows){
   const row=latest.find(x=>x.id===change.profileId&&x.retailer===plan.retailer);
   if(!row||(row.revision||0)!==change.revision||require('./jig-field-core').hash(row.data)!==change.hash)throw Error('A selected profile changed after preview. Nothing was saved; preview the batch again.');
  }
  let updated=0,remoteSaved=0;
  for(const change of plan.rows){
   const result=await edit(e,{scope:plan.scope,customerId:plan.id,profileId:change.profileId,revision:change.revision,fields:C.values(change.data),group:change.group,card:C.payment(change.data)});
   updated++;if(result?.remoteSaved)remoteSaved++;
  }
  jigPlans.delete(p.token);a.check();
  return {saved:true,updated,remoteSaved,localSaved:updated-remoteSaved};
 }
 async function websiteSnapshot(e,p){
  const a=await access(e,p);
  if(a.scope!=='aco'||!getCustomerSavedData)throw Error('Website saved data is only available to the authorized customer vault.');
  const result=await getCustomerSavedData(a.id);
  a.check();if(result.customer?.id!==a.id)throw Error('Website returned another customer. Data was discarded.');
  return result;
 }
 async function saveWebsiteAddress(e,p){
  const a=await access(e,p);
  if(a.scope!=='aco'||!updateCustomerSavedData)throw Error('This is not a live website customer address.');
  if(p.confirmed!==true||typeof p.addressId!=='string'||!p.addressId||!/^[-a-f0-9]{64}$/i.test(p.expectedRevision||''))throw Error('Open and explicitly confirm the current saved address before editing.');
  const result=await updateCustomerSavedData(a.id,'address',p.addressId,{expectedRevision:p.expectedRevision,address:p.address});
  a.check();if(result?.saved!==true)throw Error('Website did not confirm this address. Nothing changed locally.');
  return result;
 }
 async function saveWebsitePayment(e,p){
  const a=await access(e,p);
  if(a.scope!=='aco'||!updateCustomerSavedData)throw Error('This is not a live website customer payment method.');
  if(p.confirmed!==true||typeof p.paymentId!=='string'||!p.paymentId||!/^[-a-f0-9]{64}$/i.test(p.expectedRevision||''))throw Error('Open and explicitly confirm the current payment method before editing.');
  const result=await updateCustomerSavedData(a.id,'payment',p.paymentId,{expectedRevision:p.expectedRevision,payment:p.payment});
  a.check();if(result?.saved!==true)throw Error('Website did not confirm this payment edit. Nothing changed locally.');
  return result;
 }
 async function manageWebsiteRecord(e,p){
  const a=await access(e,p);
  if(a.scope!=='aco'||!updateCustomerSavedData)throw Error('Choose an authorized website customer account.');
  if(p.confirmed!==true||!['address','payment'].includes(p.kind)||!['create','delete'].includes(p.operation))throw Error('Confirm the exact saved-record action.');
  if(p.operation==='delete'&&(!p.recordId||!/^[-a-f0-9]{64}$/i.test(p.expectedRevision||'')))throw Error('Reopen the current record before deleting it.');
  const payload={operation:p.operation,confirmed:true,expectedRevision:p.expectedRevision,[p.kind]:p[p.kind]};
  const result=await updateCustomerSavedData(a.id,p.kind,p.recordId||'',payload);
  a.check();if(result?.saved!==true)throw Error('The website did not confirm this action.');
  return result;
 }
 async function importHistory(e,p){const a=await access(e,p);const result=await profiles.importHistory(a.scope,a.id);a.check();return {batches:result};}
 async function removeImportBatch(e,p){const a=await access(e,p);return profiles.removeImportBatch(a.scope,a.id,p,a.check);}
 async function bulkManage(e,p){const a=await access(e,p);return profiles.bulkManage(a.scope,a.id,p,a.check);}
 async function rules(e,p){const a=await access(e,p),retailer=C.retailer(p.retailer);const settings=await profiles.librarySettings(a.scope,a.id),saved=settings[retailer];a.check();const legacyTarget=retailer==='target'&&Array.isArray(saved?.rules)&&saved?.presetVersion!==2;const selected=legacyTarget?[...new Set([...saved.rules,...C.TARGET_PRIMARY_RULES.map(x=>x.id)])]:(saved?.rules||C.defaultRules(retailer));return {selected,legacyMigrated:legacyTarget,presetVersion:2,options:[...C.ruleOptions(retailer),{id:C.FL_PHONE_RULE,label:'Random Florida phone number',risk:'standard',family:'phone'}]};}
 async function saveRules(e,p){const a=await access(e,p);C.retailer(p.retailer);if(!Array.isArray(p.rules)||p.rules.length>100||new Set(p.rules).size!==p.rules.length||p.rules.some(id=>typeof id!=='string'||/^prefix_three/.test(id)||!supportedRule(id)))throw Error('Choose supported jig rules for this retailer.');return profiles.libraryTransaction(a.scope,a.id,ctx=>{ctx.settings[p.retailer]={rules:p.rules,presetVersion:2};return {saved:true,presetVersion:2};},a.check);}
 return {jigAssets,list,detail,importPreview,importCommit,importHistory,removeImportBatch,bulkManage,repair,edit,exportFile,exportArchive,syncCustomer,previewLinkedJig,publishLinkedJig,batchJigPreview,batchJigCommit,websiteSnapshot,saveWebsiteAddress,saveWebsitePayment,manageWebsiteRecord,resolveSourceConflict,changeAssignment,linkLocal,removeLocal,rules,saveRules,cancel};
}
function registerLibrary(options){const service=createLibrary(options);for(const method of ['jigAssets','list','detail','importPreview','importCommit','importHistory','removeImportBatch','bulkManage','repair','edit','exportFile','exportArchive','syncCustomer','previewLinkedJig','publishLinkedJig','batchJigPreview','batchJigCommit','websiteSnapshot','saveWebsiteAddress','saveWebsitePayment','manageWebsiteRecord','resolveSourceConflict','changeAssignment','linkLocal','removeLocal','rules','saveRules'])options.ipcMain.handle('profile:library:'+method,(e,p)=>service[method](e,p));options.ipcMain.handle('profile:library:cancel',e=>{options.requireOwner(e);return service.cancel(e);});
 // Owner-only encrypted backup recovery for complete Personal and ACO vaults.
 // No customer website token or profile ID can access these snapshots.
 options.ipcMain.handle('profile:library:backupList',(e,p)=>{
   options.requireOwner(e);
   if(!['personal','aco'].includes(p?.scope))throw Error('Choose an owner bank.');
   return options.profiles.backupList(p.scope);
 });
 options.ipcMain.handle('profile:library:backupRestore',(e,p)=>{
   options.requireOwner(e);
   if(p?.confirmed!==true||!['personal','aco'].includes(p.scope)||typeof p.name!=='string')
     throw Error('Explicit owner confirmation is required.');
   return options.profiles.backupRestore(p.scope,p.name);
 });
 return service;}
module.exports={createLibrary,registerLibrary};

