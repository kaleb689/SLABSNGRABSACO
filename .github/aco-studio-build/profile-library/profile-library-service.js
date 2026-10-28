'use strict';
const path=require('node:path'),crypto=require('node:crypto'),Core=require('./app'),D=require('./profile-draft-core'),C=require('./profile-library-core'),Completion=require('./profile-completion-core'),CardPolicy=require('./card-pool-policy');
function createLibrary({authorize,guard,profiles,cardVault,addressBanks,chooseSave,confirmExport,writeFile=require('node:fs/promises').writeFile,getCustomerProfileSource,saveCustomerProfile,getCustomerSavedData,updateCustomerSavedData,changeCustomerAssignment,getPostalJigOptions,chooseHistoricalFolder,chooseOriginalFiles,now=Date.now,uuid=crypto.randomUUID}={}){
 const plans=new Map(),reconciliationPlans=new Map(),duplicateRepairPlans=new Map(),jigPlans=new Map(),codeRestorePlans=new Map(),epochs=new Map();
 const supportedRule=id=>id===C.FL_PHONE_RULE||Boolean(C.ruleById(id));
 const nonStackingRules=ids=>{let targetPrimary=false;return ids.filter(id=>{if(C.ruleById(id)?.family!=='target-primary')return true;if(targetPrimary)return false;targetPrimary=true;return true;});};
 const ep=e=>epochs.get(e.sender.id)||0;
 function cancel(e){epochs.set(e.sender.id,ep(e)+1);for(const [id,p] of plans)if(p.sender===e.sender.id)plans.delete(id);for(const [id,p] of reconciliationPlans)if(p.sender===e.sender.id)reconciliationPlans.delete(id);for(const [id,p] of duplicateRepairPlans)if(p.sender===e.sender.id)duplicateRepairPlans.delete(id);for(const [id,p] of jigPlans)if(p.sender===e.sender.id)jigPlans.delete(id);}
 async function access(e,p){require('./jig-field-core').scopeKey(p?.scope,p?.customerId);const epoch=ep(e);const id=await authorize(e,p.scope,p.customerId);if(p.scope==='aco'&&id!==p.customerId)throw Error('Customer vault mismatch.');guard(e,p.scope);if(ep(e)!==epoch)throw Error('Vault closed during authorization.');return {scope:p.scope,id,check:()=>{guard(e,p.scope);if(ep(e)!==epoch)throw Error('Vault closed during this operation.');}};}
 const cardKey=(s,id)=>s==='personal'?'personal:owner':id;
 const profileOwnerLabel=value=>String(value||'Customer').trim().split(/\s+/)[0]||'Customer';
 function view(row){const result=Completion.inspect(row);return {id:row.id,revision:row.revision||0,retailer:row.retailer,bank:row.bank||'working',liveSince:row.liveSince||null,group:row.group||row.retailer,stage:result.ready?'completed':'in-progress',status:row.status||'active',missing:result.missing,label:row.label,email:row.email,data:structuredClone(row.data),source:row.source,createdAt:row.createdAt||null,completedAt:row.completedAt||null,profileGeneratedAt:row.profileGeneratedAt||null,needsFirstExport:row.needsFirstExport===true,exportedAt:row.exportedAt||null,creationBatchId:row.creationBatchId||null,sourceLinked:row.source==='website-linked-profile'&&row.sourceLinked===true,localOnly:row.source!=='website-linked-profile'||row.sourceLinked===false,pendingWebsiteData:row.pendingSourceData?structuredClone(row.pendingSourceData):null,remoteManagedId:row.remoteManagedId||null,remoteType:row.remoteType||null,remoteUpdatedAt:row.remoteUpdatedAt||null,needsReview:!!row.needsReview};}
 async function list(e,p){
  const a=await access(e,p),rows=await profiles.fieldSnapshot(a.scope,a.id);
  a.check();
  // Same-retailer collisions in the same authenticated Personal/customer vault.
  // Shared names, addresses, and cross-retailer email/card reuse are valid.
  // Index by owner-vault + retailer + exact normalized email/full card number.
  // A shared card/email across different retailers is never a conflict.
  const duplicatesByKey=new Map();
  for(const row of rows){
   const email=C.email(C.values(row.data).email||row.email),card=C.payment(row.data).number;
   for(const [kind,value] of [['email',email],['card',/^\d{12,19}$/.test(card)?card:'']]){
    if(!value)continue;
    const key=row.retailer+'|'+kind+'|'+value;
    if(!duplicatesByKey.has(key))duplicatesByKey.set(key,[]);
    duplicatesByKey.get(key).push(row);
   }
  }
  const peerLabel=row=>({
   id:row.id,email:C.email(C.values(row.data).email||row.email),
   bank:row.bank==='live'?'live':Completion.inspect(row).ready?'completed':'unused'
  });
  const [settings,audit,unusedConflicts]=await Promise.all([
   profiles.librarySettings(a.scope,a.id),profiles.audit(a.scope,a.id),
   profiles.unusedEmailConflicts(a.scope,a.id)
  ]);
  a.check();
  const conflictedUnused=new Set(unusedConflicts.filter(x=>x.reason==='matches-profile').map(x=>x.retailer+'|'+x.email));
  const creationEvents=new Map();
  for(const event of audit.entries||[]){
   if(event.action!=='create-from-pools'||!event.retailer||!event.email||!event.at)continue;
   const key=event.retailer+'|'+event.email.toLowerCase();
   if(!creationEvents.has(key))creationEvents.set(key,event.at);
  }
  return {scope:a.scope,customerId:a.id,customGroups:settings.profileGroups||{},unusedConflicts,
   profiles:rows.map(row=>{
    const email=C.email(C.values(row.data).email||row.email),number=C.payment(row.data).number,duplicates=[],duplicateDetails=[];
    for(const [kind,value] of [['email',email],['card',/^\d{12,19}$/.test(number)?number:'']]){
     if(!value)continue;
     const peers=(duplicatesByKey.get(row.retailer+'|'+kind+'|'+value)||[]).filter(x=>x.id!==row.id);
     if(!peers.length)continue;
     duplicates.push(kind);
     // Read-only values are sent only through the existing authenticated vault
     // profile-list IPC. Never log, persist, send to another vault or export.
     duplicateDetails.push({kind,value,peers:peers.map(peerLabel)});
    }
    if(email&&conflictedUnused.has(row.retailer+'|'+email)){
     duplicates.push('unused email');
     duplicateDetails.push({kind:'unused email',value:email,
      peers:unusedConflicts.filter(x=>x.retailer===row.retailer&&x.email===email&&x.reason==='matches-profile')
       .map(x=>({id:x.id,email:x.email,bank:'unused-email-bank'}))});
    }
    return {...view(row),profileGeneratedAt:row.profileGeneratedAt||creationEvents.get(row.retailer+'|'+String(row.email||'').toLowerCase())||null,duplicates,duplicateDetails};
   })
  };
 }

 // Rotate only a selected LOCAL profile into an existing available resource.
 // The original row remains recoverable in the encrypted duplicate archive.
 async function duplicateRepairPreview(e,p){
  const a=await access(e,p),retailer=C.retailer(p?.retailer),kind=p?.kind;
  if(!['card','email'].includes(kind))throw Error('Choose a card or email duplicate to fix.');
  const rows=await profiles.fieldSnapshot(a.scope,a.id),row=rows.find(x=>x.id===p?.profileId&&x.retailer===retailer);
  if(!row||row.sourceLinked||row.websiteAuthoritative||row.source==='website-linked-profile'||row.needsReview)
   throw Error('This is not an editable local profile; website-linked profiles must be updated at their source.');
  const peers=rows.filter(x=>x.id!==row.id&&x.retailer===retailer);
  if(!peers.some(x=>kind==='card'?C.payment(x.data).number===C.payment(row.data).number:C.email(x.email)===C.email(row.email)))
   throw Error('The duplicate no longer exists. Refresh the review.');
  let candidate=null;
  if(kind==='email'){
   const eligible=await profiles.libraryTransaction(a.scope,a.id,ctx=>{
    const used=new Set(ctx.rows.filter(x=>x.retailer===retailer).map(x=>C.email(x.email)));
    const unassigned=ctx.emails.filter(x=>x.retailer===retailer&&!x.profileId);
    const counts=new Map();for(const item of unassigned){const k=C.email(item.email);counts.set(k,(counts.get(k)||0)+1);}
    return unassigned.filter(x=>counts.get(C.email(x.email))===1&&!used.has(C.email(x.email)))
     .map(x=>({id:x.id,email:C.email(x.email)})).sort((x,y)=>x.email.localeCompare(y.email));
   },a.check);
   candidate=eligible[0];
   if(!candidate)throw Error('No unused unique email exists in this retailer pool. Add one before repairing.');
  }else{
   const vault=cardVault(a.scope),saved=await vault.list(cardKey(a.scope,a.id));
   const cards=(saved.cards||[]).length?await vault.selectedForJig(cardKey(a.scope,a.id),saved.cards.map(x=>x.id)):[];
   const settings=await profiles.librarySettings(a.scope,a.id);
   candidate=cards.filter(x=>{
    try{
     CardPolicy.checkAllocation(rows,retailer,[x.number],settings,{excludeProfileIds:[row.id]});
     return /^\d{12,19}$/.test(String(x.number||''))&&/^(0[1-9]|1[0-2])$/.test(x.month||x.expMonth||'')&&/^20\d\d$/.test(x.year||x.expYear||'');
    }catch{return false;}
   }).sort((x,y)=>String(x.number).localeCompare(String(y.number)))[0];
   if(!candidate)throw Error('No unused saved card is eligible under the Card Bank/Hard Card rules. Add an available card before repairing.');
  }
  a.check();const token=uuid();
  duplicateRepairPlans.set(token,{at:now(),sender:e.sender.id,epoch:ep(e),scope:a.scope,owner:a.id,
   retailer,kind,profileId:row.id,revision:row.revision||0,hash:require('./jig-field-core').hash(row),
   candidateId:candidate.id,candidateNumber:kind==='card'?candidate.number:null,candidateEmail:kind==='email'?candidate.email:null});
  return {token,kind,email:row.email,newEmail:kind==='email'?candidate.email:null,
   newCardLast4:kind==='card'?candidate.number.slice(-4):null};
 }
 async function duplicateRepairCommit(e,p){
  const plan=duplicateRepairPlans.get(p?.token);
  if(!plan||plan.sender!==e.sender.id||plan.epoch!==ep(e)||now()-plan.at>600000)
   throw Error('Duplicate repair preview expired. Reopen it.');
  if(p?.confirmed!==true)throw Error('Confirm the exact profile repair first.');
  const a=await access(e,{scope:plan.scope,customerId:plan.owner});
  let savedCard=null;
  if(plan.kind==='card'){
   const cards=await cardVault(a.scope).selectedForJig(cardKey(a.scope,a.id),[plan.candidateId]);
   savedCard=cards[0];
   if(!savedCard||CardPolicy.normalized(savedCard.number)!==plan.candidateNumber)
    throw Error('Card Bank selection changed; nothing was modified.');
  }
  const result=await profiles.libraryTransaction(a.scope,a.id,ctx=>{
   const row=ctx.rows.find(x=>x.id===plan.profileId&&x.retailer===plan.retailer);
   if(!row||row.revision!==plan.revision||require('./jig-field-core').hash(row)!==plan.hash)
    throw Error('Selected profile changed since preview. No changes made.');
   if(row.sourceLinked||row.websiteAuthoritative||row.source==='website-linked-profile'||row.needsReview)
    throw Error('This profile is website-linked or locked; do not change it locally.');
   const peers=ctx.rows.filter(x=>x.id!==row.id&&x.retailer===plan.retailer);
   if(!peers.some(x=>plan.kind==='card'?C.payment(x.data).number===C.payment(row.data).number:C.email(x.email)===C.email(row.email)))
    throw Error('Conflict changed; refresh before repairing.');
   if(plan.kind==='email'){
    const matches=ctx.emails.filter(x=>x.id===plan.candidateId&&x.retailer===plan.retailer&&!x.profileId&&C.email(x.email)===plan.candidateEmail);
    const others=ctx.emails.filter(x=>x.retailer===plan.retailer&&C.email(x.email)===plan.candidateEmail);
    if(matches.length!==1||others.length!==1||ctx.rows.some(x=>x.retailer===plan.retailer&&C.email(x.email)===plan.candidateEmail))
     throw Error('Unused email is no longer available; no changes made.');
   }else{
    CardPolicy.checkAllocation(ctx.rows,plan.retailer,[savedCard.number],ctx.settings,{excludeProfileIds:[row.id]});
   }
   ctx.archiveDuplicateRepair(row,plan.kind);
   if(plan.kind==='email'){
    const originalEmail=C.email(row.email);
    const remainingOwner=peers.find(x=>C.email(x.email)===originalEmail);
    row.data=D.manualEdit(row.data,{...C.values(row.data),email:plan.candidateEmail});row.email=plan.candidateEmail;
    // Original email still belongs to the other duplicate profile. Transfer
    // the prior email-bank reservation rather than making it falsely Unused.
    for(const x of ctx.emails)if(x.retailer===plan.retailer&&x.profileId===row.id){
     if(remainingOwner&&C.email(x.email)===originalEmail){x.profileId=remainingOwner.id;x.usedAt=now();}
     else{x.profileId=null;x.usedAt=null;}
    }
    const item=ctx.emails.find(x=>x.id===plan.candidateId);item.profileId=row.id;item.usedAt=now();
   }else{
    C.putCard(row.data,{number:savedCard.number,month:savedCard.month||savedCard.expMonth,
     year:savedCard.year||savedCard.expYear,cardholder:savedCard.cardholder||savedCard.holder||'Unassigned'});
   }
   row.revision=(row.revision||0)+1;
   ctx.audit('guided-duplicate-repair',row.email,{retailer:plan.retailer,kind:plan.kind,profileId:row.id});
   return {saved:true,kind:plan.kind,profileId:row.id,email:row.email,archivedOriginal:true};
  },a.check);
  duplicateRepairPlans.delete(p.token);
  return result;
 }
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
   entries.push({retailer,data,format:C.format(retailer),occurrence,expectedMatches:matches.map(x=>({id:x.id,hash:require('./jig-field-core').hash(x)})),storedMatches:matches.length});counts[retailer]=(counts[retailer]||0)+1;
  }
  const token=uuid();a.check();for(const [id,plan]of plans)if(now()-plan.at>600000)plans.delete(id);if(plans.size>30)throw Error('Close an older import preview first.');
  plans.set(token,{sender:e.sender.id,scope:a.scope,id:a.id,bank:'live',entries,fileNames:p.fileNames||[p.fileName],at:now(),epoch:ep(e)});
  const identities=new Set(entries.map(x=>x.retailer+'|'+x.data.email));
  const superseded=existing.filter(x=>identities.has(x.retailer+'|'+C.email(x.email)));
  const incomingRepeated=entries.length-identities.size;
  const blockedLinkedCount=superseded.filter(x=>x.sourceLinked||x.websiteAuthoritative||x.source==='website-linked-profile').length;
  return {token,bank:'live',count:entries.length,effectiveCount:identities.size,counts,
   supersedeLive:superseded.filter(x=>x.bank==='live').length,
   supersedeNonLive:superseded.filter(x=>x.bank!=='live').length,
   collapsedInImport:incomingRepeated,blockedLinkedCount,
   // Count each distinct retailer/email only once, even if repeated in file.
   matches:identities.size,duplicateCount:superseded.length+incomingRepeated,
   duplicateGroups:superseded.length,
   profiles:entries.map(x=>({email:x.data.email,retailer:x.retailer,
    duplicates:x.storedMatches>0||entries.filter(y=>y.retailer===x.retailer&&y.data.email===x.data.email).length>1?['email']:[]}))};
 }
 async function reconcileLivePreview(e,p){
  const a=await access(e,p),retailer=C.retailer(p?.retailer);
  const rows=await profiles.fieldSnapshot(a.scope,a.id);
  a.check();
  const review=C.existingLiveReconciliation(rows,retailer),token=uuid();
  for(const [id,item] of reconciliationPlans)if(now()-item.at>600000)reconciliationPlans.delete(id);
  reconciliationPlans.set(token,{sender:e.sender.id,epoch:ep(e),at:now(),
   scope:a.scope,id:a.id,retailer,signature:review.signature});
  // Return only account identity, masked card suffixes and counts. Never
  // return full card numbers or independent code values to this dialog.
  return {...review,signature:undefined,token};
 }
 async function reconcileLiveCommit(e,p){
  const plan=reconciliationPlans.get(p?.token);
  if(!plan||plan.sender!==e.sender.id||plan.epoch!==ep(e)||now()-plan.at>600000)
   throw Error('Live reconciliation preview expired. Preview again.');
  const a=await access(e,{scope:plan.scope,customerId:plan.id});
  if(p.confirmed!==true)throw Error('Confirm your reviewed Live matches before retiring older profiles.');
  if(!cardVault)throw Error('Encrypted Card Bank is unavailable. No profiles were changed.');
  if(!Array.isArray(p.selectedIds)||!p.selectedIds.length)throw Error('Select matching non-Live profiles to reconcile.');
  const check=()=>{a.check();if(reconciliationPlans.get(p.token)!==plan)throw Error('Reconciliation was cancelled or already saved.');};
  const result=await profiles.reconcileExistingLiveProfiles(
   a.scope,a.id,plan.retailer,p.selectedIds,plan.signature,check,
   (displaced,incoming)=>require('./live-import-card-preservation').preserveRetiredCards({
    displaced,incoming,vault:cardVault(a.scope),key:cardKey(a.scope,a.id),check
   })
  );
  reconciliationPlans.delete(p.token);return result;
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
  if(options.card&&(flags.includes('card')||options.all)){
   const staged=ctx.rows.concat(added.map((data,i)=>({id:'pending-card-'+i,retailer,data})));
   const card=cards.find(c=>{
    if(c.previouslyAssigned&&!CardPolicy.hardCard(c.number,ctx.settings))return false;
    try{CardPolicy.checkAllocation(staged,retailer,[c.number],ctx.settings);return true;}catch{return false;}
   });
   if(!card)throw Error('Not enough retailer-eligible unused or Hard Cards in this exact vault.');
   C.putCard(row,card);
  }
  const after=C.collisions([row],seen,retailer)[0];if(after.includes('email'))throw Error('Duplicate email remains. Select Replace duplicate emails.');if(after.length&&!options.allowShared)throw Error('Duplicate name or card remains. Repair it or explicitly allow shared names/cards.');
  if(!C.values(row).email)throw Error('A profile email is missing.');usedEmails.add(C.email(row.email));usedNames.add(C.nameKey(row));seen.push({retailer,data:row});added.push(row);
 }return added;}
 async function importCommit(e,p){const plan=plans.get(p.token);if(!plan||plan.sender!==e.sender.id||now()-plan.at>600000||plan.epoch!==ep(e))throw Error('Import preview expired. Preview again.');const a=await access(e,{scope:plan.scope,customerId:plan.id});if(p.confirmed!==true)throw Error('Review the import first.');if(plan.bank==='live'){const result=await profiles.importLiveProfiles(a.scope,a.id,plan.entries,{updateExisting:p.updateExisting===true,batchId:uuid(),fileNames:plan.fileNames||[]},()=>{a.check();if(plans.get(p.token)!==plan)throw Error('Import was already saved.');},
 async(displaced,incoming)=>{
  a.check();
  if(plans.get(p.token)!==plan)throw Error('Live import was cancelled before card preservation.');
  if(!cardVault)throw Error('Saved Card Bank is unavailable. No Ready/Unused profiles were removed.');
  return require('./live-import-card-preservation').preserveRetiredCards({
   displaced,incoming,vault:cardVault(a.scope),key:cardKey(a.scope,a.id),
   check:()=>{a.check();if(plans.get(p.token)!==plan)throw Error('Live import cancelled while preserving prior cards.');}
  });
 });plans.delete(p.token);return result;}return withCards(a,p.cardIds||[],cards=>profiles.libraryTransaction(a.scope,a.id,ctx=>{if(plans.get(p.token)!==plan)throw Error('Import was already saved.');const data=resolve(plan.data,plan.retailer,ctx,p.repairs||{},cards),importBatchId=uuid(),customerLabel=profileOwnerLabel(p.customerName||p.group),existingCustomerCount=ctx.rows.filter(x=>x.source==='owner-created-profile').length,added=data.map((row,index)=>{const id=uuid(),email=C.email(row.email),label=a.scope==='personal'?email:customerLabel+' '+(existingCustomerCount+index+1),named=C.syncCardholderToProfile(D.manualEdit(row,{...D.toValues(row),label})),entry={id,retailer:plan.retailer,email,label,group:a.scope==='personal'?plan.retailer:customerLabel,source:'owner-created-profile',importBatchId,status:p.asAvailable===true?'available':'active',jiggedAt:p.alreadyJigged?new Date(now()).toISOString():null,createdAt:new Date(now()).toISOString(),revision:0,data:named,format:C.format(plan.retailer),assetRefs:{}};for(const bank of ctx.emails)if(bank.retailer===plan.retailer&&bank.email===email&&(!bank.profileId||String(bank.profileId).startsWith('pending-')))bank.profileId=id;ctx.rows.push(entry);ctx.audit('library-import',email,{retailer:plan.retailer});return entry;});ctx.importBatches.push({id:importBatchId,at:new Date(now()).toISOString(),bank:'working',retailers:[plan.retailer],fileNames:[plan.fileName||'import'],createdIds:added.map(x=>x.id),imported:added.length,updatedExisting:0,removedAt:null});plans.delete(p.token);return {imported:added.length,batchId:importBatchId};},a.check));}
 async function repair(e,p){const a=await access(e,p);return withCards(a,p.cardIds||[],cards=>profiles.libraryTransaction(a.scope,a.id,async ctx=>{
  const row=ctx.rows.find(x=>x.id===p.profileId);if(!row||row.revision!==p.revision)throw Error('Profile changed. Reopen it.');
  const linked=a.scope==='aco'&&row.source==='website-linked-profile'&&row.sourceLinked===true;
  if(row.needsReview)throw Error('Resolve the website conflict before repairing this profile.');
  if(linked&&p.repairs?.email)throw Error('Replace the linked retailer account from its unused account bank; do not change its login email locally.');
  const peers=ctx.rows.filter(x=>x.id!==row.id),target={...ctx,rows:peers};const [data]=resolve([row.data],row.retailer,target,{...p.repairs,all:true,allowShared:true},cards);
  const nextCard=CardPolicy.fromProfile({data});
  if(nextCard&&nextCard!==CardPolicy.fromProfile(row))CardPolicy.checkAllocation(ctx.rows,row.retailer,[nextCard],ctx.settings,{excludeProfileIds:[row.id]});
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
   // Ordinary profile, card and address changes NEVER authorize reference edits.
   const storedCode=C.profileCode(row.data);
   const requestedCode=p.profileSecurityCode!==undefined?p.profileSecurityCode:p.cardCvv;
   const changesCode=requestedCode!==undefined&&requestedCode!==storedCode;
   if(changesCode&&p.confirmSecurityCodeChange!==true)
    throw Error('Security Code edit requires an explicit separate confirmation. No data was changed.');

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
   // Enforce the Hard Card cap even if the card was typed directly into
   // a profile editor rather than selected from the saved-card bank.
   if(CardPolicy.fromProfile({data})!==CardPolicy.fromProfile(row)){
    const number=CardPolicy.fromProfile({data});
    if(number)CardPolicy.checkAllocation(ctx.rows,row.retailer,[number],ctx.settings,{excludeProfileIds:[row.id]});
   }
   if(p.cardCvv!==undefined){
    if(a.scope!=='personal')throw Error('Legacy card-code input is limited to your unlocked Personal vault; customer Security Codes use the separate profile field.');
    // Backward-compatible editor input: historically named "cardCvv" even
    // when it represented the separate profile Security Code. Treat it as
    // a profile-only reference and NEVER clear legacy saved fields.
    if(typeof p.cardCvv!=='string'||p.cardCvv.length>100||/[\x00-\x1f\x7f]/.test(p.cardCvv))
      throw Error('Invalid profile Security Code.');
    if(p.profileSecurityCode===undefined) data.profileSecurityCode=p.cardCvv;
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
   // Only this authenticated, version-checked profile-code editor may
   // explicitly change an existing independent non-payment reference.
   // A card/address edit, bulk jig, or re-import does not authorize it.
   if(changesCode)ctx.allowIndependentReferenceEdit(row.id);
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
 async function recoverCodesFromSavedCards(e,p){
  const a=await access(e,p);
  if(p.confirmed===true){
   const plan=codeRestorePlans.get(String(p.token||''));
   if(!plan||plan.kind!=='saved-card-bank'||plan.scope!==a.scope||plan.id!==a.id||
    plan.sender!==e.sender.id||plan.epoch!==ep(e)||now()-plan.at>600000)
    throw Error('Saved Card Bank recovery preview expired. Review again.');
   codeRestorePlans.delete(p.token);
   // Re-check the source Card Bank before modifying any profile.
   const full=await cardVault(a.scope).securityReferences(cardKey(a.scope,a.id));
   const currentCodes=new Map(full.map(card=>[CardPolicy.normalized(card.number),String(card.customSecurityCode||card.customCode||'')]));
   for(const [id,item]of plan.matches)
    if(currentCodes.get(item.number)!==item.code)throw Error('Saved Card Bank changed. Review again.');
   return profiles.libraryTransaction(a.scope,a.id,ctx=>{
    for(const [id,item]of plan.matches){
     const row=ctx.rows.find(row=>row.id===id);
     if(!row||row.retailer!==item.retailer||row.email!==item.email||(row.revision||0)!==item.revision||
       C.profileCode(row.data)||C.payment(row.data).number!==item.number)
      throw Error('A matching profile changed. Nothing was restored.');
    }
    for(const [id,item]of plan.matches){
     const row=ctx.rows.find(row=>row.id===id);
     row.data.profileSecurityCode=item.code;
     row.revision=(row.revision||0)+1;
     ctx.audit('security-code-saved-card-recovery',row.email,{retailer:row.retailer});
    }
    return {restored:plan.matches.size,stillMissing:plan.stillMissing,source:'saved-card-bank'};
   },a.check);
  }
  const full=await cardVault(a.scope).securityReferences(cardKey(a.scope,a.id));
  const codes=new Map(),conflicts=new Set();
  for(const card of full){
   const number=CardPolicy.normalized(card.number),code=String(card.customSecurityCode||card.customCode||'');
   if(!number||!code||code.length>100||/[\x00-\x1f\x7f]/.test(code))continue;
   if(codes.has(number)&&codes.get(number)!==code)conflicts.add(number);
   else codes.set(number,code);
  }
  const rows=await profiles.fieldSnapshot(a.scope,a.id),missing=rows.filter(row=>!C.profileCode(row.data)),matches=new Map();
  for(const row of missing){
   const number=C.payment(row.data).number;
   if(!number||conflicts.has(number)||!codes.has(number))continue;
   matches.set(row.id,{number,code:codes.get(number),revision:row.revision||0,email:row.email,retailer:row.retailer});
  }
  a.check();
  const token=uuid();
  codeRestorePlans.set(token,{kind:'saved-card-bank',scope:a.scope,id:a.id,sender:e.sender.id,epoch:ep(e),at:now(),matches,stillMissing:missing.length-matches.size});
  if(codeRestorePlans.size>20)codeRestorePlans.delete(codeRestorePlans.keys().next().value);
  const byRetailer={};
  for(const item of matches.values())byRetailer[item.retailer]=(byRetailer[item.retailer]||0)+1;
  return {preview:true,token,recoverable:matches.size,stillMissing:missing.length-matches.size,byRetailer,conflictingCardCodes:conflicts.size};
 }
 async function recoverCodesFromFile(e,p){
  const a=await access(e,p);
  C.retailer(p.retailer);
  if(p.confirmed===true){
   const plan=codeRestorePlans.get(String(p.token||''));
   if(!plan||plan.scope!==a.scope||plan.id!==a.id||plan.sender!==e.sender.id||
    plan.epoch!==ep(e)||now()-plan.at>600000||plan.independentOnly!==(p.independentOnly===true))throw Error('Code recovery preview expired or mode changed. Choose the file again.');
   codeRestorePlans.delete(p.token);
   return profiles.libraryTransaction(a.scope,a.id,ctx=>{
    const chosen=plan.matches;
    for(const [id,item] of chosen){
     const row=ctx.rows.find(row=>row.id===id);
     if(!row||row.retailer!==item.retailer||row.email!==item.email||(row.revision||0)!==item.revision||
       C.profileCode(row.data)||!/^[0-9]{12,19}$/.test(item.cardNumber)||C.payment(row.data).number!==item.cardNumber)throw Error('A profile or complete card identity changed. Nothing was restored.');
    }
    for(const [id,item]of chosen){
     const row=ctx.rows.find(row=>row.id===id);
     row.data.profileSecurityCode=item.code;
     row.revision=(row.revision||0)+1;
     ctx.audit('security-code-import-recovery',row.email,{retailer:row.retailer});
    }
    return {restored:chosen.size,source:'original-import',stillMissing:plan.stillMissing};
   },a.check);
  }
  if(typeof p.fileName!=='string'||p.fileName!==path.basename(p.fileName)||
    !/\.(csv|json|txt|tsv)$/i.test(p.fileName)||typeof p.text!=='string'||Buffer.byteLength(p.text)>26*1024*1024)
   throw Error('Choose the original CSV, TSV, JSON or TXT file (under 26 MB).');
  const parsed=Core.parseFile(p.fileName,p.text);
  if(!parsed.records?.length||parsed.records.length>10000)throw Error('Original file must contain 1-10,000 profiles.');
  const current=await profiles.fieldSnapshot(a.scope,a.id),missing=current.filter(row=>!C.profileCode(row.data));
  const byIdentity=new Map();
  for(const row of missing){
   const key=row.retailer+'|'+C.email(row.email);
   if(!byIdentity.has(key))byIdentity.set(key,[]);
   byIdentity.get(key).push(row);
  }
  const matches=new Map(),ambiguous=new Set(),diagnostics={parsed:parsed.records.length,missing:missing.length,withCode:0,withEmail:0,identityMatches:0,cardMismatches:0};
  const codeOf=raw=>{
   const fields=[raw.profileSecurityCode,raw.security_code,raw.custom_security_code,raw.card?.custom_security_code,
    ...(p.independentOnly===true?[]:[raw.cc_cvv,raw.cvv,raw.CVV,raw.cvc,raw.card?.cvv,raw.card?.cvc,raw.card?.cid])];
   const value=fields.find(x=>typeof x==='string'&&x.length>0&&x.length<=100&&!/[\x00-\x1f\x7f]/.test(x));
   return value||'';
  };
  for(const raw of parsed.records){
   if(!raw||typeof raw!=='object')continue;
   if(raw.scope&&raw.scope!==a.scope||raw.customerId&&raw.customerId!==a.id||raw.acoCustomerId&&raw.acoCustomerId!==a.id)
    throw Error('Original import contains data assigned to another vault.');
   const retailer=detectedRetailer(raw.retailer||raw.retailerId||raw.site||raw.store)||p.retailer;
   if(retailer!==p.retailer)continue;
   const email=C.email(C.values(raw).email||raw.email||raw.loginEmail||raw.accountEmail||raw.login_email||raw?.account?.email);
   const code=codeOf(raw),candidates=byIdentity.get(retailer+'|'+email)||[];
   if(code)diagnostics.withCode++;if(email)diagnostics.withEmail++;if(candidates.length===1)diagnostics.identityMatches++;
   if(!code||!email||candidates.length!==1)continue;
   const row=candidates[0];
   if(!C.exactFullCardMatch(raw,row.data)){
    // Missing or different complete card number is NOT a valid match.
    diagnostics.cardMismatches++;continue;
   }
   if(ambiguous.has(row.id))continue;
   if(matches.has(row.id)&&matches.get(row.id).code!==code){ambiguous.add(row.id);matches.delete(row.id);continue;}
   matches.set(row.id,{code,revision:row.revision||0,retailer:row.retailer,email:row.email,cardNumber:C.payment(row.data).number});
  }
  for(const id of ambiguous)matches.delete(id);
  const token=uuid();
  codeRestorePlans.set(token,{scope:a.scope,id:a.id,sender:e.sender.id,epoch:ep(e),at:now(),independentOnly:p.independentOnly===true,matches,stillMissing:missing.length-matches.size});
  if(codeRestorePlans.size>20)codeRestorePlans.delete(codeRestorePlans.keys().next().value);
  a.check();
  return {preview:true,token,recoverable:matches.size,stillMissing:missing.length-matches.size,ambiguous:ambiguous.size,diagnostics};
 }
 async function recoverCodes(e,p){
  const a=await access(e,p);
  return profiles.codeRecovery(a.scope,a.id,{confirmed:p?.confirmed===true,token:p?.token||null,independentOnly:p?.independentOnly===true},a.check);
 }
 // One owner-authorized, read-only review across existing recovery sources.
 // This endpoint never restores anything or returns a Security Code value.
 // The three existing restore actions remain separate and confirmation-gated.
 async function recoveryReview(e,p){
  if(p?.confirmed===true||p?.token)throw Error('Recovery review is read-only. Use a separate confirmed restore action.');
  const a=await access(e,p);
  const rows=await profiles.fieldSnapshot(a.scope,a.id);
  const missing=rows.filter(row=>!C.profileCode(row.data)).length;
  a.check();
  const [snapshots,savedBank]=await Promise.all([
   recoverCodes(e,{scope:a.scope,customerId:a.id,confirmed:false,independentOnly:true}),
   recoverCodesFromSavedCards(e,{scope:a.scope,customerId:a.id,confirmed:false})
  ]);
  let originalFile=null;
  if(p?.fileName!==undefined||p?.text!==undefined){
   if(typeof p.fileName!=='string'||typeof p.text!=='string')throw Error('Choose a complete original file to review.');
   C.retailer(p.retailer);
   const preview=await recoverCodesFromFile(e,{scope:a.scope,customerId:a.id,retailer:p.retailer,
    fileName:p.fileName,text:p.text,confirmed:false,independentOnly:true});
   originalFile={
    name:path.basename(p.fileName),retailer:p.retailer,
    scannedRecords:preview.diagnostics?.parsed||0,
    potentialMatches:preview.recoverable||0,
    ambiguous:preview.ambiguous||0,
    cardMismatches:preview.diagnostics?.cardMismatches||0,
    withSourceReference:preview.diagnostics?.withCode||0
   };
  }
  // Optional user-selected original files are analyzed together, across all
  // retailers, instead of scanning one file for the currently selected tab.
  // Do not persist files, expose source reference values, or accept CVV aliases.
  let originalFiles=null;
  if(p?.files!==undefined){
   if(!Array.isArray(p.files)||p.files.length<1||p.files.length>20)
    throw Error('Select 1-20 original import files.');
   const eligible=rows.filter(row=>!C.profileCode(row.data));
   const byIdentity=new Map(),byEmail=new Map();
   for(const row of eligible){
    const email=C.email(row.email),key=row.retailer+'|'+email;
    if(!byIdentity.has(key))byIdentity.set(key,[]);
    byIdentity.get(key).push(row);
    if(!byEmail.has(email))byEmail.set(email,[]);
    byEmail.get(email).push(row);
   }
   let totalBytes=0,scannedRecords=0,cardMismatches=0,withSourceReference=0,uncertainRetailer=0;
   let legacyFieldPopulatedRows=0,legacyOnlyPopulatedRows=0,legacyIdentityCardMismatches=0;
   const legacyIdentityMatches=new Set(),matches=new Map(),ambiguous=new Set();
   // Only inspect whether a legacy CVV-named column is populated. Never return,
   // copy, store, hash, or recover its contents. The field name alone cannot
   // establish that it holds a non-payment reference rather than a card verifier.
   const hasLegacyValue=(raw,source)=>[raw,source,raw?.card,source?.card].some(parent=>
    parent&&typeof parent==='object'&&!Array.isArray(parent)&&Object.entries(parent).some(([key,value])=>
     /^(?:cvv|cc_cvv|cvc|cid|cvv2|cvc2)$/i.test(key)&&typeof value==='string'&&value.length>0));
   for(const file of p.files){
    if(!file||typeof file.fileName!=='string'||file.fileName!==path.basename(file.fileName)||
      !/\.(csv|json|txt|tsv)$/i.test(file.fileName)||typeof file.text!=='string')
     throw Error('Original imports must be CSV, JSON, TSV or TXT files.');
    totalBytes+=Buffer.byteLength(file.text);
    if(totalBytes>26*1024*1024)throw Error('Original files exceed the 26 MB recovery review limit.');
    const parsed=Core.parseFile(file.fileName,file.text);
    if(!Array.isArray(parsed.records)||!parsed.records.length||parsed.records.length>10000)
     throw Error('Every selected file must contain 1-10,000 profile records.');
    scannedRecords+=parsed.records.length;
    if(scannedRecords>30000)throw Error('Select at most 30,000 records per recovery review.');
    const filenameRetailer=detectedRetailer(file.fileName);
    for(const raw of parsed.records){
     if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
     if(raw.scope&&raw.scope!==a.scope||
       raw.customerId&&raw.customerId!==a.id||
       raw.acoCustomerId&&raw.acoCustomerId!==a.id)
      throw Error('An original file contains records for another vault. Nothing was changed.');
     const source=raw.data&&typeof raw.data==='object'&&!Array.isArray(raw.data)?raw.data:raw;
     const fields=[raw.profileSecurityCode,raw.security_code,raw.custom_security_code,raw.card?.custom_security_code,
      source.profileSecurityCode,source.security_code,source.custom_security_code,source.card?.custom_security_code];
     const code=fields.find(v=>typeof v==='string'&&v.length>0&&v.length<=100&&!/[\x00-\x1f\x7f]/.test(v))||'';
     const legacyPopulated=hasLegacyValue(raw,source);
     if(legacyPopulated){legacyFieldPopulatedRows++;if(!code)legacyOnlyPopulatedRows++;}
     if(code)withSourceReference++;
     // Compute identity for metadata-only legacy-field diagnostics even when
     // an independently named reference is absent.
     const email=C.email(C.values(source).email||raw.email||source.email||raw.loginEmail||source.loginEmail||
      raw.accountEmail||source.accountEmail||raw.login_email||source.login_email||raw.account?.email);
     if(!email)continue;
     const retail=detectedRetailer(raw.retailer||raw.retailerId||raw.site||raw.store||
      source.retailer||source.retailerId||source.site||source.store)||filenameRetailer;
     const candidates=retail?(byIdentity.get(retail+'|'+email)||[]):(byEmail.get(email)||[]);
     if(candidates.length!==1){if(code&&candidates.length>1)uncertainRetailer++;continue;}
     const row=candidates[0];
     if(!C.exactFullCardMatch(source,row.data)){
      // Record an identity conflict rather than assigning an unmatched source.
      // Card digits and legacy field contents never leave the main process.
      if(legacyPopulated)legacyIdentityCardMismatches++;
      if(code)cardMismatches++;
      continue;
     }
     if(legacyPopulated)legacyIdentityMatches.add(row.id);
     if(!code)continue;
     if(ambiguous.has(row.id))continue;
     const previous=matches.get(row.id);
     if(previous&&previous!==code){ambiguous.add(row.id);matches.delete(row.id);}
     else matches.set(row.id,code);
    }
   }
   originalFiles={scanned:p.files.length,scannedRecords,potentialMatches:matches.size,
    ambiguous:ambiguous.size+uncertainRetailer,cardMismatches,withSourceReference,
    withoutIndependentReference:scannedRecords-withSourceReference,
    legacyFieldPopulatedRows,legacyOnlyPopulatedRows,
    legacyIdentityMatches:legacyIdentityMatches.size,legacyIdentityCardMismatches,
    legacyFieldsMetadataOnly:true};
  }
  const historicSources=typeof profiles.historicSourceReview==='function'
   ?await profiles.historicSourceReview(a.scope,a.id,a.check)
   :{found:0,readable:0,unreadable:0,oversized:0,skipped:0,matched:0,conflicting:0,cardHistoryFiles:0,unavailable:true};
  const recordedImports=await profiles.importHistory(a.scope,a.id);
  const importInventory={batches:recordedImports.length,
   recordedFilenames:new Set(recordedImports.flatMap(batch=>batch.fileNames||[]).filter(name=>typeof name==='string')).size,
   contentsStoredInHistory:false};
  a.check();
  return {
   readOnly:true,scope:a.scope,totalProfiles:rows.length,missingProfiles:missing,
   backups:{scanned:snapshots.scannedBackups||0,unreadable:snapshots.unreadableBackups||0,
    potentialMatches:snapshots.recoverable||0,conflicts:snapshots.conflicts||0,byRetailer:snapshots.byRetailer||{}},
   savedCardBank:{potentialMatches:savedBank.recoverable||0,
    conflictingCards:savedBank.conflictingCardCodes||0,byRetailer:savedBank.byRetailer||{}},
   originalFile,originalFiles,historicSources,importInventory,
   overlappingSourcesPossible:true,
   notice:'Source matches can refer to the same profile. Do not add the counts. No saved record has been changed.'
  };
 }
 // The renderer never supplies a filesystem path. This OS-native folder picker
 // is explicitly initiated by the owner and the scan reads metadata only.
 // Original import selection uses the same trusted native macOS file dialog
 // as the working historical folder picker. File paths and unredacted file
 // contents stay in this privileged process and are NEVER sent to the renderer.
 async function recoveryReviewSelectedFiles(e,p){
  const a=await access(e,p);
  if(p?.confirmed||p?.token||p?.files||p?.filePath||p?.path||p?.directory||p?.text)
   throw Error('Choose original files with the trusted Mac file picker.');
  if(typeof chooseOriginalFiles!=='function')
   throw Error('Native original-file selection is not available.');
  const selections=await chooseOriginalFiles(e);
  a.check();
  if(selections==null||Array.isArray(selections)&&!selections.length){
   const report=await recoveryReview(e,{scope:a.scope,customerId:a.id});
   return {...report,originalSelectionCancelled:true};
  }
  if(!Array.isArray(selections)||selections.length>20)
   throw Error('Select no more than 20 original import files.');
  const fs=require('node:fs/promises');
  let total=0;
  const files=[];
  for(const originalPath of selections){
   if(typeof originalPath!=='string'||!path.isAbsolute(originalPath)||
      !/\.(csv|json|txt|tsv)$/i.test(originalPath))
    throw Error('Select original CSV, JSON, TXT or TSV files.');
   const stat=await fs.lstat(originalPath);
   if(!stat.isFile()||stat.isSymbolicLink())throw Error('A selected file is not a regular file.');
   total+=stat.size;
   if(total>26*1024*1024)throw Error('Selected files exceed the 26 MB review limit.');
   a.check();
   const content=await fs.readFile(originalPath,'utf8');
   files.push({fileName:path.basename(originalPath),text:content});
  }
  const report=await recoveryReview(e,{scope:a.scope,customerId:a.id,files});
  a.check();
  return {...report,originalSelectionCancelled:false};
 }
 async function historicalFolderReview(e,p){
  const a=await access(e,p);
  if(p?.confirmed||p?.path||p?.directory||p?.filePath)
   throw Error('Choose a historical folder using the trusted Mac picker.');
  if(typeof chooseHistoricalFolder!=='function')
   throw Error('Historical folder selection is not available in this app.');
  const selected=await chooseHistoricalFolder(e);
  a.check();
  if(!selected){
   if(p?.scanOriginals===true){
    const report=await recoveryReview(e,{scope:a.scope,customerId:a.id});
    return {...report,selectedFolder:{cancelled:true},folderOriginalScan:{candidates:0,scanned:0,cancelled:true}};
   }
   return {cancelled:true,readOnly:true};
  }
  const history=require('./historical-file-inventory');
  const result=await history.inventoryFolder(selected,{check:a.check,now});
  a.check();
  if(p?.scanOriginals!==true)return result;
  // A selected folder is an explicit grant to examine originals for *independent*
  // non-payment profile references. The scan never returns sensitive file data.
  const {files,stats}=await history.collectOriginalFiles(selected,{check:a.check,now,
   validate:(fileName,contents)=>{
    const parsed=Core.parseFile(fileName,contents);
    if(!Array.isArray(parsed.records)||!parsed.records.length||parsed.records.length>10000)return false;
    for(const raw of parsed.records){
     if(!raw||typeof raw!=='object')continue;
     if(raw.scope&&raw.scope!==a.scope||raw.customerId&&raw.customerId!==a.id||
       raw.acoCustomerId&&raw.acoCustomerId!==a.id)return false;
    }
    return true;
   }});
  a.check();
  const report=await recoveryReview(e,{scope:a.scope,customerId:a.id,...(files.length?{files}:{})});
  a.check();
  return {...report,selectedFolder:result,folderOriginalScan:stats};
 }
 // Only the exact retailer + authenticated vault is considered. Shared addresses
 // are never duplicates. Shared full cards are optional because hard-card reuse
 // may be deliberate. This preview is read-only.
 function uniqueExportSelection(all,retailer,stage,mode){
  if(!['new','completed','live'].includes(stage))throw Error('Choose New, Ready for Export or Live profiles.');
  if(!['email','email-card'].includes(mode))throw Error('Choose how to identify duplicate accounts.');
  const scoped=all.filter(row=>row.retailer===retailer);
  const isNew=row=>row.needsFirstExport===true;
  const chosen=row=>stage==='live'?row.bank==='live':
   row.bank!=='live'&&Completion.inspect(row).ready&&(stage==='new'?isNew(row):!isNew(row));
  const candidates=scoped.filter(chosen);
  const email=row=>C.email(row.email||C.values(row.data).email);
  const number=row=>C.payment(row.data).number;
  const seenEmails=new Set(),seenCards=new Set();
  // Accounts already in the other retailer sub-tabs must not be exported twice.
  for(const row of scoped.filter(row=>!chosen(row))){
   const e=email(row),n=number(row);
   if(e)seenEmails.add(e);
   if(mode==='email-card'&&/^\d{12,19}$/.test(n))seenCards.add(n);
  }
  const kept=[];let sameEmail=0,sameCard=0;
  for(const row of candidates){
   const e=email(row),n=number(row),cardValid=/^\d{12,19}$/.test(n);
   if(e&&seenEmails.has(e)){sameEmail++;continue;}
   if(mode==='email-card'&&cardValid&&seenCards.has(n)){sameCard++;continue;}
   kept.push(row);
   if(e)seenEmails.add(e);
   if(mode==='email-card'&&cardValid)seenCards.add(n);
  }
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(scoped.map(row=>
   [row.id,require('./jig-field-core').hash(row),row.needsFirstExport,row.exportedAt]))).digest('hex');
  return {rows:kept,scanned:candidates.length,skippedDuplicates:candidates.length-kept.length,
   skippedEmail:sameEmail,skippedCard:sameCard,fingerprint};
 }
 // Export-only code resolution; this function never writes to encrypted vaults.
 async function reviewSecurityCodeExport(a,rows){
  const saved=cardVault?await cardVault(a.scope).securityReferences(cardKey(a.scope,a.id)):[];
  a.check();
  const byCard=new Map(),ambiguous=new Set();
  for(const card of saved){
   const number=CardPolicy.normalized(card.number),code=String(card.customSecurityCode||card.customCode||'');
   if(!number||!code)continue;
   if(code.length>100||/[\x00-\x1f\x7f]/.test(code))throw Error('Invalid saved card reference. Export blocked; vault unchanged.');
   if(byCard.has(number)&&byCard.get(number)!==code)ambiguous.add(number);
   else byCard.set(number,code);
  }
  const output=[],issues=[];
  for(const row of rows){
   const number=CardPolicy.normalized(C.payment(row.data).number);
   const profileCode=C.profileCode(row.data);
   const bankCode=number?byCard.get(number)||'':'';
   if((number&&ambiguous.has(number))||(profileCode&&bankCode&&profileCode!==bankCode)){
   issues.push({profileId:row.id,email:row.email,cardLast4:number.slice(-4),reason:'conflicting'});continue;
  }
   const code=profileCode||bankCode;
   if(!code){issues.push({profileId:row.id,email:row.email,cardLast4:number.slice(-4),reason:'missing'});continue;}
   if(code.length>100||/[\x00-\x1f\x7f]/.test(code))throw Error('Invalid profile Security Code. Export blocked; vault unchanged.');
   // Only a temporary shallow data copy receives a resolved code.
   output.push({...row,data:{...row.data,profileSecurityCode:code}});
  }
  return {readyRows:output,issues};
 }
 async function prepareSecurityCodeExport(a,rows){
  const result=await reviewSecurityCodeExport(a,rows);
  const missing=result.issues.filter(item=>item.reason==='missing').length;
  const conflicting=result.issues.filter(item=>item.reason==='conflicting').length;
  if(missing||conflicting)throw Error('Export BLOCKED: '+missing+' missing and '+conflicting+' conflicting Security Code(s). No file was saved and no stored codes changed. Review the affected profiles or use the explicit complete-only export option.');
  return result.readyRows;
 }
 function securityCodeExportSignature(rows){
  return crypto.createHash('sha256').update(JSON.stringify(rows.map(row=>[row.id,CardPolicy.normalized(C.payment(row.data).number),C.profileCode(row.data)]))).digest('hex');
 }
 async function verifiedExportCustomerName(a,p){
  if(a.scope==='personal')return 'Personal';
  let canonical='';
  if(typeof getCustomerProfileSource==='function'){
   const source=await getCustomerProfileSource(a.id);
   a.check();
   if(source?.customer?.id!==a.id)throw Error('Customer signup identity does not match the authorized vault.');
   const customer=source.customer;
   canonical=String(customer?.name||customer?.fullName||customer?.displayName||
    [customer?.firstName,customer?.lastName].filter(Boolean).join(' ')||'').trim();
  }
  // Legacy owner customer picker may still supply the signup display name.
  // Never export internal IDs, "Customer", or "Personal" as profile names.
  const supplied=String(p?.customerName||'').trim();
  const actual=canonical&&canonical!==String(a.id)?canonical:supplied;
  if(!actual||actual===String(a.id)||['personal','customer'].includes(actual.toLowerCase()))
   throw Error('The customer signup name is missing. Select that customer again before exporting.');
  return actual;
 }
 async function exportFile(e,p){
  const a=await access(e,p),retailer=C.retailer(p?.retailer),unique=p?.exportAllUnique===true;
  const before=await profiles.fieldSnapshot(a.scope,a.id);
  let rows,selection;
  if(unique){
   if(Array.isArray(p.profileIds)&&p.profileIds.length)throw Error('Export all does not accept a page selection.');
   selection=uniqueExportSelection(before,retailer,p.exportStage,p.duplicateMode||'email-card');
   if(p.previewOnly===true){
    a.check();return {preview:true,count:selection.rows.length,scanned:selection.scanned,
     skippedDuplicates:selection.skippedDuplicates,skippedEmail:selection.skippedEmail,
     skippedCard:selection.skippedCard,fingerprint:selection.fingerprint};
   }
   if(p.diagnoseOnly!==true&&(p.confirmedUniqueExport!==true||p.expectedFingerprint!==selection.fingerprint))
    throw Error('Duplicate export preview expired. Review the counts again.');
   rows=selection.rows;
  }else{
   if(!Array.isArray(p.profileIds)||!p.profileIds.length||p.profileIds.length>500||
     new Set(p.profileIds).size!==p.profileIds.length)throw Error('Select 1-500 profiles.');
   rows=p.profileIds.map(id=>before.find(x=>x.id===id&&x.retailer===retailer));
   if(rows.some(x=>!x))throw Error('Every exported profile must still belong to this vault and retailer.');
  }
  if(!rows.length)throw Error('No eligible profiles remain to export.');
  if(p.diagnoseOnly===true){
   const result=await reviewSecurityCodeExport(a,rows);
   a.check();
   return {diagnostics:true,selected:rows.length,ready:result.readyRows.length,
    missing:result.issues.filter(item=>item.reason==='missing').length,
    conflicting:result.issues.filter(item=>item.reason==='conflicting').length,
    issues:result.issues,readyProfileIds:result.readyRows.map(row=>row.id)};
  }
  const exportRows=await prepareSecurityCodeExport(a,rows);
  const signature=securityCodeExportSignature(exportRows);
  const exportOwner=await verifiedExportCustomerName(a,p);
  const content=C.exportSelectedRows(exportRows,retailer,exportOwner,p.exportFormat||'retailer',a.scope);
  if(unique)content.name=content.name.replace(/(\.[^.]+)$/,' - no duplicates$1');
  if(!await confirmExport(e))return {cancelled:true};
  const ext=path.extname(content.name),choice=await chooseSave(e,{name:content.name,extension:ext.slice(1)});
  if(choice.canceled||!choice.filePath)return {cancelled:true};
  if(path.extname(choice.filePath)!==ext)throw Error('Keep the selected export file extension.');
  const latest=await profiles.fieldSnapshot(a.scope,a.id);
  if(unique&&uniqueExportSelection(latest,retailer,p.exportStage,p.duplicateMode||'email-card').fingerprint!==selection.fingerprint)
   throw Error('Profiles changed during duplicate-safe export. Preview again.');
  if(rows.some(x=>require('./jig-field-core').hash(x)!==
    require('./jig-field-core').hash(latest.find(y=>y.id===x.id))))
   throw Error('Profiles changed while exporting. Try again.');
  const verified=await prepareSecurityCodeExport(a,rows);
  if(signature!==securityCodeExportSignature(verified))throw Error('Security Code source changed during export. No file was written.');
  a.check();
  await writeFile(choice.filePath,content.body,{encoding:'utf8',mode:0o600});
  // Only after the actual export has saved may New profiles enter Ready for Export.
  const exportedNew=rows.filter(x=>x.needsFirstExport===true);
  let markedExported=0,markError=null;
  if(exportedNew.length)try{
   const ids=new Set(exportedNew.map(x=>x.id)),snapshot=new Map(exportedNew.map(x=>
    [x.id,require('./jig-field-core').hash(x)]));
   const receipt=await profiles.libraryTransaction(a.scope,a.id,ctx=>{
    let updated=0;
    for(const row of ctx.rows.filter(x=>ids.has(x.id))){
     if(require('./jig-field-core').hash(row)!==snapshot.get(row.id))
      throw Error('A new profile changed after export; status was not updated.');
     row.needsFirstExport=false;row.exportedAt=new Date(now()).toISOString();
     row.revision=(row.revision||0)+1;updated++;
     ctx.audit('profile-first-exported',row.email,{retailer});
    }
    if(updated!==ids.size)throw Error('One or more new profiles were removed before their export status updated.');
    return {updated};
   },a.check);
   markedExported=receipt.updated;
  }catch(error){markError=String(error.message||error);}
  return {saved:true,count:rows.length,name:path.basename(choice.filePath),
   firstExported:markedExported,...(markError?{markError}:{}),
   ...(unique?{scanned:selection.scanned,skippedDuplicates:selection.skippedDuplicates,
    skippedEmail:selection.skippedEmail,skippedCard:selection.skippedCard}:{})};
 }
 async function exportArchive(e,p){
  const a=await access(e,p);
  C.retailer(p.retailer);
  if(!Array.isArray(p.profileIds)||!p.profileIds.length||p.profileIds.length>500||
    new Set(p.profileIds).size!==p.profileIds.length)throw Error('Select 1-500 profiles.');
  const before=await profiles.fieldSnapshot(a.scope,a.id);
  const rows=p.profileIds.map(id=>before.find(row=>row.id===id&&row.retailer===p.retailer));
  if(rows.some(row=>!row))throw Error('Profiles must belong to this vault and retailer.');
  const exportRows=await prepareSecurityCodeExport(a,rows);
  const signature=securityCodeExportSignature(exportRows);
  const exportOwner=await verifiedExportCustomerName(a,p);
  const content=C.exportArchiveRows(exportRows,p.retailer,exportOwner,a.scope);
  if(!await confirmExport(e))return {cancelled:true};
  const choice=await chooseSave(e,{name:content.name,extension:'json'});
  if(choice.canceled||!choice.filePath)return {cancelled:true};
  if(path.extname(choice.filePath).toLowerCase()!=='.json')throw Error('Choose a JSON file.');
  const latest=await profiles.fieldSnapshot(a.scope,a.id);
  if(rows.some(row=>require('./jig-field-core').hash(row)!==
   require('./jig-field-core').hash(latest.find(item=>item.id===row.id))))
    throw Error('Profiles changed during export. Try again.');
  const verified=await prepareSecurityCodeExport(a,rows);
  if(signature!==securityCodeExportSignature(verified))throw Error('Security Code source changed during export. No file was written.');
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
 const websiteRef=x=>String(x.id||crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex')).slice(0,180);
 async function jigAssets(e,p){
  const a=await access(e,p),resources=await jigSources(a);
  const siteA=resources.website.addresses||[],siteC=resources.website.cards||[];
  const addressLabel=x=>[x.address1||x.address||x.addressLine1,x.address2||x.addressLine2,x.city,x.state,x.zip||x.zipCode].filter(Boolean).join(', ');
  const last4=x=>String(x.acoCardNumber||x.cardNumber||x.number||x.maskedNumber||x.last4||'').replace(/\D/g,'').slice(-4);
  return {customerId:a.id,addresses:[
   ...siteA.map((x,i)=>({id:'website:'+websiteRef(x),label:x.label||'Website address '+(i+1),summary:addressLabel(x)})),
   ...resources.localAddresses.map((x,i)=>({id:'local:'+x.id,label:x.label||'Studio address '+(i+1),summary:addressLabel(x)}))],
   cards:[
    ...siteC.map((x,i)=>({id:'website:'+websiteRef(x),label:x.cardLabel||x.label||'Website card '+(i+1),last4:last4(x)})),
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
   if(!Array.isArray(set))throw Error('Saved website resources unavailable.');
   item=set.find(x=>websiteRef(x)===ref);
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
  const baseAddress=await jigResource(a,'address',p.addressSourceId);if(p.cardSourceId)await jigResource(a,'card',p.cardSourceId);
  const batches=p.combine?[nonStackingRules(p.ruleIds)]:p.ruleIds.map(id=>[id]),candidates=[];
  for(const batch of batches){let data=structuredClone(row.data);if(baseAddress){const fields=D.toValues(data);for(const [k,v] of Object.entries(baseAddress))fields['shipping.'+k]=v;data=D.manualEdit(data,fields);}const addressRules=batch.filter(id=>id!==C.FL_PHONE_RULE);for(const rule of addressRules)data=C.jig(data,row.retailer,1,[rule]);if(batch.includes(C.FL_PHONE_RULE))data=C.applyFloridaPhone(data,uuid(),0);
   if(p.addOptionalUnit===true)data=addMissingUnitLine(row.data,data,candidates.length+1).data;
   const v=C.values(data),address=Object.fromEntries(['address1','address2','city','state','zip'].map(k=>[k,v['shipping.'+k]]));if(existingUnitViolation(addressView(row.data),address))continue;if(address.address1&&JSON.stringify(address)!==JSON.stringify(Object.fromEntries(Object.keys(address).map(k=>[k,C.values(row.data)['shipping.'+k]])))||batch.includes(C.FL_PHONE_RULE))candidates.push({ruleIds:batch,address,phone:v.phone});}
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
  ensureExistingUnitPreserved(addressView(row.data),address);
  const fields=D.toValues(row.data);
  for(const k of ['address1','address2','city','state','zip']){fields['shipping.'+k]=String(address[k]??'').trim();if(p.billingSameAsShipping)fields['billing.'+k]=String(address[k]??'').trim();}
  let jigged=C.syncCardholderToProfile(D.manualEdit(row.data,fields));
  if(p.cardSourceId){const selected=await jigResource(a,'card',p.cardSourceId);C.putCard(jigged,selected);jigged=C.syncCardholderToProfile(jigged);}
  const saved=await edit(e,{scope:'aco',customerId:a.id,profileId:row.id,revision:row.revision,fields:C.values(jigged),group:row.group,card:C.payment(jigged)});
  if(saved?.remoteSaved!==true)throw Error('Website did not confirm this jig. Do not treat it as a synchronized change.');
  return {saved:true,remoteSaved:true,profileId:row.id,retailer:row.retailer};
 }
 function addressView(data){
  const v=C.values(data);
  return {...Object.fromEntries(['address1','address2','city','state','zip'].map(k=>[k,String(v['shipping.'+k]||'')])),phone:String(v['shipping.phone']||v.phone||'')};
 }
 // Immutable existing second-line / inline-unit identity. A previously saved
 // Apt/Ste/Unit (including its label and number) may never be rewritten, even
 // through a reuse override or a legacy transformation rule.
 function inlineUnit(address1){
  const value=String(address1||'');
  const match=/(?:^|[\s,])((?:(?:apt|apartment|ste|suite|unit|room|rm|floor|fl|condo)\.?\s*#?\s*[a-z0-9][a-z0-9/-]*|#\s*[a-z0-9][a-z0-9/-]*))\s*$/i.exec(value);
  return match?match[1]:null;
 }
 function existingUnitViolation(before,after){
  const second=String(before?.address2||'');
  if(second.trim()&&second!==String(after?.address2||''))return 'Existing address line 2 "'+second+'" must remain exactly unchanged.';
  const embedded=inlineUnit(before?.address1);
  if(embedded&&(embedded!==inlineUnit(after?.address1)||String(before?.address2||'')!==String(after?.address2||'')))
   return 'Existing inline unit "'+embedded+'" must remain exactly unchanged.';
  return '';
 }
 function ensureExistingUnitPreserved(before,after){
  const violation=existingUnitViolation(before,after);
  if(violation)throw Error(violation+' Unit jigs only apply when the original address has no unit.');
 }
 // Jigged second lines are additive and never change an existing apartment,
 // suite, unit, bare number or inline designation. Use a small fixed palette
 // rather than inventing building-level delivery facts in the Main bank.
 const SECOND_LINE_LABELS=['Apt','Unit','#','Ste',''];
 const SECOND_LINE_IDS=['A','B','C','D','1','2','3','4','5','6','7','8','9'];
 function addMissingUnitLine(original,generated,position,occupiedKeys=new Set(),usedUnitLabels=new Set()){
  const originalAddress=addressView(original),after=addressView(generated);
  if(originalAddress.address2.trim()||inlineUnit(originalAddress.address1)||after.address2.trim())
   return {data:generated,added:false,reason:'existing-unit'};
  if(inlineUnit(after.address1))throw Error('Generated unit must be on address line 2, not added to the street.');
  // Keep the approved A-D / 1-9 range. Search ALL five label styles times
  // thirteen identifiers before saying the pool is exhausted.
  const total=SECOND_LINE_LABELS.length*SECOND_LINE_IDS.length;
  const start=((Math.floor(Number(position)||0)%total)+total)%total;
  for(let pass=0;pass<2;pass++)for(let step=0;step<total;step++){
   const idx=(start+step*17)%total; // 17 is coprime to 65: visits all 65.
   const label=SECOND_LINE_LABELS[idx%SECOND_LINE_LABELS.length];
   const identifier=SECOND_LINE_IDS[Math.floor(idx/SECOND_LINE_LABELS.length)%SECOND_LINE_IDS.length];
   const unit=label==='#'?'# '+identifier:label?label+' '+identifier:identifier;
   // Prefer distinct new second lines among profiles using the same main
   // address. After all 65 are used, another street jig may still allow a
   // unique full address, so only then permit a reused unit label.
   if(pass===0&&usedUnitLabels.has(normalizedAddressPart(unit)))continue;
   const values=D.toValues(generated);
   values['shipping.address2']=unit;
   const candidate=D.manualEdit(generated,values);
   if(!occupiedKeys.has(mainAddressKey({data:candidate})))
    return {data:candidate,added:true,optionsChecked:step+1+pass*total};
  }
  return {data:generated,added:false,reason:'exhausted',optionsChecked:total};
 }
 function normalizedAddressPart(v){return String(v||'').trim().toUpperCase().replace(/\s+/g,' ');}
 function mainAddressKey(row){
  const v=C.values(row.data);
  return ['shipping.address1','shipping.address2','shipping.city','shipping.state','shipping.zip'].map(k=>normalizedAddressPart(v[k])).join('|');
 }
 // Detect exact full-address reuse across all saved accounts in this one vault,
 // including other retailer tabs. Do not read any other customer's vault.
 // Existing unchanged addresses aren't new jigs and are not flagged.
 function jigAddressConflicts(planned,inventory){
  const selected=new Map(planned.map(row=>[row.profileId,row]));
  const occupied=[];
  for(const row of inventory){
   const plan=selected.get(row.id);
   if(plan)continue;
   occupied.push({id:row.id,email:row.email,retailer:row.retailer,key:mainAddressKey(row)});
  }
  for(const plan of planned){
   occupied.push({id:plan.profileId,email:plan.email,retailer:plan.retailer,
    key:mainAddressKey({data:plan.data})});
  }
  const conflicts=[];
  for(const plan of planned){
   if(mainAddressKey({data:plan.data})===mainAddressKey({data:plan.originalData}))continue;
   const key=mainAddressKey({data:plan.data});
   const matches=occupied.filter(entry=>entry.id!==plan.profileId&&entry.key===key);
   if(matches.length)conflicts.push({profileId:plan.profileId,email:plan.email,retailer:plan.retailer,
    address:[plan.after.address1,plan.after.address2,plan.after.city,plan.after.state,plan.after.zip].filter(Boolean).join(', '),
    matches:matches.slice(0,8).map(entry=>({email:entry.email,retailer:entry.retailer}))});
  }
  return conflicts;
 }
 // Authorized exact address picker. Pulls Main bank entries and previously
 // saved profile shipping (including jigged) from this one encrypted owner vault.
 async function reusableShippingChoices(a,snapshot=null){
  const saved=addressBanks?(a.scope==='personal'?await addressBanks.listPersonal():await addressBanks.listAco(a.id)):{addresses:[]};
  const all=snapshot||await profiles.fieldSnapshot(a.scope,a.id),choices=[],seen=new Set();
  function add(id,type,label,raw){
   const address={address1:String(raw?.address1||raw?.address||'').trim(),address2:String(raw?.address2||raw?.unit||'').trim(),
    city:String(raw?.city||'').trim(),state:String(raw?.state||'').trim(),zip:String(raw?.zip||'').trim()};
   if(!address.address1||!address.city||!address.state||!address.zip)return;
   const fingerprint=type+'|'+Object.values(address).map(normalizedAddressPart).join('|');
   if(seen.has(fingerprint))return;seen.add(fingerprint);
   choices.push({id,type,label,summary:Object.values(address).filter(Boolean).join(', '),address});
  }
  for(const entry of saved.addresses||[])add('bank:'+entry.id,entry.jiggedAt||entry.isJigged?'jigged':'main',entry.label||'Saved Main address',entry);
  for(const row of all)add('profile:'+row.id,row.jiggedAt?'jigged':'main',(row.jiggedAt?'Jigged':'Profile Main')+' · '+(row.label||row.email||row.retailer),addressView(row.data));
  a.check();
  choices.sort((x,y)=>(x.type==='main'?0:1)-(y.type==='main'?0:1)||x.summary.localeCompare(y.summary));
  return choices;
 }
 async function reuseChoices(e,p){
  const a=await access(e,p),choices=await reusableShippingChoices(a);
  return {choices:choices.map(({address,...item})=>item)};
 }
 async function resolveReuse(a,id){
  if(typeof id!=='string'||id.length>225||!/^(bank|profile):/.test(id))throw Error('Select an existing Main or Jigged address.');
  const entry=(await reusableShippingChoices(a)).find(x=>x.id===id);
  if(!entry)throw Error('The selected address is no longer available. Reopen the picker.');
  return entry;
 }
 function isHardRule(id){return C.ruleById(id)?.family==='target-primary';}
 function applyOne(data,row,id){return C.jig(data,row.retailer,1,[id]);}
 function bulkJigData(row,ruleIds,groupPosition,combine,billingSameAsShipping,phoneSeed,globalIndex=0){
  const original=structuredClone(row.data);
  let data=structuredClone(row.data),appliedRuleIds=[];
  const addressRules=ruleIds.filter(id=>id!==C.FL_PHONE_RULE),phoneJig=ruleIds.includes(C.FL_PHONE_RULE);
  const beforeAddress=addressView(row.data);
  if(groupPosition>0&&addressRules.length){
   const soft=addressRules.filter(id=>!isHardRule(id)),hard=addressRules.filter(isHardRule);
   // Try actual distinct eligible rules. A no-op or an attempted change to a
   // saved unit is NOT an applied jig. Interleave hard/soft to ensure hard
   // choices are not starved by a large collection of soft rules.
   // Vary the starting rule within the approved set on every preview, while
   // keeping the selected categories, hard-family caps and unit safeguards.
   const offset=Math.max(0,globalIndex)+crypto.randomInt(Math.max(1,addressRules.length));
   const rotated=(list,shift)=>list.length?list.slice(shift%list.length).concat(list.slice(0,shift%list.length)):[];
   const softOrder=rotated(soft,offset);
   const hardFamily=id=>id.startsWith('target.house.fraction.')?'fraction':
    id.startsWith('target.house.hyphen.')?'hyphen':'other';
   const families=[...new Set(hard.map(hardFamily))];
   // A checked Target hard family is a request to USE it, not a fallback after
   // soft address rules. Rotate across families and variants for each profile.
   // In combine mode, apply at most one rule per family (fraction BEFORE
   // hyphen, so 100 1/2 Example may become 100-A 1/2 Example).
   const order=[];
   if(hard.length){
    if(combine){
     for(const family of ['fraction','hyphen','other']){
      const variants=hard.filter(id=>hardFamily(id)===family);
      order.push(...rotated(variants,Math.floor(offset/Math.max(1,families.length))));
     }
    }else{
     for(let step=0;step<families.length;step++){
      const family=families[(offset+step)%families.length],variants=hard.filter(id=>hardFamily(id)===family);
      order.push(...rotated(variants,Math.floor(offset/Math.max(1,families.length))));
     }
    }
   }
   order.push(...softOrder);
   const appliedFamilies=new Set();
   for(const id of order){
    if(!combine&&appliedRuleIds.length)break;
    if(combine&&appliedRuleIds.length>=3)break;
    if(isHardRule(id)&&appliedFamilies.has(hardFamily(id)))continue;
    const candidate=applyOne(data,row,id),address=addressView(candidate);
    // Legacy unit rules cannot add a new line: only the explicit optional count can.
    if(existingUnitViolation(beforeAddress,address)||(!inlineUnit(beforeAddress.address1)&&inlineUnit(address.address1))||
       (!beforeAddress.address2.trim()&&!inlineUnit(beforeAddress.address1)&&address.address2.trim()))continue;
    if(['address1','address2','city','state','zip'].every(key=>
      normalizedAddressPart(address[key])===normalizedAddressPart(addressView(data)[key])))continue;
    data=candidate;appliedRuleIds.push(id);
    if(isHardRule(id))appliedFamilies.add(hardFamily(id));
   }
   // Legacy grouped rules can occasionally produce no address change. Mark
   // that profile UNCHANGED rather than reporting its postal city as a jig.
  }
  if(phoneJig){
   data=C.applyFloridaPhone(data,phoneSeed,globalIndex);
   if(addressView(data).phone!==beforeAddress.phone)appliedRuleIds.push(C.FL_PHONE_RULE);
  }
  // Unit addition is opt-in at the batch level, never automatic.
  ensureExistingUnitPreserved(beforeAddress,addressView(data));
  const before=D.toValues(original),after=D.toValues(data),edits={...after};
  if(billingSameAsShipping){
   for(const key of ['address1','address2','city','state','zip'])edits['billing.'+key]=after['shipping.'+key];
  }else{
   for(const key of ['first','last','phone','address1','address2','city','state','zip','country'])
    if(!(phoneJig&&key==='phone'))edits['billing.'+key]=before['billing.'+key];
  }
  return {data:C.syncCardholderToProfile(D.manualEdit(data,edits)),appliedRuleIds};
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
   if(variant>=SECOND_LINE_LABELS.length*SECOND_LINE_IDS.length)return null;
   const label=SECOND_LINE_LABELS[variant%SECOND_LINE_LABELS.length];
   const identifier=SECOND_LINE_IDS[Math.floor(variant/SECOND_LINE_LABELS.length)];
   nextUnit=label==='#'?'# '+identifier:label?label+' '+identifier:identifier;
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
       if(existingUnitViolation(addressView(row.data),addressView(next)))continue;
       const candidate=mainAddressKey({data:next});
       if(candidate!==key&&!seen.has(candidate)){data=next;kind=category;selectedVariant=attempt;remaining[category]--;used[category]++;found=true;break;}
      }
      if(found)break;
     }
     if(!found&&soft.length){
      for(let attempt=0;attempt<soft.length;attempt++){
       const next=newBulkJigData(row,null,0,[soft[(i+attempt)%soft.length]],false,p.billingSameAsShipping===true,phoneSeed,index);
       if(existingUnitViolation(addressView(row.data),addressView(next)))continue;
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
 function distributeJigs(ruleIds,count,preferences){
  const styles=[...new Set(ruleIds.filter(id=>id!==C.FL_PHONE_RULE).map(C.jigStyle))];
  if(!styles.length)return {sequence:[],counts:{}};
  const counts=Object.fromEntries(styles.map(style=>[style,0]));
  if(preferences?.enabled===true){
   const fixed=preferences.counts||{};
   if(!fixed||typeof fixed!=='object'||Array.isArray(fixed)||Object.keys(fixed).some(k=>!styles.includes(k)))throw Error('Invalid jig distribution styles.');
   for(const style of styles){const n=fixed[style]??0;if(!Number.isSafeInteger(n)||n<0||n>500)throw Error('Invalid jig distribution quantity.');counts[style]=n;}
   if(Object.values(counts).reduce((a,b)=>a+b,0)>count)throw Error('Jig distribution exceeds '+count+' available profiles.');
  }
  while(Object.values(counts).reduce((a,b)=>a+b,0)<count){
   const next=styles.reduce((best,style)=>counts[style]<counts[best]?style:best,styles[0]);counts[next]++;
  }
  const remaining={...counts},sequence=[];
  while(sequence.length<count){
   const next=styles.filter(style=>remaining[style]>0).sort((a,b)=>(sequence.filter(x=>x===a).length/counts[a])-(sequence.filter(x=>x===b).length/counts[b])||styles.indexOf(a)-styles.indexOf(b))[0];
   sequence.push(next);remaining[next]--;
  }
  // Preserve the exact per-style counts, but don't assign the same ordered
  // pattern every time a user previews a batch.
  for(let i=sequence.length-1;i>0;i--){
   const j=crypto.randomInt(i+1);
   [sequence[i],sequence[j]]=[sequence[j],sequence[i]];
  }
  return {sequence,counts};
 }
 async function batchJigPreview(e,p){
  const a=await access(e,p),retailer=C.retailer(p.retailer);
  if(!Array.isArray(p.profileIds)||!p.profileIds.length||p.profileIds.length>500||new Set(p.profileIds).size!==p.profileIds.length)throw Error('Select 1-500 profiles to jig together.');
  const requestedCounts=hardCounts(p.hardCounts),hasHard=p.distribution?.enabled===true?false:requestedCounts&&HARD_KINDS.some(k=>requestedCounts[k]>0);
  // Optional count applies only within this explicitly reviewed batch.
  const optionalUnitCount=p.optionalUnitCount??0;
  // Explicitly opting into optional units permits using a different unitless
  // saved Main address for a selected profile when its current base has a unit.
  // Never rewrite the saved Address Bank entry or silently rebase otherwise.
  if(p.autoUnitFromAddressBank!==undefined&&typeof p.autoUnitFromAddressBank!=='boolean')
   throw Error('Invalid automatic Address Bank source option.');
  const autoUnitFromAddressBank=p.autoUnitFromAddressBank===true&&optionalUnitCount>0;
  if(!Number.isSafeInteger(optionalUnitCount)||optionalUnitCount<0||optionalUnitCount>500)
   throw Error('Choose an optional unit count between 0 and 500.');
  const reuse=p.reuse??null;
  if(reuse!==null&&(!reuse||typeof reuse!=='object'||Array.isArray(reuse)||Object.keys(reuse).some(k=>!['sourceId','count'].includes(k))))
   throw Error('Choose an existing address and a profile count.');
  const reuseCount=reuse?reuse.count:0;
  if(reuse&&(!Number.isSafeInteger(reuseCount)||reuseCount<2||reuseCount>p.profileIds.length))throw Error('Choose between 2 and the selected profile count for address reuse.');
  if(!Array.isArray(p.ruleIds)||p.ruleIds.length>100||p.ruleIds.some(id=>typeof id!=='string'||/^prefix_three/.test(id)||!supportedRule(id))||
     (p.profileIds.length>reuseCount&&!p.ruleIds.length&&!hasHard&&!optionalUnitCount))
   throw Error('Choose supported jig rules for the remaining profiles, or explicitly reuse one saved address for the entire selection.');
  const all=await profiles.fieldSnapshot(a.scope,a.id),selected=p.profileIds.map(id=>all.find(x=>x.id===id&&x.retailer===retailer));
  if(selected.some(x=>!x))throw Error('Every selected profile must still belong to this vault and retailer.');
  if(selected.some(x=>x.needsReview))throw Error('Resolve website conflicts before bulk jigging.');
  const unitlessBankChoices=autoUnitFromAddressBank?(await reusableShippingChoices(a,all)).filter(item=>
   item.id.startsWith('bank:')&&item.type==='main'&&!item.address.address2.trim()&&
   !inlineUnit(item.address.address1)):[];
  const source=reuse?await resolveReuse(a,reuse.sourceId):null;
  const regularSelected=selected.slice(reuseCount);
  // Online directory ZIP/state matches are suggestions, not USPS delivery-point
  // verification. Only the city name may change; ZIP/state/street stay intact.
  const postalScanned=new Map();
  let postalAlternativeCount=0;
  if(p.postalScan===true){
   if(typeof getPostalJigOptions!=='function')throw Error('Online postal city crossover scanner is unavailable in this Studio build.');
   const distinct=new Map();
   for(const row of regularSelected){
    const address=addressView(row.data);
    const lookupKey=String(address.zip||'').slice(0,5)+'|'+String(address.state||'').toUpperCase()+'|'+String(address.city||'').toUpperCase();
    if(!distinct.has(lookupKey))distinct.set(lookupKey,address);
   }
   const addresses=[...distinct.entries()];
   for(let index=0;index<addresses.length;index+=6){
    const chunk=addresses.slice(index,index+6);
    const results=await Promise.all(chunk.map(async([key,address])=>{
     const result=await getPostalJigOptions(address);
     if(!result||result.streetDeliveryVerified===true)throw Error('Unexpected postal lookup response.');
     return {key,result};
    }));
    a.check();
    for(const {key,result} of results){postalScanned.set(key,result);postalAlternativeCount+=result.cities?.length||0;}
   }
  }
  const phoneSeed=uuid(),positions=new Map(),groupSizes=new Map(),hardResults=regularSelected.length&&hasHard?perAddressHardRows(regularSelected,p,phoneSeed):null;
  for(const row of regularSelected){const key=mainAddressKey(row);groupSizes.set(key,(groupSizes.get(key)||0)+1);}
  const plannedAddressKeys=new Set(),distribution=distributeJigs(p.ruleIds,regularSelected.length-(regularSelected.length>1?Math.ceil(regularSelected.length/18):0),p.distribution);
  let distributionIndex=0;
  const rows=selected.map((row,index)=>{
   const reuseThis=!!source&&index<reuseCount,regularIndex=index-reuseCount;
   const key=mainAddressKey(row),groupPosition=positions.get(key)||0;
   if(!reuseThis)positions.set(key,groupPosition+1);
   // Retain one unchanged Main for each block of 18 selected profiles, not
   // one for EVERY repeated-address group. Single selections always jig.
   const jigPosition=regularSelected.length>1&&regularIndex%18===0?0:Math.max(1,groupPosition);
   let data,appliedRuleIds=[];
   if(reuseThis){
    const values={...D.toValues(row.data)};
    for(const field of ['address1','address2','city','state','zip']){
     values['shipping.'+field]=source.address[field];
     if(p.billingSameAsShipping===true)values['billing.'+field]=source.address[field];
    }
    data=C.syncCardholderToProfile(D.manualEdit(row.data,values));
   }else if(hardResults){
    data=hardResults[regularIndex].data;
    if(hardResults[regularIndex].kind!=='original'&&hardResults[regularIndex].kind!=='soft')
     appliedRuleIds.push('hard.'+hardResults[regularIndex].kind);
   }else {
    const preferred=jigPosition>0&&p.combine!==true?distribution.sequence[distributionIndex++]:null;
    const chosenRules=preferred?[...p.ruleIds.filter(id=>C.jigStyle(id)===preferred),...p.ruleIds.filter(id=>id===C.FL_PHONE_RULE)]:p.ruleIds;
    let generated=bulkJigData(row,chosenRules,jigPosition,p.combine===true,p.billingSameAsShipping===true,phoneSeed,regularIndex);
    // An even-distribution preference isn't an instruction to leave a
    // profile untouched when its chosen style cannot apply (for example an
    // existing Apt cannot have its unit label rewritten). Search other
    // enabled styles before declaring this profile unchanged.
    if(jigPosition>0&&preferred&&p.distribution?.enabled!==true&&
       !generated.appliedRuleIds.some(id=>id!==C.FL_PHONE_RULE)){
     generated=bulkJigData(row,p.ruleIds,jigPosition,p.combine===true,
      p.billingSameAsShipping===true,phoneSeed,regularIndex);
    }
    if(jigPosition>0&&plannedAddressKeys.has(mainAddressKey({data:generated.data}))){
     // Avoid assigning an already used jig when a different selected
     // fractional/hyphen or soft variation can produce a distinct address.
     // Keep strict duplicates visible for explicit override if exhausted.
     let found=false;
     const tryVariant=candidate=>{
      const key=mainAddressKey({data:candidate.data});
      if(!plannedAddressKeys.has(key)){generated=candidate;found=true;return true;}
      return false;
     };
     for(let attempt=1;attempt<=Math.min(80,chosenRules.length*5+10);attempt++){
      if(tryVariant(bulkJigData(row,chosenRules,jigPosition,p.combine===true,
       p.billingSameAsShipping===true,phoneSeed,regularIndex+attempt)))break;
     }
     if(!found)for(const ruleId of p.ruleIds){
      if(ruleId===C.FL_PHONE_RULE)continue;
      if(tryVariant(bulkJigData(row,[ruleId],jigPosition,false,
       p.billingSameAsShipping===true,phoneSeed,regularIndex)))break;
     }
    }
    if(preferred&&p.distribution?.enabled===true&&!generated.appliedRuleIds.some(id=>C.jigStyle(id)===preferred))throw Error('Unable to apply requested '+preferred+' jig to '+row.email+'. Choose eligible addresses.');
    data=generated.data;appliedRuleIds=generated.appliedRuleIds;
   }
   if(!reuseThis)plannedAddressKeys.add(mainAddressKey({data}));
   const before=addressView(row.data);
   const lookupKey=String(before.zip||'').slice(0,5)+'|'+String(before.state||'').toUpperCase()+'|'+String(before.city||'').toUpperCase();
   const availablePostal=postalScanned.get(lookupKey)?.cities||[];
   let appliedPostalCity=null;
   if(!reuseThis&&p.postalApplyCities===true&&availablePostal.length&&
     (groupSizes.get(key)===1||groupPosition>0)){
    const current=D.toValues(data),nextCity=availablePostal[(regularIndex+groupPosition)%availablePostal.length];
    // Retain any separately selected city edit and preserve the ZIP/state.
    if(String(current['shipping.city']||'').trim().toUpperCase()===String(before.city||'').trim().toUpperCase()&&
       String(nextCity).toUpperCase()!==String(before.city).toUpperCase()){
     const edits={...current,'shipping.city':nextCity};
     if(p.billingSameAsShipping===true)edits['billing.city']=nextCity;
     data=C.syncCardholderToProfile(D.manualEdit(data,edits));appliedPostalCity=nextCity;
    }
   }
   const after=addressView(data);
   ensureExistingUnitPreserved(before,after);
   if(!after.address1||!after.city||!after.state||!after.zip)throw Error('A selected profile is missing a complete shipping address.');
   return {profileId:row.id,revision:row.revision||0,hash:require('./jig-field-core').hash(row.data),originalData:row.data,email:row.email,label:row.label,retailer:row.retailer,
    linked:a.scope==='aco'&&row.source==='website-linked-profile'&&row.sourceLinked!==false,before,after,data,group:row.group||row.retailer,
    postalCities:availablePostal,postalCityApplied:appliedPostalCity,appliedRuleIds,
    category:reuseThis?'reused saved address':hardResults?.[regularIndex]?.kind||((groupPosition===0&&groupSizes.get(key)>1)?'original':'legacy'),
    mainAddress:reuseThis?source.address:hardResults?.[regularIndex]?.mainAddress||before};
  });
  // First use selected profiles whose existing address is unitless. If the
  // owner enabled automatic sourcing, pull unitless Main entries from THIS
  // vault's Address Bank for the remaining requested profiles. This is a
  // reviewed reassignment to a different saved base; it never edits the
  // original saved unit, the source bank entry, or other profiles.
  const isUnitless=row=>row.category!=='reused saved address'&&
   !String(row.after.address2||'').trim()&&!inlineUnit(row.after.address1);
  const nativeUnitless=rows.filter(row=>isUnitless(row)&&
   !String(row.before.address2||'').trim()&&!inlineUnit(row.before.address1));
  let bankReassigned=0;
  if(autoUnitFromAddressBank&&nativeUnitless.length<optionalUnitCount){
   const needed=optionalUnitCount-nativeUnitless.length;
   const candidates=rows.filter(row=>row.category!=='reused saved address'&&
    !nativeUnitless.includes(row));
   if(!unitlessBankChoices.length||candidates.length<needed)
    throw Error('This batch needs '+needed+' unitless saved Main address source(s), but none are available for the selected profiles in this vault’s Address Bank. Add a genuine unitless Main address to Address Bank, or reduce the requested count.');
   // Shuffle addresses and recipient order. Cycle the bank if requested count
   // exceeds the number of bases: each new A-D / 1-9 second line must remain
   // unique, with full-address conflicts checked before confirmation.
   const shuffle=list=>{const out=[...list];for(let i=out.length-1;i>0;i--){const j=crypto.randomInt(i+1);[out[i],out[j]]=[out[j],out[i]];}return out;};
   const sources=shuffle(unitlessBankChoices);
   const recipientOrder=shuffle(candidates);
   for(let i=0;i<needed;i++){
    const row=recipientOrder[i],bank=sources[i%sources.length];
    const values=D.toValues(row.data);
    for(const field of ['address1','address2','city','state','zip']){
     values['shipping.'+field]=bank.address[field];
     values['billing.'+field]=bank.address[field];
    }
    const bankData=C.syncCardholderToProfile(D.manualEdit(row.data,values));
    // Apply only the explicitly chosen address formatting rules to the NEW
    // unitless base. Phone already uses its own selected profile-side rule.
    const enabledAddressRules=p.ruleIds.filter(id=>id!==C.FL_PHONE_RULE);
    const jigged=bulkJigData({data:bankData,retailer:row.retailer},enabledAddressRules,
     1,p.combine===true,true,phoneSeed,i+1);
    row.data=C.syncCardholderToProfile(jigged.data);
    row.after=addressView(row.data);
    row.appliedRuleIds.push(...jigged.appliedRuleIds);
    row.category='automatic Address Bank source';
    row.unitBankSourceId=bank.id;
    row.unitBankSourceAddress={...bank.address};
    row.mainAddress={...bank.address};
    bankReassigned++;
   }
  }
  // The explicit optional-unit count is exact, but it can now be satisfied
  // by saved unitless bases even if all five selected profiles had apartments.
  const optionalUnitEligible=rows.filter(row=>isUnitless(row)&&
   (row.unitBankSourceId||(!String(row.before.address2||'').trim()&&!inlineUnit(row.before.address1))));
  if(optionalUnitCount){
   const alreadyJigged=row=>['address1','address2','city','state','zip']
    .some(field=>row.before[field]!==row.after[field]);
   if(optionalUnitEligible.length<optionalUnitCount)
    throw Error('Only '+optionalUnitEligible.length+' of '+rows.length+' selected profiles have an available, unitless address. Existing Apt/Unit/Ste values are preserved. Reduce the optional unit quantity.');
   const ranked=optionalUnitEligible.map((row,i)=>({row,i})).sort((a,b)=>
    Number(alreadyJigged(b.row))-Number(alreadyJigged(a.row))||
    // Rebased entries are already intentionally selected for a new unit.
    Number(!!b.row.unitBankSourceId)-Number(!!a.row.unitBankSourceId)||a.i-b.i);
   const occupied=new Map(),chosenIds=new Set(selected.map(item=>item.id));
   const reserve=(key,delta)=>{const n=(occupied.get(key)||0)+delta;if(n>0)occupied.set(key,n);else occupied.delete(key);};
   for(const item of all)if(!chosenIds.has(item.id))reserve(mainAddressKey(item),1);
   for(const item of rows)reserve(mainAddressKey({data:item.data}),1);
   let added=0;
   const generatedLabelsByBase=new Map();
   for(const {row} of ranked.slice(0,optionalUnitCount)){
    const sameMain=['address1','city','state','zip'].map(k=>normalizedAddressPart(row.unitBankSourceId?row.mainAddress[k]:row.before[k])).join('|');
    if(!generatedLabelsByBase.has(sameMain))generatedLabelsByBase.set(sameMain,new Set());
    const usedUnitLabels=generatedLabelsByBase.get(sameMain);
    const previous=mainAddressKey({data:row.data});
    reserve(previous,-1);
    const result=addMissingUnitLine(row.unitBankSourceId?row.data:row.originalData,row.data,
     crypto.randomInt(65),new Set(occupied.keys()),usedUnitLabels);
    if(!result.added){
     reserve(previous,1);
     throw Error('All 65 Apt/Unit/Ste/#/number combinations (A-D or 1-9) are already used for this address. Select another base address or enable more address jig styles.');
    }
    let data=result.data;
    if(p.billingSameAsShipping===true||autoUnitFromAddressBank){
     // A generated unit must accompany the matching shipping street, city,
     // ZIP and state on billing; do not produce a mismatched mixed address.
     const values=D.toValues(data);
     for(const field of ['address1','address2','city','state','zip'])
      values['billing.'+field]=values['shipping.'+field];
     data=D.manualEdit(data,values);
    }
    row.data=C.syncCardholderToProfile(data);
    row.after=addressView(row.data);
    usedUnitLabels.add(normalizedAddressPart(row.after.address2));
    reserve(mainAddressKey({data:row.data}),1);
    ensureExistingUnitPreserved(row.unitBankSourceId?row.unitBankSourceAddress:row.before,row.after);
    row.appliedRuleIds.push('second-line.add');
    added++;
   }
  }
  // The chosen quantity is exact within this batch. An unchanged original
  // address on another selected profile must not silently increase the count.
  if(source){
   const key=address=>['address1','address2','city','state','zip'].map(k=>normalizedAddressPart(address?.[k])).join('|');
   const assigned=rows.filter(row=>key(row.after)===key(source.address)).length;
   if(assigned!==reuseCount)throw Error('The chosen address would be used by '+assigned+
    ' selected profiles, not the requested '+reuseCount+'. Change the remaining jig rules or selected profiles and preview again.');
  }
  if(rows.every(x=>JSON.stringify(x.before)===JSON.stringify(x.after)))throw Error('Every selected profile already has the requested address and no changes would be saved.');
  const duplicateAddresses=jigAddressConflicts(rows,all);
  const token=uuid();
  for(const [id,plan] of jigPlans)if(now()-plan.at>600000)jigPlans.delete(id);
  jigPlans.set(token,{sender:e.sender.id,scope:a.scope,id:a.id,retailer,rows,duplicateAddresses,at:now(),epoch:ep(e),
   autoUnitFromAddressBank,
   reusedSource:source?{id:source.id,key:Object.values(source.address).map(normalizedAddressPart).join('|')}:null});
  return {token,duplicateAddresses,optionalUnitEligible:optionalUnitEligible.length,optionalUnitBankReassigned:bankReassigned,
   optionalUnitAdded:rows.filter(row=>row.appliedRuleIds.includes('second-line.add')).length,
   count:rows.length,changed:rows.filter(x=>JSON.stringify(x.before)!==JSON.stringify(x.after)).length,
   linked:rows.filter(x=>x.linked).length,reused:reuseCount,
   postalScanned:postalScanned.size,postalCityCandidates:postalAlternativeCount,
   postalCityApplied:rows.filter(x=>x.postalCityApplied).length,postalStreetVerified:false,
   distribution:distribution.counts,profiles:rows.map(x=>({profileId:x.profileId,email:x.email,label:x.label,before:x.before,after:x.after,linked:x.linked,category:x.category,mainAddress:x.mainAddress,unitBankSourceId:x.unitBankSourceId||null,appliedRuleIds:x.appliedRuleIds,postalCities:x.postalCities,postalCityApplied:x.postalCityApplied}))};
 }
 async function batchJigCommit(e,p){
  const plan=jigPlans.get(p.token);
  if(!plan||plan.sender!==e.sender.id||now()-plan.at>600000||plan.epoch!==ep(e))throw Error('Bulk jig preview expired. Preview the selected profiles again.');
  if(p.confirmed!==true)throw Error('Confirm the reviewed bulk jig before saving.');
  const a=await access(e,{scope:plan.scope,customerId:plan.id}),latest=await profiles.fieldSnapshot(plan.scope,plan.id);
  const bankChoices=plan.autoUnitFromAddressBank?await reusableShippingChoices(a,latest):[];
  for(const change of plan.rows){
   if(change.unitBankSourceId){
    if(!plan.autoUnitFromAddressBank||!change.appliedRuleIds.includes('second-line.add'))
     throw Error('Automatic unit source is not authorized for this profile.');
    const saved=bankChoices.find(item=>item.id===change.unitBankSourceId&&
     item.id.startsWith('bank:')&&item.type==='main'&&!item.address.address2.trim()&&
     !inlineUnit(item.address.address1));
    if(!saved||Object.values(saved.address).map(normalizedAddressPart).join('|')!==
      Object.values(change.unitBankSourceAddress).map(normalizedAddressPart).join('|'))
     throw Error('A saved Address Bank base changed after preview. Reopen Jig before applying.');
    ensureExistingUnitPreserved(saved.address,addressView(change.data));
   }else ensureExistingUnitPreserved(addressView(change.originalData),addressView(change.data));
   const row=latest.find(x=>x.id===change.profileId&&x.retailer===plan.retailer);
   if(!row||(row.revision||0)!==change.revision||require('./jig-field-core').hash(row.data)!==change.hash)throw Error('A selected profile changed after preview. Nothing was saved; preview the batch again.');
  }
  // A user must explicitly allow any duplicate jig after seeing the complete
  // conflicting address and accounts. Recheck here to catch new conflicts
  // arising after preview. No partial profile edits have been made yet.
  const latestDuplicates=jigAddressConflicts(plan.rows,latest);
  if(latestDuplicates.length&&p.allowDuplicateAddresses!==true){
   throw Error('This jig duplicates '+latestDuplicates.length+' saved account address(es). Review the preview and check Allow duplicate jig addresses to continue.');
  }
  if(JSON.stringify(latestDuplicates)!==JSON.stringify(plan.duplicateAddresses)){
   throw Error('Address reuse conflicts changed after preview. Preview again before allowing duplicates.');
  }
  // Reject a stale Main/Jigged source before making any recipient write.
  if(plan.reusedSource){
   const current=await resolveReuse(a,plan.reusedSource.id);
   if(Object.values(current.address).map(normalizedAddressPart).join('|')!==plan.reusedSource.key)
    throw Error('The saved address changed after preview. Review the batch again.');
  }
  let updated=0,remoteSaved=0;
  for(const change of plan.rows){
   const result=await edit(e,{scope:plan.scope,customerId:plan.id,profileId:change.profileId,revision:change.revision,fields:C.values(change.data),group:change.group,card:C.payment(change.data)});
   updated++;if(result?.remoteSaved)remoteSaved++;
  }
  jigPlans.delete(p.token);a.check();
  return {saved:true,updated,remoteSaved,localSaved:updated-remoteSaved,duplicateOverrides:latestDuplicates.length};
 }
 // Reveal only the selected customer's existing Studio card and independent
 // profile-reference codes after owner authentication. Never return CVV/CVC,
 // never infer website-only masked numbers, and never cross customer vaults.
 async function customerCardDetails(e,p){
  const a=await access(e,p);
  if(a.scope!=='aco')throw Error('Select an authorized customer vault to view card details.');
  const number=CardPolicy.normalized(p?.cardNumber||'');
  if(!/^\d{12,19}$/.test(number))throw Error('A full saved Studio card number is required. Website-only masked cards cannot be revealed.');
  const [rows,refs]=await Promise.all([
   profiles.fieldSnapshot('aco',a.id),
   cardVault?cardVault('aco').securityReferences(cardKey('aco',a.id)):Promise.resolve([])
  ]);
  a.check();
  const linked=rows.filter(row=>C.payment(row.data).number===number);
  const saved=refs.filter(row=>CardPolicy.normalized(row.number)===number);
  if(!linked.length&&!saved.length)throw Error('This card is not in the selected customer vault.');
  return {
   customerId:a.id,cardNumber:number,
   linkedProfiles:linked.map(row=>{
    const card=C.payment(row.data);
    return {retailer:row.retailer,email:row.email,cardholder:card.cardholder,
     expiration:[card.month,card.year].filter(Boolean).join('/'),
     independentSecurityCode:C.profileCode(row.data)};
   }),
   savedReferences:saved.map(row=>({independentSecurityCode:String(row.customSecurityCode||'')}))
  };
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
 async function manageGroups(e,p){
  const a=await access(e,p),retailer=C.retailer(p?.retailer),operation=String(p?.operation||'');
  if(!['create','move'].includes(operation))throw Error('Choose a group action.');
  const group=String(p?.group||'').trim().replace(/\s+/g,' ');
  if(!group||group.length>64||/[<>\\\x00-\x1f]/.test(group)||group==='all')throw Error('Enter a group name up to 64 characters.');
  if(p?.confirmed!==true)throw Error('Confirm the group change.');
  return profiles.libraryTransaction(a.scope,a.id,ctx=>{
   const names=ctx.settings.profileGroups||{},existing=Array.isArray(names[retailer])?names[retailer]:[];
   if(operation==='create'){
    if(existing.some(name=>name.toLowerCase()===group.toLowerCase()))throw Error('That group already exists for this retailer.');
    if(existing.length>=100)throw Error('This retailer has the maximum 100 custom groups.');
    ctx.settings.profileGroups={...names,[retailer]:[...existing,group]};
    ctx.audit('group-created','',{retailer,group});
    return {created:true,group};
   }
   if(!existing.includes(group)&&!ctx.rows.some(r=>r.retailer===retailer&&(r.group||r.retailer)===group))
    throw Error('Create this group before moving profiles.');
   if(!Array.isArray(p.profileIds)||!p.profileIds.length||p.profileIds.length>500||new Set(p.profileIds).size!==p.profileIds.length)
    throw Error('Select 1–500 profiles from the current retailer page.');
   const targets=p.profileIds.map((id,i)=>{
    const row=ctx.rows.find(r=>r.id===id&&r.retailer===retailer);
    if(!row)throw Error('Selection includes an account outside this retailer and vault.');
    if(row.revision!==(p.revisions||[])[i])throw Error('A selected profile changed. Refresh before moving groups.');
    return row;
   });
   for(const row of targets){row.group=group;row.revision=(row.revision||0)+1;ctx.audit('group-changed',row.email,{retailer,group});}
   return {moved:targets.length,group};
  },a.check);
 }
 async function importPastedAccounts(e,p){
  const a=await access(e,p),retailer=C.retailer(p.retailer);
  if(p.confirmed!==true||!Array.isArray(p.accounts)||!p.accounts.length||p.accounts.length>5000)
    throw Error('Review and confirm 1 to 5000 accounts.');
  const normalized=[],seen=new Set();
  for(const row of p.accounts){
    const email=String(row?.email||'').trim().toLowerCase();
    const password=String(row?.password||'');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password||password.length>1024||/[\r\n\x00-\x1f\x7f]/.test(password))
      throw Error('Invalid account line; nothing was imported. Review email and password.');
    if(seen.has(email))throw Error('Repeated email in pasted batch: '+email);
    seen.add(email);normalized.push({email,password});
  }
  const result=await profiles.libraryTransaction(a.scope,a.id,ctx=>{
    const existing=new Set([...ctx.rows.filter(x=>x.retailer===retailer).map(x=>x.email),
      ...ctx.emails.filter(x=>x.retailer===retailer).map(x=>x.email)]);
    let added=0,skipped=0;
    if(ctx.emails.length+normalized.length>20000)throw Error('Encrypted email bank capacity reached.');
    for(const account of normalized){
      if(existing.has(account.email)){skipped++;continue;}
      existing.add(account.email);
      ctx.emails.push({id:crypto.randomUUID(),email:account.email,password:account.password,
        retailer,createdAt:new Date().toISOString(),profileId:null,source:'pasted-credentials'});
      added++;
    }
    ctx.audit('paste-account-import','',{retailer,added,skipped});
    return {retailer,added,skipped};
  },a.check);
  return result;
 }
 async function rules(e,p){const a=await access(e,p),retailer=C.retailer(p.retailer);const settings=await profiles.librarySettings(a.scope,a.id),saved=settings[retailer];a.check();const legacyTarget=retailer==='target'&&Array.isArray(saved?.rules)&&saved?.presetVersion!==2;const selected=legacyTarget?[...new Set([...saved.rules,...C.TARGET_PRIMARY_RULES.map(x=>x.id)])]:(saved?.rules||C.defaultRules(retailer));const grouped=[...new Set(selected.map(id=>/^(street|road|avenue|drive|lane|boulevard|court|terrace|circle|parkway|trail|highway|place|way|alley|square)_(short|long|abbr|full)$/i.test(id)?'suffix.matching':id))];return {selected:grouped,legacyMigrated:legacyTarget||grouped.length!==selected.length||grouped.some((id,i)=>id!==selected[i]),presetVersion:2,options:[...C.ruleOptions(retailer),{id:C.FL_PHONE_RULE,label:'Random Florida phone number',risk:'standard',family:'phone'}]};}
 async function saveRules(e,p){const a=await access(e,p);C.retailer(p.retailer);if(!Array.isArray(p.rules)||p.rules.length>100||new Set(p.rules).size!==p.rules.length||p.rules.some(id=>typeof id!=='string'||/^prefix_three/.test(id)||!supportedRule(id)))throw Error('Choose supported jig rules for this retailer.');return profiles.libraryTransaction(a.scope,a.id,ctx=>{ctx.settings[p.retailer]={rules:p.rules,presetVersion:2};return {saved:true,presetVersion:2};},a.check);}
 return {importPastedAccounts,customerCardDetails,jigAssets,reuseChoices,list,duplicateRepairPreview,duplicateRepairCommit,detail,recoverCodes,recoverCodesFromFile,recoverCodesFromSavedCards,recoveryReview,recoveryReviewSelectedFiles,historicalFolderReview,reconcileLivePreview,reconcileLiveCommit,importPreview,importCommit,importHistory,removeImportBatch,bulkManage,repair,edit,exportFile,exportArchive,syncCustomer,previewLinkedJig,publishLinkedJig,batchJigPreview,batchJigCommit,websiteSnapshot,saveWebsiteAddress,saveWebsitePayment,manageWebsiteRecord,resolveSourceConflict,changeAssignment,linkLocal,removeLocal,manageGroups,rules,saveRules,cancel};
}
function registerLibrary(options){
 const chooseHistoricalFolder=options.chooseHistoricalFolder||(async e=>{
  const {dialog,BrowserWindow}=require('electron');
  const parent=BrowserWindow.fromWebContents(e.sender);
  const picker={title:'Choose historical backup folder (read-only inventory)',buttonLabel:'Scan folder',
   properties:['openDirectory','dontAddToRecent']};
  const result=parent?await dialog.showOpenDialog(parent,picker):await dialog.showOpenDialog(picker);
  return result.canceled?null:result.filePaths?.[0]||null;
 });
 const chooseOriginalFiles=options.chooseOriginalFiles||(async e=>{
  const {dialog,BrowserWindow}=require('electron');
  const parent=BrowserWindow.fromWebContents(e.sender);
  const picker={title:'Select original import files for read-only recovery review',buttonLabel:'Review selected files',
   filters:[{name:'Original profile files',extensions:['csv','json','txt','tsv']}],
   properties:['openFile','multiSelections','dontAddToRecent']};
  const result=parent?await dialog.showOpenDialog(parent,picker):await dialog.showOpenDialog(picker);
  return result.canceled?null:result.filePaths||[];
 });
 // Independent daily local checkpoint even when the Profiles tab is closed.
 // No network calls, no plaintext export, and no automatic restore.
 if(typeof options.profiles.backupStatus==='function'){
  const automaticBackup=()=>options.profiles.backupStatus().catch(()=>{});
  void automaticBackup();
  const backupTick=setInterval(automaticBackup,60*60*1000);
  backupTick.unref?.();
 }
 const service=createLibrary({...options,chooseHistoricalFolder,chooseOriginalFiles});for(const method of ['importPastedAccounts','customerCardDetails','jigAssets','reuseChoices','list','duplicateRepairPreview','duplicateRepairCommit','detail','recoverCodes','recoverCodesFromFile','recoverCodesFromSavedCards','recoveryReview','recoveryReviewSelectedFiles','historicalFolderReview','reconcileLivePreview','reconcileLiveCommit','importPreview','importCommit','importHistory','removeImportBatch','bulkManage','repair','edit','exportFile','exportArchive','syncCustomer','previewLinkedJig','publishLinkedJig','batchJigPreview','batchJigCommit','websiteSnapshot','saveWebsiteAddress','saveWebsitePayment','manageWebsiteRecord','resolveSourceConflict','changeAssignment','linkLocal','removeLocal','manageGroups','rules','saveRules'])options.ipcMain.handle('profile:library:'+method,(e,p)=>service[method](e,p));options.ipcMain.handle('profile:library:cancel',e=>{options.requireOwner(e);return service.cancel(e);});
 // Complete encrypted local workspace checkpoints. Never expose decrypted data.
 for(const [method,invoke] of Object.entries({
  backupStatus:()=>options.profiles.backupStatus(),
  backupCheckpoint:(_e,p)=>{
   if(p?.confirmed!==true)throw Error('Confirm the manual encrypted checkpoint.');
   return options.profiles.backupCheckpoint();
  },
  backupPreview:(_e,p)=>options.profiles.backupPreview(p?.id),
  backupConfirm:(_e,p)=>{
   if(p?.confirmed!==true||p?.entireWorkspace!==true)throw Error('Explicit complete workspace rollback approval is required.');
   return options.profiles.backupConfirm({token:p.token,confirmed:true});
  }
 })){
  options.ipcMain.handle('profile:library:'+method,(e,p)=>{options.requireOwner(e);return invoke(e,p);});
 }
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

