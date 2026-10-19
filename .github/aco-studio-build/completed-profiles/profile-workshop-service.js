'use strict';
const path=require('node:path'),fs=require('node:fs/promises'),crypto=require('node:crypto');
const Core=require('./app'),Fields=require('./jig-field-core'),Draft=require('./profile-draft-core');
function ids(v,label){if(!Array.isArray(v)||!v.length||v.length>500||v.some(x=>typeof x!=='string'||!x||x.length>180)||new Set(v).size!==v.length)throw Error('Select '+label+' from this vault.');return v;}
const cardKey=(scope,id)=>scope==='personal'?'personal:owner':id;
const same=(a,b)=>Fields.hash(a)===Fields.hash(b);
function numberOf(row){return String(row?.cc_number||row?.card?.number||'').replace(/[ -]/g,'');}
function brandFromNumber(value){
 const n=String(value||'').replace(/\D/g,'');
 if(/^4\d{6,}$/.test(n))return 'Visa';
 const first2=Number(n.slice(0,2)),first4=Number(n.slice(0,4));
 if((first2>=51&&first2<=55)||(first4>=2221&&first4<=2720))return 'Mastercard';
 if(/^3[47]/.test(n))return 'American Express';
 if(/^6(?:011|5|4[4-9])/.test(n))return 'Discover';
 if(/^(?:2131|1800|35)/.test(n))return 'JCB';
 if(/^3(?:0[0-5]|[68])/.test(n))return 'Diners Club';
 return 'Card';
}
const resourceMethod=(target,names)=>names.map(name=>target?.[name]).find(fn=>typeof fn==='function');
function profileNameFor(row){
 const d=row?.data||{},s=d.shipping||{},b=d.billing||{};
 const first=String(d.shipping_first_name||s.firstName||d.first_name||d.firstName||b.firstName||'').trim();
 const last=String(d.shipping_last_name||s.lastName||d.last_name||d.lastName||b.lastName||'').trim();
 return (first+' '+last).trim();
}
function normalizeCardIdentity(record){
 const number=numberOf(record);if(!number)return record;
 const brand=brandFromNumber(number),holder=profileNameFor({data:record}),format=Draft.formatOf(record);
 if(format==='shikari'){
  const current=String(record.cc_name||record.cc_holder||'').trim();
  if(holder&&(!current||/^unassigned$/i.test(current)))record.cc_name=holder;
  record.cc_type=brand;
 }else if(record.card){
  const current=String(record.card.holder||record.card.cardholder||'').trim();
  if(holder&&(!current||/^unassigned$/i.test(current)))record.card.holder=holder;
  record.card.type=brand;
 }
 return record;
}

function createWorkshop({authorize,guard,profiles,addressBanks,cardVault,chooseSave,confirmExport,writeFile=fs.writeFile,now=Date.now,uuid=crypto.randomUUID}={}){
 const plans=new Map(),epochs=new Map();
 const epoch=e=>epochs.get(e.sender.id)||0;
 function cancel(e,token){if(token){if(plans.get(token)?.sender===e.sender.id)plans.delete(token);}else{epochs.set(e.sender.id,epoch(e)+1);for(const [t,p]of plans)if(p.sender===e.sender.id)plans.delete(t);}return {cancelled:true};}
 async function access(e,p){Fields.scopeKey(p?.scope,p?.customerId);const id=await authorize(e,p.scope,p.customerId);if(p.scope==='aco'&&id!==p.customerId)throw Error('Customer vault mismatch.');guard(e,p.scope);return {scope:p.scope,id};}
 const bank=async(s,id)=>s==='personal'?addressBanks.listPersonal():addressBanks.listAco(id);
 function expired(){for(const [t,p]of plans)if(now()-p.created>600000&&!p.busy)plans.delete(t);}
 async function assets(e,p){const {scope,id}=await access(e,p),generation=epoch(e);
  const [a,c,rows]=await Promise.all([bank(scope,id),cardVault(scope).list(cardKey(scope,id)),profiles.fieldSnapshot(scope,id)]);
  const full=c.cards.length?await cardVault(scope).selectedForJig(cardKey(scope,id),c.cards.map(x=>x.id)):[];
  const assigned=new Set((c.assignments||[]).map(x=>x.cardId));
  const retailerSeq={};
  const cards=c.cards.map((x,index)=>{
   const raw=full.find(y=>y.id===x.id),users=rows.filter(r=>r.assetRefs?.cardId===x.id||numberOf(r.data)===raw?.number),used=users.length,first=users[0];
   let label='Unlinked card '+(index+1),displayHolder='';
   if(first?.retailer){retailerSeq[first.retailer]=(retailerSeq[first.retailer]||0)+1;label=({target:'Target',walmart:'Walmart',pokemoncenter:'PKC',costco:'Costco',sams:"Sam's"}[first.retailer]||first.retailer)+' '+retailerSeq[first.retailer];displayHolder=profileNameFor(first);}
   return {...x,label,...(p.showFullCards===true?{number:raw.number,cardholder:displayHolder,expMonth:raw.month,expYear:raw.year,brand:brandFromNumber(raw.number),customReference:raw.customSecurityCode||''}:{}),usedCount:used,unused:used===0&&!assigned.has(x.id),previouslyAssigned:assigned.has(x.id)};
  });
  const result={scope,customerId:id,addresses:a.addresses.map(x=>({...x,uses:rows.filter(r=>r.assetRefs?.addressId===x.id).length})),cards,profiles:rows.map(x=>({id:x.id,label:x.label,email:x.email,retailer:x.retailer,status:x.status,stage:x.stage||'in-progress',missing:require('./profile-completion-core').inspect(x).missing,revision:x.revision,createdInWorkshop:x.source==='owner-created-profile'}))};
  guard(e,scope);if(generation!==epoch(e))throw Error('Vault closed while loading.');return result;
 }
 async function addCard(e,p){
  const {scope,id}=await access(e,p),generation=epoch(e),vault=cardVault(scope),key=cardKey(scope,id);
  const current=await vault.list(key),number=String(p?.card?.number||'').replace(/\D/g,'');
  if(!/^\d{12,19}$/.test(number))throw Error('Enter a valid card number.');
  const next=(current?.cards?.length||0)+1;
  const card={...p.card,number,label:'Unlinked card '+next,cardholder:'Unassigned',brand:brandFromNumber(number)};
  delete card.id;
  return vault.addWorkshopCard(key,card,()=>{guard(e,scope);if(generation!==epoch(e))throw Error('Vault locked before save.');});
 }
 async function addAddress(e,p){const {scope,id}=await access(e,p),generation=epoch(e);return addressBanks.addWorkshopAddress(scope,id,p.address,()=>{guard(e,scope);if(generation!==epoch(e))throw Error('Vault locked before save.');});}
 async function manageResource(e,p){
  const {scope,id}=await access(e,p),generation=epoch(e),kind=p?.kind,operation=p?.operation,resourceId=String(p?.resourceId||'');
  if(!['card','address'].includes(kind)||!['update','remove'].includes(operation)||!resourceId)throw Error('Choose a saved card or address from this vault.');
  const beforeWrite=()=>{guard(e,scope);if(generation!==epoch(e))throw Error('Vault locked before save.');};
  if(kind==='card'){
   const vault=cardVault(scope),key=cardKey(scope,id),inventory=await vault.list(key),item=(inventory.cards||[]).find(x=>String(x.id)===resourceId);
   if(!item)throw Error('Saved card is no longer in this vault.');
   if(operation==='remove'){beforeWrite();return vault.remove(key,resourceId);}
   const number=String(p?.value?.number||'').replace(/\D/g,'');
   if(!/^\d{12,19}$/.test(number))throw Error('Enter a valid card number.');
   const full=(await vault.selectedForJig(key,[resourceId]))[0];
   return vault.updateWorkshopCard(key,resourceId,{...p.value,label:item.label||'Unlinked card',cardholder:full.cardholder||'Unassigned',brand:brandFromNumber(number),number},beforeWrite);
  }
  const inventory=await bank(scope,id),item=(inventory.addresses||[]).find(x=>String(x.id)===resourceId);
  if(!item)throw Error('Saved address is no longer in this vault.');
  if(operation==='remove'){beforeWrite();return scope==='personal'?addressBanks.removePersonal(resourceId):addressBanks.removeAco(id,resourceId);}
  return addressBanks.updateWorkshopAddress(scope,id,resourceId,p.value,beforeWrite);
 }
 async function create(e,p){const {scope,id}=await access(e,p),generation=epoch(e);const data=Draft.blank(p.retailer,p.format,p.fields||{},uuid);
  return profiles.createBlank(scope,id,p.retailer,p.format,data,()=>{guard(e,scope);if(generation!==epoch(e))throw Error('Vault locked before saving draft.');});}

 async function emails(e,p){const {scope,id}=await access(e,p),generation=epoch(e),result=await profiles.emailInventory(scope,id,p.retailer);guard(e,scope);if(generation!==epoch(e))throw Error('Vault closed while loading.');return result;}
 async function importEmails(e,p){const {scope,id}=await access(e,p),generation=epoch(e);return profiles.importEmails(scope,id,p.retailer,p.emails,()=>{guard(e,scope);if(generation!==epoch(e))throw Error('Vault closed before import.');});}
 async function generate(e,p){const {scope,id}=await access(e,p),generation=epoch(e);
  Draft.blank(p.retailer,p.format,{}); // Validate retailer and format before selecting assets.
  const aIDs=ids(p.addressIds,'addresses'),cIDs=ids(p.cardIds,'cards');
  return addressBanks.withWorkshopAddresses(scope,id,aIDs,addresses=>cardVault(scope).withSelectedForJig(cardKey(scope,id),cIDs,cards=>profiles.createEmailProfiles(scope,id,p.retailer,p.count,async(emails,inventory)=>{
   if(cards.some(c=>c.previouslyAssigned||inventory.some(v=>v.assetRefs?.cardId===c.id||numberOf(v.data)===c.number)))throw Error('A selected card is already used. Choose unused cards.');
   if(p.allowCardReuse!==true&&cards.length<emails.length)throw Error('Select one unused card per profile or enable balanced card reuse.');
   const records=emails.map((email,i)=>Draft.blank(p.retailer,p.format,{email,label:(p.label||'Profile')+' '+(i+1)},uuid));
   const result=Fields.build({records,indices:records.map((_,i)=>i),scope,customerId:id,addresses,cards,choices:{address:true,card:true,name:p.randomNames===true},allowCardReuse:p.allowCardReuse===true,mirrorBilling:true});
   for(const record of result.records)normalizeCardIdentity(record);
   return result.records.map((data,i)=>({data,format:p.format,assetRefs:{addressId:result.summary[i].addressId,cardId:result.summary[i].cardId}}));
  },()=>{guard(e,scope);if(generation!==epoch(e))throw Error('Vault closed before profile creation.');})));
 }

 async function edit(e,p){const {scope,id}=await access(e,p),generation=epoch(e);
  return profiles.editBlank(scope,id,p.profileId,p.revision,p.fields,()=>{guard(e,scope);if(generation!==epoch(e))throw Error('Vault locked before saving.');});}
 async function load(e,p){const {scope,id}=await access(e,p),generation=epoch(e),v=await profiles.preview(scope,id,p.profileId);
  const row=v.profile,masked=Draft.mask(row.data),entry=Draft.serializeProfile({...row,data:masked});
  guard(e,scope);if(generation!==epoch(e))throw Error('Vault locked during read.');
  return {scope,customerId:id,profileId:row.id,revision:row.revision,status:row.status,retailer:row.retailer,format:row.format||Draft.formatOf(row.data),fields:row.source==='owner-created-profile'?Draft.toValues(row.data):null,entry};
 }
 async function selected(scope,id,p,choices,callback){
  const aIDs=choices.address?ids(p.addressIds,'addresses'):[],cIDs=choices.card?ids(p.cardIds,'saved cards'):[];
  const run=async(addresses,cards)=>callback({addresses,cards,hash:Fields.hash({addresses,cards})});
  const withCards=addresses=>choices.card?cardVault(scope).withSelectedForJig(cardKey(scope,id),cIDs,cards=>run(addresses,cards)):run(addresses,[]);
  return choices.address?addressBanks.withWorkshopAddresses(scope,id,aIDs,withCards):withCards([]);
 }
 async function source(e,p,scope,id){
  if(p.profileIds){const all=await profiles.fieldSnapshot(scope,id),list=ids(p.profileIds,'saved profiles').map(key=>{const row=all.find(x=>x.id===key);if(!row)throw Error('A selected profile is not in this vault.');return row;});
   let entry;
   if(list.length===1)entry=Draft.serializeProfile(list[0]);
   else if(list.every(x=>Draft.formatOf(x.data)==='shikari')){const header=Object.keys(list[0].data);if(list.some(x=>!same(Object.keys(x.data),header)))throw Error('Select one consistent profile format.');entry={name:'selected-profiles.csv',text:Core.serialDelimited([header,...list.map(x=>header.map(k=>x.data[k]))],',','\r\n',true)};}
   else entry={name:'selected-profiles.json',text:JSON.stringify(list.map(x=>x.data),null,2)};
   return {parsed:Core.parseFile(entry.name,entry.text),matched:list.map((r,index)=>({index,id:r.id,retailer:r.retailer,revision:r.revision||0,expectedHash:Fields.hash(r.data)})),indices:list.map((_,i)=>i),mapping:null};
  }
  const s=p.source;
  if(!s||typeof s.fileName!=='string'||s.fileName!==path.basename(s.fileName)||s.fileName.length>200||!/\.(csv|tsv|tab|psv|json|jsonl|ndjson|txt)$/i.test(s.fileName)||typeof s.text!=='string'||Buffer.byteLength(s.text)>26*1024*1024||s.scope!==scope||(s.customerId||null)!==(id||null))throw Error('This imported file does not belong to the selected vault.');
  if(scope==='aco'&&s.personalOnly)throw Error('Personal-only files cannot use a customer vault.');
  const parsed=Core.parseFile(s.fileName,s.text);Fields.validateRows(parsed.records,p.indices);
  for(const r of [parsed.root,...parsed.records])if(r&&typeof r==='object'){
   if((r.customerId&&String(r.customerId)!==id)||(r.acoCustomerId&&String(r.acoCustomerId)!==id)||(r.scope&&['aco','personal'].includes(r.scope)&&r.scope!==scope))throw Error('Profile file ownership conflicts with this vault.');
  }
  const local=await profiles.fieldSnapshot(scope,id);
  const matched=p.indices.map(index=>{const exact=local.filter(x=>same(x.data,parsed.records[index]));return exact.length===1?{index,id:exact[0].id,retailer:exact[0].retailer,revision:exact[0].revision||0,expectedHash:Fields.hash(exact[0].data)}:null;});
  return {parsed,indices:p.indices,matched,mapping:p.mapping||Core.autoMap(parsed.records)};
 }
 async function preview(e,p){expired();const {scope,id}=await access(e,p),generation=epoch(e),choices=Fields.selection(p.choices);
  if(typeof p.contextKey!=='string'||p.contextKey.length>32768)throw Error('Profile selection context is missing.');
  const src=await source(e,p,scope,id);Fields.validateRows(src.parsed.records,src.indices);
  let result,resourcesHash;
  await selected(scope,id,p,choices,async r=>{
   if(choices.card&&p.unusedOnly!==false){const inventory=await profiles.fieldSnapshot(scope,id);const legacy=new Set(r.cards.filter(c=>c.previouslyAssigned).map(c=>c.id));
    // Legacy assignment state was captured under the same card-vault lock.
    if(r.cards.some(c=>inventory.some(v=>v.assetRefs?.cardId===c.id||numberOf(v.data)===c.number)||legacy.has(c.id)))throw Error('A selected card is already in use. Choose unused cards or disable the Unused only filter.');
   }
   result=Fields.build({records:src.parsed.records,indices:src.indices,choices,mapping:src.mapping,scope,customerId:id,...r,allowCardReuse:p.allowCardReuse===true,mirrorBilling:p.mirrorBilling===true,addressOptions:p.addressOptions||{}});if(choices.card)for(const record of result.records)normalizeCardIdentity(record);resourcesHash=r.hash;
  });
  const text=Core.serialize(src.parsed,result.records);if(!same(Core.parseFile(src.parsed.name,text).records,result.records))throw Error('Output validation failed. Nothing was changed.');
  guard(e,scope);if(generation!==epoch(e))throw Error('Vault closed during preview.');
  const canSave=src.matched.every(Boolean)&&new Set(src.matched.map(x=>x?.id)).size===src.indices.length;
  while([...plans.values()].filter(x=>x.sender===e.sender.id).length>=6){const [key]=[...plans].find(([,v])=>v.sender===e.sender.id);plans.delete(key);}
  const token=uuid(),plan={jigged:choices.address&&p.addressOptions?.applyStyles===true,token,sender:e.sender.id,scope,id,choices,src,result,text,resourcesHash,contextKey:p.contextKey,addressIds:choices.address?[...p.addressIds]:[],cardIds:choices.card?[...p.cardIds]:[],unusedOnly:p.unusedOnly!==false,created:now(),canSave,saved:false,applied:false,busy:false};plans.set(token,plan);
  return {token,contextKey:p.contextKey,scope,customerId:id,choices,canSave,selected:src.indices.length,changed:result.stats.changed,preview:result.summary.slice(0,60)};
 }
 async function get(e,p){expired();if(!p||Object.keys(p).some(k=>!['token','contextKey','confirmed'].includes(k)))throw Error('Confirmation cannot replace the rows, fields or vault.');
  const plan=plans.get(p.token);if(!plan||plan.sender!==e.sender.id)throw Error('This preview expired or was cancelled. Preview again.');
  if(p.contextKey!==plan.contextKey)throw Error('Selection changed. Preview again.');await access(e,{scope:plan.scope,customerId:plan.id});
  if(plans.get(plan.token)!==plan)throw Error('Preview was cancelled.');return plan;
 }
 async function verifyResources(e,plan,callback){return selected(plan.scope,plan.id,plan,plan.choices,async r=>{
  if(plan.choices.card&&plan.unusedOnly&&!plan.saved&&r.cards.some(c=>c.previouslyAssigned))throw Error('A selected card was assigned after preview. Choose another card.');
  if(r.hash!==plan.resourcesHash)throw Error('Saved cards or addresses changed after preview. Preview again.');guard(e,plan.scope);if(plans.get(plan.token)!==plan)throw Error('Preview cancelled.');return callback(r);
 });}
 async function apply(e,p){const plan=await get(e,p);if(!p.confirmed)throw Error('Confirm the preview first.');return verifyResources(e,plan,()=>{plan.applied=true;return {token:plan.token,contextKey:plan.contextKey,records:plan.result.display,original:plan.src.parsed.records.map(Draft.mask),changedKeys:plan.result.changes.map(xs=>xs.map(v=>JSON.parse(v).join('.'))),notes:plan.result.notes,stats:plan.result.stats,valid:true,requiresSecureExport:true,canSave:plan.canSave};});}
 async function save(e,p){const plan=await get(e,p);if(p.confirmed!==true||!plan.canSave)throw Error('Confirm exact saved profiles in this vault before applying.');if(plan.saved||plan.busy)throw Error('This batch was already saved or is saving.');plan.busy=true;const generation=epoch(e);
  try{return await verifyResources(e,plan,async r=>{
   const changes=plan.src.matched.map(m=>({profileId:m.id,retailer:m.retailer,expectedRevision:m.revision,expectedHash:m.expectedHash,data:plan.result.records[m.index],allowed:plan.result.allowed[m.index],assetRefs:{addressId:plan.choices.address?plan.result.summary.find(x=>x.index===m.index).addressId:undefined,cardId:plan.choices.card?plan.result.summary.find(x=>x.index===m.index).cardId:undefined}}));
   const result=await profiles.applyFieldBatch(plan.scope,plan.id,changes,plan.choices,{unusedOnly:plan.unusedOnly,cards:r.cards,jigged:plan.jigged},()=>{guard(e,plan.scope);if(generation!==epoch(e)||plans.get(plan.token)!==plan)throw Error('Vault locked or preview cancelled before saving.');});
   plan.saved=true;plan.applied=true;return {...result,saved:true};
  });}finally{plan.busy=false;}
 }
 async function exportFile(e,p){const plan=await get(e,p);if(!plan.applied)throw Error('Apply the preview before exporting.');
  if(!await confirmExport(e))return {cancelled:true};const ext=path.extname(plan.src.parsed.name),name=path.basename(plan.src.parsed.name,ext)+'-updated'+ext;
  const choice=await chooseSave(e,{name,extension:ext.slice(1)});if(choice.canceled||!choice.filePath)return {cancelled:true};
  if(path.extname(choice.filePath).toLowerCase()!==ext.toLowerCase())throw Error('Keep the original file format.');
  await get(e,p);return verifyResources(e,plan,async()=>{await writeFile(choice.filePath,plan.text,{encoding:'utf8',mode:0o600});return {saved:true,name:path.basename(choice.filePath),count:plan.src.indices.length};});
 }
 async function exportSaved(e,p){const {scope,id}=await access(e,p),v=await profiles.preview(scope,id,p.profileId);if(!await confirmExport(e))return {cancelled:true};const entry=Draft.serializeProfile(v.profile),ext=path.extname(entry.name),choice=await chooseSave(e,{name:entry.name,extension:ext.slice(1)});
  if(choice.canceled||!choice.filePath)return {cancelled:true};if(path.extname(choice.filePath).toLowerCase()!==ext)throw Error('Keep the selected profile format.');const latest=await profiles.preview(scope,id,p.profileId);if(latest.profile.revision!==v.profile.revision)throw Error('Profile changed before export. Try again.');guard(e,scope);await writeFile(choice.filePath,entry.text,{encoding:'utf8',mode:0o600});return {saved:true};
 }
 return Object.freeze({assets,addCard,addAddress,manageResource,emails,importEmails,generate,create,edit,load,preview,apply,save,exportFile,exportSaved,cancel});
}
function registerWorkshop(options){const service=createWorkshop(options);for(const method of ['assets','addCard','addAddress','manageResource','emails','importEmails','generate','create','edit','load','preview','apply','save','exportFile','exportSaved'])options.ipcMain.handle('profile:workshop:'+method,(e,p)=>service[method](e,p));options.ipcMain.handle('profile:workshop:cancel',(e,t)=>{options.requireOwner(e);return service.cancel(e,t);});return service;}
module.exports={createWorkshop,registerWorkshop,numberOf};
