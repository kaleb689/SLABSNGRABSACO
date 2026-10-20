'use strict';
const path=require('node:path'),crypto=require('node:crypto'),Core=require('./app'),D=require('./profile-draft-core'),C=require('./profile-library-core'),Completion=require('./profile-completion-core');
function createLibrary({authorize,guard,profiles,cardVault,chooseSave,confirmExport,writeFile=require('node:fs/promises').writeFile,getCustomerProfileSource,saveCustomerProfile,getCustomerSavedData,updateCustomerSavedData,changeCustomerAssignment,now=Date.now,uuid=crypto.randomUUID}={}){
 const plans=new Map(),jigPlans=new Map(),epochs=new Map();
 const supportedRule=id=>id===C.FL_PHONE_RULE||Core.RULES.some(x=>x.id===id);
 const ep=e=>epochs.get(e.sender.id)||0;
 function cancel(e){epochs.set(e.sender.id,ep(e)+1);for(const [id,p] of plans)if(p.sender===e.sender.id)plans.delete(id);for(const [id,p] of jigPlans)if(p.sender===e.sender.id)jigPlans.delete(id);}
 async function access(e,p){require('./jig-field-core').scopeKey(p?.scope,p?.customerId);const epoch=ep(e);const id=await authorize(e,p.scope,p.customerId);if(p.scope==='aco'&&id!==p.customerId)throw Error('Customer vault mismatch.');guard(e,p.scope);if(ep(e)!==epoch)throw Error('Vault closed during authorization.');return {scope:p.scope,id,check:()=>{guard(e,p.scope);if(ep(e)!==epoch)throw Error('Vault closed during this operation.');}};}
 const cardKey=(s,id)=>s==='personal'?'personal:owner':id;
 function view(row){const result=Completion.inspect(row);return {id:row.id,revision:row.revision||0,retailer:row.retailer,group:row.group||row.retailer,stage:result.ready?'completed':'in-progress',status:row.status||'active',missing:result.missing,label:row.label,email:row.email,data:structuredClone(row.data),source:row.source,sourceLinked:row.source==='website-linked-profile'&&row.sourceLinked===true,localOnly:row.source!=='website-linked-profile'||row.sourceLinked===false,pendingWebsiteData:row.pendingSourceData?structuredClone(row.pendingSourceData):null,remoteManagedId:row.remoteManagedId||null,remoteType:row.remoteType||null,remoteUpdatedAt:row.remoteUpdatedAt||null,needsReview:!!row.needsReview};}
 async function list(e,p){const a=await access(e,p),rows=await profiles.fieldSnapshot(a.scope,a.id);a.check();const counts=new Map();for(const r of rows){for(const [kind,key]of Object.entries({email:C.email(C.values(r.data).email),name:C.nameKey(r.data),card:C.payment(r.data).number})){if(key){const k=r.retailer+'|'+kind+'|'+key;counts.set(k,(counts.get(k)||0)+1);}}}return {scope:a.scope,customerId:a.id,profiles:rows.map(r=>({...view(r),duplicates:Object.entries({email:C.email(C.values(r.data).email),name:C.nameKey(r.data),card:C.payment(r.data).number}).filter(([k,v])=>v&&counts.get(r.retailer+'|'+k+'|'+v)>1).map(([k])=>k)}))};}
 async function detail(e,p){const a=await access(e,p),r=await profiles.preview(a.scope,a.id,p.profileId);a.check();return view(r.profile);}
 async function importPreview(e,p){const a=await access(e,p);C.retailer(p.retailer);if(typeof p.fileName!=='string'||p.fileName!==path.basename(p.fileName)||p.fileName.length>200||typeof p.text!=='string'||Buffer.byteLength(p.text)>26*1024*1024)throw Error('Choose a local profile file.');const parsed=Core.parseFile(p.fileName,p.text);if(!parsed.records?.length||parsed.records.length>500)throw Error('Import 1-500 profiles.');
 for(const row of parsed.records)if(row.scope&&row.scope!==a.scope||row.customerId&&row.customerId!==a.id||row.acoCustomerId&&row.acoCustomerId!==a.id)throw Error('Imported profile ownership does not match this vault.');
 const data=parsed.records.map(row=>C.normalized(row,p.retailer));if(data.some(x=>JSON.stringify(x).length>16000))throw Error('A profile exceeds the supported record size.');const existing=await profiles.fieldSnapshot(a.scope,a.id),duplicates=C.collisions(data,existing,p.retailer),token=uuid();a.check();for(const [id,plan]of plans)if(now()-plan.at>600000)plans.delete(id);if(plans.size>30)throw Error('Close an older import preview first.');plans.set(token,{sender:e.sender.id,scope:a.scope,id:a.id,retailer:p.retailer,data,at:now(),epoch:ep(e)});return {token,count:data.length,profiles:data.map((row,i)=>({email:C.values(row).email,name:C.nameKey(row),cardLast4:C.payment(row).number.slice(-4),duplicates:duplicates[i]}))};}
 async function withCards(a,ids,fn){if(!Array.isArray(ids)||ids.length>500||ids.some(x=>typeof x!=='string')||new Set(ids).size!==ids.length)throw Error('Choose saved cards in this vault.');return ids.length?cardVault(a.scope).withSelectedForJig(cardKey(a.scope,a.id),ids,fn):fn([]);}
 function resolve(data,retailer,ctx,options,cards){const existing=ctx.rows.filter(x=>x.retailer===retailer),seen=existing.map(x=>({retailer,data:x.data})),usedNames=new Set(existing.map(x=>C.nameKey(x.data))),usedEmails=new Set(existing.map(x=>C.email(x.email))),usedCards=new Set(ctx.rows.map(x=>C.payment(x.data).number));const added=[];
 for(let index=0;index<data.length;index++){let row=structuredClone(data[index]);const flags=C.collisions([row],seen,retailer)[0];
  if(options.name&&(flags.includes('name')||options.all)){row=C.randomName(row,usedNames);}
  if(options.email&&(flags.includes('email')||options.all)){const email=ctx.emails.find(x=>x.retailer===retailer&&!x.profileId&&!usedEmails.has(x.email));if(!email)throw Error('Not enough unused emails in this vault and retailer.');row.email=email.email;email.profileId='pending-'+index;}
  if(options.card&&(flags.includes('card')||options.all)){const card=cards.find(c=>!c.previouslyAssigned&&!usedCards.has(c.number));if(!card)throw Error('Not enough unused cards in this vault.');C.putCard(row,card);usedCards.add(card.number);}
  const after=C.collisions([row],seen,retailer)[0];if(after.includes('email'))throw Error('Duplicate email remains. Select Replace duplicate emails.');if(after.length&&!options.allowShared)throw Error('Duplicate name or card remains. Repair it or explicitly allow shared names/cards.');
  if(!C.values(row).email)throw Error('A profile email is missing.');usedEmails.add(C.email(row.email));usedNames.add(C.nameKey(row));seen.push({retailer,data:row});added.push(row);
 }return added;}
 async function importCommit(e,p){const plan=plans.get(p.token);if(!plan||plan.sender!==e.sender.id||now()-plan.at>600000||plan.epoch!==ep(e))throw Error('Import preview expired. Preview again.');const a=await access(e,{scope:plan.scope,customerId:plan.id});if(p.confirmed!==true)throw Error('Review the import first.');return withCards(a,p.cardIds||[],cards=>profiles.libraryTransaction(a.scope,a.id,ctx=>{if(plans.get(p.token)!==plan)throw Error('Import was already saved.');const data=resolve(plan.data,plan.retailer,ctx,p.repairs||{},cards),customerLabel=String(p.customerName||p.group||'Customer').trim().slice(0,80)||'Customer',existingCustomerCount=ctx.rows.filter(x=>x.source==='owner-created-profile').length,added=data.map((row,index)=>{const id=uuid(),email=C.email(row.email),label=a.scope==='personal'?email:customerLabel+' '+(existingCustomerCount+index+1),named=C.syncCardholderToProfile(D.manualEdit(row,{...D.toValues(row),label})),entry={id,retailer:plan.retailer,email,label,group:a.scope==='personal'?plan.retailer:customerLabel,source:'owner-created-profile',status:'active',jiggedAt:p.alreadyJigged?new Date(now()).toISOString():null,createdAt:new Date(now()).toISOString(),revision:0,data:named,format:C.format(plan.retailer),assetRefs:{}};for(const bank of ctx.emails)if(bank.retailer===plan.retailer&&bank.email===email&&(!bank.profileId||String(bank.profileId).startsWith('pending-')))bank.profileId=id;ctx.rows.push(entry);ctx.audit('library-import',email,{retailer:plan.retailer});return entry;});plans.delete(p.token);return {imported:added.length};},a.check));}
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
   if(email!==row.email&&ctx.rows.some(x=>x.id!==row.id&&x.retailer===row.retailer&&x.email===email))throw Error('Email already used in this retailer pool.');
   if(p.card){
    const c=p.card;
    if(!/^\d{12,19}$/.test(String(c.number||'').replace(/\D/g,''))||!/^(0[1-9]|1[0-2])$/.test(c.month||'')||!/^20\d\d$/.test(c.year||'')||!String(c.cardholder||'').trim()||String(c.cardholder).length>120||String(c.customSecurityCode||'').length>64)throw Error('Enter complete card number, holder and expiration.');
    C.putCard(data,c);
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
   for(const bank of ctx.emails)if(bank.email===email&&bank.retailer===row.retailer&&!bank.profileId)bank.profileId=row.id;
   ctx.audit(linked?'website-and-library-edit':'library-edit',email,{retailer:row.retailer});
   return {updated:true,remoteSaved:linked,localOnly:!linked};
  },a.check);
 }
 async function exportFile(e,p){const a=await access(e,p);C.retailer(p.retailer);if(!Array.isArray(p.profileIds)||!p.profileIds.length||p.profileIds.length>500||new Set(p.profileIds).size!==p.profileIds.length)throw Error('Select 1-500 profiles.');const all=await profiles.fieldSnapshot(a.scope,a.id),rows=p.profileIds.map(id=>all.find(x=>x.id===id&&x.retailer===p.retailer));if(rows.some(x=>!x))throw Error('Every exported profile must still belong to this vault and retailer.');const content=C.exportRows(rows,p.retailer,p.customerName||'Personal');if(!await confirmExport(e))return {cancelled:true};const ext=path.extname(content.name),choice=await chooseSave(e,{name:content.name,extension:ext.slice(1)});if(choice.canceled||!choice.filePath)return {cancelled:true};if(path.extname(choice.filePath)!==ext)throw Error('Keep the retailer export format.');const latest=await profiles.fieldSnapshot(a.scope,a.id);if(rows.some(x=>require('./jig-field-core').hash(x)!==require('./jig-field-core').hash(latest.find(y=>y.id===x.id))))throw Error('Profiles changed while exporting. Try again.');a.check();await writeFile(choice.filePath,content.body,{encoding:'utf8',mode:0o600});return {saved:true,count:rows.length,name:path.basename(choice.filePath)};}
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
    ctx.rows.push({id:uuid(),retailer,email:C.email(data.email),label:source.customer.name+' '+(ctx.rows.filter(x=>x.source==='website-linked-profile').length+1),group:source.customer.name,source:'website-linked-profile',status:'active',createdAt,revision:0,data,format:C.format(retailer),remoteKey:key,remoteManagedId:item.managedAccountId||null,remoteType:item.assignmentType||null,remoteUpdatedAt,sourceHash:hash,sourceLinked:true,websiteAuthoritative:true,jiggedAt:createdAt,assetRefs:{}});created++;
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
 async function previewLinkedJig(e,p){
  const a=await access(e,p);if(a.scope!=='aco')throw Error('Choose an active website-linked customer profile.');
  const row=(await profiles.preview(a.scope,a.id,p.profileId)).profile;a.check();
  if(row.revision!==p.revision||row.source!=='website-linked-profile'||row.sourceLinked!==true||row.needsReview)throw Error('Reopen the current linked profile before previewing jigs.');
  if(!Array.isArray(p.ruleIds)||!p.ruleIds.length||p.ruleIds.length>100||p.ruleIds.some(id=>/^prefix_three/.test(id)||!supportedRule(id)))throw Error('Choose supported retailer jig options.');
  const batches=p.combine?[p.ruleIds]:p.ruleIds.map(id=>[id]),candidates=[];
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
 function bulkJigData(row,ruleIds,index,combine,billingSameAsShipping,phoneSeed){
  let data=structuredClone(row.data),addressRules=ruleIds.filter(id=>id!==C.FL_PHONE_RULE),phoneJig=ruleIds.includes(C.FL_PHONE_RULE);
  if(addressRules.length){if(combine){for(const id of addressRules.slice(0,3))data=C.jig(data,row.retailer,1,[id]);}else data=C.jig(data,row.retailer,index+1,addressRules);}
  if(phoneJig)data=C.applyFloridaPhone(data,phoneSeed,index);
  const before=D.toValues(row.data),after=D.toValues(data),edits={...after};
  if(billingSameAsShipping){for(const key of ['address1','address2','city','state','zip'])edits['billing.'+key]=after['shipping.'+key];}
  else for(const key of ['first','last','phone','address1','address2','city','state','zip','country'])if(!(phoneJig&&key==='phone'))edits['billing.'+key]=before['billing.'+key];
  return C.syncCardholderToProfile(D.manualEdit(data,edits));
 }
 async function batchJigPreview(e,p){
  const a=await access(e,p),retailer=C.retailer(p.retailer);
  if(!Array.isArray(p.profileIds)||!p.profileIds.length||p.profileIds.length>500||new Set(p.profileIds).size!==p.profileIds.length)throw Error('Select 1-500 profiles to jig together.');
  if(!Array.isArray(p.ruleIds)||!p.ruleIds.length||p.ruleIds.length>100||p.ruleIds.some(id=>typeof id!=='string'||/^prefix_three/.test(id)||!supportedRule(id)))throw Error('Choose one or more supported retailer jig rules.');
  const all=await profiles.fieldSnapshot(a.scope,a.id),selected=p.profileIds.map(id=>all.find(x=>x.id===id&&x.retailer===retailer));
  if(selected.some(x=>!x))throw Error('Every selected profile must still belong to this vault and retailer.');
  if(selected.some(x=>x.needsReview))throw Error('Resolve website conflicts before bulk jigging.');
  const phoneSeed=uuid();
  const rows=selected.map((row,index)=>{
   const data=bulkJigData(row,p.ruleIds,index,p.combine===true,p.billingSameAsShipping===true,phoneSeed),before=addressView(row.data),after=addressView(data);
   if(!after.address1||!after.city||!after.state||!after.zip)throw Error('A selected profile is missing a complete shipping address.');
   return {profileId:row.id,revision:row.revision||0,hash:require('./jig-field-core').hash(row.data),email:row.email,label:row.label,retailer:row.retailer,linked:a.scope==='aco'&&row.source==='website-linked-profile'&&row.sourceLinked!==false,before,after,data,group:row.group||row.retailer};
  });
  if(rows.every(x=>JSON.stringify(x.before)===JSON.stringify(x.after)))throw Error('The selected jig rules did not change any selected profile.');
  const token=uuid();
  for(const [id,plan] of jigPlans)if(now()-plan.at>600000)jigPlans.delete(id);
  jigPlans.set(token,{sender:e.sender.id,scope:a.scope,id:a.id,retailer,rows,at:now(),epoch:ep(e)});
  return {token,count:rows.length,changed:rows.filter(x=>JSON.stringify(x.before)!==JSON.stringify(x.after)).length,linked:rows.filter(x=>x.linked).length,profiles:rows.map(x=>({profileId:x.profileId,email:x.email,label:x.label,before:x.before,after:x.after,linked:x.linked}))};
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
 async function rules(e,p){const a=await access(e,p);C.retailer(p.retailer);const settings=await profiles.librarySettings(a.scope,a.id);a.check();return {selected:settings[p.retailer]?.rules||C.defaultRules(),options:[...Core.RULES.filter(x=>!/^prefix_three/.test(x.id)).map(x=>({id:x.id,label:x.label})),{id:C.FL_PHONE_RULE,label:'Random Florida phone number'}]};}
 async function saveRules(e,p){const a=await access(e,p);C.retailer(p.retailer);if(!Array.isArray(p.rules)||p.rules.length>100||new Set(p.rules).size!==p.rules.length||p.rules.some(id=>typeof id!=='string'||/^prefix_three/.test(id)||!supportedRule(id)))throw Error('Choose supported jig rules for this retailer.');return profiles.libraryTransaction(a.scope,a.id,ctx=>{ctx.settings[p.retailer]={rules:p.rules};return {saved:true};},a.check);}
 return {list,detail,importPreview,importCommit,repair,edit,exportFile,syncCustomer,previewLinkedJig,publishLinkedJig,batchJigPreview,batchJigCommit,websiteSnapshot,saveWebsiteAddress,saveWebsitePayment,manageWebsiteRecord,resolveSourceConflict,changeAssignment,linkLocal,removeLocal,rules,saveRules,cancel};
}
function registerLibrary(options){const service=createLibrary(options);for(const method of ['list','detail','importPreview','importCommit','repair','edit','exportFile','syncCustomer','previewLinkedJig','publishLinkedJig','batchJigPreview','batchJigCommit','websiteSnapshot','saveWebsiteAddress','saveWebsitePayment','manageWebsiteRecord','resolveSourceConflict','changeAssignment','linkLocal','removeLocal','rules','saveRules'])options.ipcMain.handle('profile:library:'+method,(e,p)=>service[method](e,p));options.ipcMain.handle('profile:library:cancel',e=>{options.requireOwner(e);return service.cancel(e);});return service;}
module.exports={createLibrary,registerLibrary};
