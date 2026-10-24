'use strict';
const path=require('node:path'),fs=require('node:fs/promises'),crypto=require('node:crypto');
const Core=require('./app'),Fields=require('./jig-field-core'),Draft=require('./profile-draft-core'),CardPolicy=require('./card-pool-policy');
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
function syncCardholderToProfileName(row){
 const out=structuredClone(row),v=Draft.toValues(out),holder=(String(v.first||'')+' '+String(v.last||'')).replace(/\s+/g,' ').trim();
 if(!holder||!numberOf(out))return out;
 if(Draft.formatOf(out)==='shikari')out.cc_name=holder;
 else out.card={...(out.card||{}),holder,cardholder:holder};
 return out;
}
function normalizedAddressPart(v){return String(v||'').trim().toUpperCase().replace(/\s+/g,' ');}
function mainAddressKey(row){
 const v=Draft.toValues(row);
 return ['shipping.address1','shipping.address2','shipping.city','shipping.state','shipping.zip'].map(k=>normalizedAddressPart(v[k])).join('|');
}
function targetPrimaryVariant(row,position,options,mirrorBilling){
 if(options?.retailerPreset!=='target'||options?.applyStyles!==true)return row;
 const selected=options.targetPrimary||{},variants=[];
 if(selected.fraction)variants.push({kind:'fraction',value:'1/2'},{kind:'fraction',value:'1/3'},{kind:'fraction',value:'1/4'});
 if(selected.alpha)for(const letter of 'ABCDEFGH')variants.push({kind:'alpha',value:letter});
 if(!variants.length||position<0)return row;
 const variant=variants[position%variants.length],v=Draft.toValues(row),street=String(v['shipping.address1']||'').trim();
 if(!/^\d+\s/.test(street))return row;
 const changed=variant.kind==='fraction'?street.replace(/^(\d+)(?=\s)/,'$1 '+variant.value):street.replace(/^(\d+)(?=\s)/,'$1-'+variant.value);
 const edits={...v,'shipping.address1':changed};
 if(mirrorBilling)edits['billing.address1']=changed;
 return Draft.manualEdit(row,edits);
}
function restoreBaseAddress(row,base,mirrorBilling){
 const current=Draft.toValues(row),source=Draft.toValues(base),edits={...current};
 for(const key of ['address1','address2','city','state','zip','country'])edits['shipping.'+key]=source['shipping.'+key];
 if(mirrorBilling)for(const key of ['address1','address2','city','state','zip','country'])edits['billing.'+key]=source['shipping.'+key];
 else for(const key of ['address1','address2','city','state','zip','country'])edits['billing.'+key]=source['billing.'+key];
 return Draft.manualEdit(row,edits);
}
function applyTargetPrimary(result,baseRecords,indices,options,mirrorBilling){
 if(options?.applyStyles!==true)return;
 const groups=new Map(),groupSizes=new Map(),softCount=Math.max(0,Array.isArray(options?.rules)?options.rules.length:0);
 for(const index of indices){const key=mainAddressKey(baseRecords[index]);groupSizes.set(key,(groupSizes.get(key)||0)+1);}
 for(const index of indices){
  const base=baseRecords[index],key=mainAddressKey(base),position=groups.get(key)||0;groups.set(key,position+1);
  let after=result.records[index];
  // Preserve an original only when multiple source profiles already share a
  // complete base address. Blank drafts must receive their selected vault address.
  const source=Draft.toValues(base),hasOriginal=['shipping.address1','shipping.city','shipping.state','shipping.zip'].every(k=>String(source[k]||'').trim());
  if(position===0&&groupSizes.get(key)>1&&hasOriginal)after=restoreBaseAddress(after,base,mirrorBilling);
  else if(options?.retailerPreset==='target'&&(options?.targetPrimary?.fraction||options?.targetPrimary?.alpha)){
   // Use the standard/soft formatting choices first for this main address.
   // Hard Target primary-number variants begin only after those have had a
   // chance to appear, and never stack unless the separate combine option is on.
   const hardPosition=position-1-softCount;
   if(hardPosition>=0)after=targetPrimaryVariant(after,hardPosition,options,mirrorBilling);
  }
  result.records[index]=after;
  const summary=result.summary?.find(x=>x.index===index),v=Draft.toValues(after);
  if(summary)summary.address=[{role:'shipping',text:[v['shipping.address1'],v['shipping.address2'],v['shipping.city'],v['shipping.state'],v['shipping.zip']].filter(Boolean).join(', ')}];
 }
 result.stats={...(result.stats||{}),changed:indices.filter(index=>!same(baseRecords[index],result.records[index])).length};
}
function applyCategoryCounts(result,indices,options,selectedAddresses,mirrorBilling){
 const input=options?.hardCounts;if(!input)return false;
 const names=['fraction','hyphen','doubleLetter','randomUnit'],limits={};
 if(Object.keys(input).some(k=>!names.includes(k)))throw Error('Unknown hard Jig category.');
 for(const name of names){const n=input[name]??0;if(!Number.isInteger(n)||n<0||n>500)throw Error('Hard Jig counts must be whole numbers from 0 to 500.');limits[name]=n;}
 if(!names.some(k=>limits[k]))return false;
 const lookup=new Map(selectedAddresses.map(a=>[a.id,a])),groups=new Map();
 for(const index of indices){
  const info=result.summary?.find(x=>x.index===index);
  const key=info?.addressId||mainAddressKey(result.records[index]);
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push({index,info,key});
 }
 for(const entries of groups.values()){
  const first=entries[0],addr=lookup.get(first.key),values=Draft.toValues(result.records[first.index]);
  const base={address1:addr?.address1||values['shipping.address1'],address2:addr?.address2||values['shipping.address2'],city:addr?.city||values['shipping.city'],state:addr?.state||values['shipping.state'],zip:addr?.zip||values['shipping.zip']};
  const used={fraction:0,hyphen:0,doubleLetter:0,randomUnit:0},taken=new Set();
  for(let position=0;position<entries.length;position++){
   const {index,info}=entries[position],original=position===0&&entries.length>1;
   let out={...base},kind='original';
   if(!original){
    const candidates=names.filter(k=>used[k]<limits[k]).sort((a,b)=>(used[a]-used[b])||(names.indexOf(a)-names.indexOf(b)));
    let found=false;
    for(const candidate of candidates){
     const variants=candidate==='fraction'?['1/2','1/3','1/4']:candidate==='hyphen'?'ABCDEFGH'.split(''):candidate==='doubleLetter'?String(base.address1).replace(/^\d+\s+/,'').split(/\W/)[0].split(''):Array.from({length:500},(_,i)=>String(101+i));
     for(let i=0;i<variants.length;i++){
      const next={...base},street=String(base.address1||'');
      if(candidate==='fraction'&&/^\d+\s+/.test(street))next.address1=street.replace(/^(\d+)(?=\s)/,'$1 '+variants[i]);
      else if(candidate==='hyphen'&&/^\d+\s+/.test(street))next.address1=street.replace(/^(\d+)(?=\s)/,'$1-'+variants[i]);
      else if(candidate==='doubleLetter'){
       const m=/^(\d+\s+)([A-Za-z]{3,})(.*)$/.exec(street);
       if(!m||i>=m[2].length)break;
       next.address1=m[1]+m[2].slice(0,i+1)+m[2][i]+m[2].slice(i+1)+m[3];
      }else if(candidate==='randomUnit'){
       if(base.address2||/\b(?:apt|apartment|unit|suite|ste|condo)\b|#\s*\w/i.test(street))break;
       next.address2='Unit '+variants[i];
      }else break;
      const key=[next.address1,next.address2,next.city,next.state,next.zip].join('|').toUpperCase();
      if(key!==[base.address1,base.address2,base.city,base.state,base.zip].join('|').toUpperCase()&&!taken.has(key)){out=next;kind=candidate;used[candidate]++;found=true;break;}
     }
     if(found)break;
    }
    if(!found){
     const v=Draft.toValues(result.records[index]),soft={address1:v['shipping.address1'],address2:v['shipping.address2'],city:v['shipping.city'],state:v['shipping.state'],zip:v['shipping.zip']};
     const key=Object.values(soft).join('|').toUpperCase();
     if(key!==Object.values(base).join('|').toUpperCase()&&!taken.has(key)){out=soft;kind='soft';found=true;}
    }
    if(!found)throw Error('Not enough unique address Jig variations for '+base.address1+'. Increase eligible category counts, enable soft rules, or reduce profiles.');
   }
   const id=[out.address1,out.address2,out.city,out.state,out.zip].join('|').toUpperCase();
   if(taken.has(id))throw Error('Duplicate jig address blocked.');taken.add(id);
   const changes={...Draft.toValues(result.records[index])};
   for(const key of ['address1','address2','city','state','zip']){changes['shipping.'+key]=out[key]||'';if(mirrorBilling)changes['billing.'+key]=out[key]||'';}
   result.records[index]=Draft.manualEdit(result.records[index],changes);
   if(info){info.category=kind;info.mainAddress=base;info.address=[{role:'shipping',text:[out.address1,out.address2,out.city,out.state,out.zip].filter(Boolean).join(', ')}];}
  }
 }
 return true;
}
function createWorkshop({authorize,guard,profiles,addressBanks,cardVault,chooseSave,confirmExport,writeFile=fs.writeFile,now=Date.now,uuid=crypto.randomUUID}={}){
 const plans=new Map(),epochs=new Map();
 const epoch=e=>epochs.get(e.sender.id)||0;
 function cancel(e,token){if(token){if(plans.get(token)?.sender===e.sender.id)plans.delete(token);}else{epochs.set(e.sender.id,epoch(e)+1);for(const [t,p]of plans)if(p.sender===e.sender.id)plans.delete(t);}return {cancelled:true};}
 async function access(e,p){Fields.scopeKey(p?.scope,p?.customerId);const id=await authorize(e,p.scope,p.customerId);if(p.scope==='aco'&&id!==p.customerId)throw Error('Customer vault mismatch.');guard(e,p.scope);return {scope:p.scope,id};}
 const bank=async(s,id)=>s==='personal'?addressBanks.listPersonal():addressBanks.listAco(id);
 function expired(){for(const [t,p]of plans)if(now()-p.created>600000&&!p.busy)plans.delete(t);}
 async function assets(e,p){const {scope,id}=await access(e,p),generation=epoch(e);
  const [a,c,rows,settings]=await Promise.all([bank(scope,id),cardVault(scope).list(cardKey(scope,id)),profiles.fieldSnapshot(scope,id),profiles.librarySettings(scope,id)]);
  const full=c.cards.length?await cardVault(scope).selectedForJig(cardKey(scope,id),c.cards.map(x=>x.id)):[];
  const assigned=new Set((c.assignments||[]).map(x=>x.cardId));
  const cardPool=CardPolicy.inventory({rows,savedCards:full,settings});
  // Legacy card assignments can outlive a deleted/moved profile. Keep those
  // cards unavailable until reconciled; do not silently return them to Unused.
  for(const item of cardPool){
   if(!item.fromSavedBank||!assigned.has(item.id.slice(6))||item.linkedCount)continue;
   item.status='Previously assigned · review required';
   item.availableRetailers=[];
   item.hasConflict=true;
  }
  const retailerSeq={};
  const cards=c.cards.map((x,index)=>{
   const raw=full.find(y=>y.id===x.id),users=rows.filter(r=>r.assetRefs?.cardId===x.id||numberOf(r.data)===raw?.number),used=users.length,first=users[0];
   let label='Unlinked card '+(index+1),displayHolder='';
   if(first?.retailer){retailerSeq[first.retailer]=(retailerSeq[first.retailer]||0)+1;label=({target:'Target',walmart:'Walmart',pokemoncenter:'PKC',costco:'Costco',sams:"Sam's"}[first.retailer]||first.retailer)+' '+retailerSeq[first.retailer];displayHolder=profileNameFor(first);}
   const assignedUses=CardPolicy.profileUses(rows).get(raw?.number)||[];
   const isHard=CardPolicy.hardCard(raw?.number,settings);
   const eligibleRetailers=isHard?CardPolicy.RETAILERS.filter(ret=>!assignedUses.some(usage=>usage.retailer===ret)):assignedUses.length?[]:[...CardPolicy.RETAILERS];
   const unresolved=assigned.has(x.id)&&!assignedUses.length;
   const eligible=!unresolved&&(!p.retailer||!CardPolicy.RETAILERS.includes(p.retailer)?eligibleRetailers.length>0:eligibleRetailers.includes(p.retailer));
   return {...x,label,...(p.showFullCards===true?{number:raw.number,cardholder:displayHolder,expMonth:raw.month,expYear:raw.year,brand:brandFromNumber(raw.number),customReference:raw.customSecurityCode||''}:{}),usedCount:used,unused:eligible,hardCard:isHard,eligibleRetailers:unresolved?[]:eligibleRetailers,previouslyAssigned:assigned.has(x.id)};
  });
  const result={scope,customerId:id,cardPool,addresses:a.addresses.map(x=>({...x,uses:rows.filter(r=>r.assetRefs?.addressId===x.id).length})),cards,profiles:rows.map(x=>({id:x.id,label:x.label,email:x.email,retailer:x.retailer,bank:x.bank||'working',status:x.status,stage:x.stage||'in-progress',missing:require('./profile-completion-core').inspect(x).missing,revision:x.revision,createdInWorkshop:x.source==='owner-created-profile'}))};
  guard(e,scope);if(generation!==epoch(e))throw Error('Vault closed while loading.');return result;
 }
 async function addCard(e,p){
  const {scope,id}=await access(e,p),generation=epoch(e),vault=cardVault(scope),key=cardKey(scope,id);
  const current=await vault.list(key),number=String(p?.card?.number||'').replace(/\D/g,'');
  if(!/^\d{12,19}$/.test(number))throw Error('Enter a valid card number.');
  const next=(current?.cards?.length||0)+1;
  const card={...p.card,number,label:'Unlinked card '+next,cardholder:String(p?.card?.cardholder||'').trim()||'Unassigned',brand:brandFromNumber(number)};
  delete card.id;
  return vault.addWorkshopCard(key,card,()=>{guard(e,scope);if(generation!==epoch(e))throw Error('Vault locked before save.');});
 }
 async function setHardCard(e,p){
  const {scope,id}=await access(e,p),generation=epoch(e);
  const check=()=>{guard(e,scope);if(epoch(e)!==generation)throw Error('Vault locked or changed before saving the Hard Card update.');};
  if(p?.confirmed!==true||typeof p?.hard!=='boolean')throw Error('Confirm the Hard Card setting for this vault.');
  const saved=await cardVault(scope).list(cardKey(scope,id));
  const full=saved.cards.length?await cardVault(scope).selectedForJig(cardKey(scope,id),saved.cards.map(x=>x.id)):[];
  const rows=await profiles.fieldSnapshot(scope,id),number=CardPolicy.resolveReference(p.cardRef,rows,full);
  return profiles.libraryTransaction(scope,id,ctx=>{
   const next=CardPolicy.toggle(ctx.settings,number,p.hard);
   if(!p.hard&&CardPolicy.violations(ctx.rows,next).some(x=>x.fingerprint===number))
    throw Error('This card is linked to several retailers. Keep Hard Card on until those extra assignments are removed.');
   ctx.settings=next;
   return {saved:true,hardCard:p.hard,last4:number.slice(-4)};
  },check);
 }
 // Imported profile cards become selectable saved-bank resources without
 // copying unrelated per-profile Security Code fields.
 async function addProfileCardToBank(e,p){
  const {scope,id}=await access(e,p),generation=epoch(e);
  const check=()=>{guard(e,scope);if(epoch(e)!==generation)throw Error('Vault locked or changed before saving the Hard Card update.');};
  if(p?.confirmed!==true||typeof p?.profileId!=='string')throw Error('Confirm the imported profile card to add.');
  const rows=await profiles.fieldSnapshot(scope,id),row=rows.find(x=>x.id===p.profileId);
  if(!row)throw Error('Profile not found in this vault.');
  const number=CardPolicy.fromProfile(row),info=require('./profile-library-core').payment(row.data);
  if(!CardPolicy.normalized(number)||!info.month||!info.year)throw Error('This imported card needs a valid number and expiration.');
  const key=cardKey(scope,id),vault=cardVault(scope),existing=await vault.list(key);
  const full=existing.cards.length?await vault.selectedForJig(key,existing.cards.map(x=>x.id)):[];
  if(full.some(x=>x.number===number))return {saved:false,alreadyExists:true};
  const entry={number,month:info.month,year:info.year,cardholder:info.cardholder||'Unassigned',label:'Imported profile card',brand:brandFromNumber(number)};
  return vault.addWorkshopCard(key,entry,check);
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
  return addressBanks.withWorkshopAddresses(scope,id,aIDs,addresses=>cardVault(scope).withSelectedForJig(cardKey(scope,id),cIDs,cards=>profiles.createEmailProfiles(scope,id,p.retailer,p.count,async(emails,inventory,accounts=[],settings={})=>{
   if(cards.some(c=>c.previouslyAssigned&&!inventory.some(v=>v.assetRefs?.cardId===c.id||numberOf(v.data)===c.number)))
    throw Error('A saved card has an unresolved historical assignment. Review it before reusing.');
   if(cards.length<emails.length)throw Error('Select one distinct card per profile. Hard Cards cannot be reused within the same retailer.');
   CardPolicy.checkAllocation(inventory,p.retailer,cards.slice(0,emails.length),settings,{excludeProfileIds:accounts.filter(Boolean).map(x=>x.id)});
   const records=emails.map((email,i)=>Draft.blank(p.retailer,p.format,{...(accounts[i]?Draft.toValues(accounts[i].data):{}),email,label:(p.label||'Profile')+' '+(i+1)},uuid));
   const result=Fields.build({records,indices:records.map((_,i)=>i),scope,customerId:id,addresses,cards,choices:{address:true,card:true,name:p.randomNames===true},allowCardReuse:false,mirrorBilling:true});
   CardPolicy.checkAllocation(inventory,p.retailer,result.records.map(data=>CardPolicy.fromProfile({data})),settings,{excludeProfileIds:accounts.filter(Boolean).map(x=>x.id)});
   return result.records.map((data,i)=>({data:syncCardholderToProfileName(data),format:p.format,assetRefs:{addressId:result.summary[i].addressId,cardId:result.summary[i].cardId}}));
  },()=>{guard(e,scope);if(generation!==epoch(e))throw Error('Vault closed before profile creation.');},p.emailIds??null)));
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
   if(choices.card&&p.unusedOnly!==false){
    const inventory=await profiles.fieldSnapshot(scope,id);
    if(r.cards.some(c=>c.previouslyAssigned&&!inventory.some(v=>v.assetRefs?.cardId===c.id||numberOf(v.data)===c.number)))
     throw Error('A selected card has an unresolved historical assignment. Review its inventory first.');
   }
   result=Fields.build({records:src.parsed.records,indices:src.indices,choices,mapping:src.mapping,scope,customerId:id,...r,allowCardReuse:p.allowCardReuse===true,mirrorBilling:p.mirrorBilling===true,addressOptions:p.addressOptions||{}});
   if(choices.address){
    const extras=p.addressOptions?.extraAllocation||{},addressMap=new Map(r.addresses.map(a=>[a.id,a]));
    if(Object.keys(extras).some(id=>!addressMap.has(id)||!Number.isInteger(extras[id])||extras[id]<0||extras[id]>500))throw Error('Extra allocation must be a whole number for a selected address.');
    const total=Object.values(extras).reduce((sum,n)=>sum+n,0);
    if(total>src.indices.length)throw Error('Extra address allocation exceeds selected profile count.');
    if(total){
     const quotas=new Map(r.addresses.map(a=>[a.id,extras[a.id]||0]));
     for(let i=0;i<src.indices.length-total;i++){const a=r.addresses[i%r.addresses.length];quotas.set(a.id,quotas.get(a.id)+1);}
     const allocation=[];let left=true;
     while(left){left=false;for(const address of r.addresses){const count=quotas.get(address.id)||0;if(count>0){allocation.push(address);quotas.set(address.id,count-1);left=true;}}}
     src.indices.forEach((index,pos)=>{
      const addr=allocation[pos],values=Draft.toValues(result.records[index]),changes={...values};
      for(const k of ['address1','address2','city','state','zip']){
       changes['shipping.'+k]=String(addr[k]||'');
       if(p.mirrorBilling===true)changes['billing.'+k]=changes['shipping.'+k];
      }
      result.records[index]=Draft.manualEdit(result.records[index],changes);
      const summary=result.summary?.find(x=>x.index===index);
      if(summary){summary.addressId=addr.id;summary.address=[{role:'shipping',text:[addr.address1,addr.address2,addr.city,addr.state,addr.zip].filter(Boolean).join(', ')}];}
     });
    }
    if(!applyCategoryCounts(result,src.indices,p.addressOptions||{},r.addresses,p.mirrorBilling===true)&&!total)applyTargetPrimary(result,src.parsed.records,src.indices,p.addressOptions||{},p.mirrorBilling===true);
   }
   if(choices.address||choices.card||choices.name)for(const index of src.indices)result.records[index]=syncCardholderToProfileName(result.records[index]);
   if(choices.card){
    const existing=await profiles.fieldSnapshot(scope,id),settings=await profiles.librarySettings(scope,id);
    const exclude=new Set(src.matched.filter(Boolean).map(x=>x.id)),staged=existing.filter(x=>!exclude.has(x.id));
    for(const index of src.indices){
     const match=src.matched.find(x=>x?.index===index);
     const retailer=match?.retailer||p.addressOptions?.retailerPreset||'target';
     const n=CardPolicy.fromProfile({data:result.records[index]});
     if(n){CardPolicy.checkAllocation(staged,retailer,[n],settings);staged.push({id:'jig-preview-'+index,retailer,data:result.records[index]});}
    }
   }
   resourcesHash=r.hash;
  });
  const text=Core.serialize(src.parsed,result.records),roundTrip=Core.parseFile(src.parsed.name,text);
  // Validate the exported representation itself. Serializers are allowed to
  // normalize harmless empty/type details during the first round trip.
  const normalizedText=Core.serialize(roundTrip,roundTrip.records);
  const normalizedAgain=Core.parseFile(roundTrip.name||src.parsed.name,normalizedText);
  if(roundTrip.records.length!==result.records.length||!same(normalizedAgain.records,roundTrip.records))throw Error('Output validation failed. Nothing was changed.');
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
  if(plan.choices.card&&plan.unusedOnly&&!plan.saved){
   const current=await profiles.fieldSnapshot(plan.scope,plan.id);
   if(r.cards.some(c=>c.previouslyAssigned&&!current.some(row=>row.assetRefs?.cardId===c.id||numberOf(row.data)===c.number)))
    throw Error('A card assignment changed since preview. Reload card inventory.');
  }
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
 return Object.freeze({assets,addCard,addAddress,setHardCard,addProfileCardToBank,manageResource,emails,importEmails,generate,create,edit,load,preview,apply,save,exportFile,exportSaved,cancel});
}
function registerWorkshop(options){const service=createWorkshop(options);for(const method of ['assets','addCard','addAddress','setHardCard','addProfileCardToBank','manageResource','emails','importEmails','generate','create','edit','load','preview','apply','save','exportFile','exportSaved'])options.ipcMain.handle('profile:workshop:'+method,(e,p)=>service[method](e,p));options.ipcMain.handle('profile:workshop:cancel',(e,t)=>{options.requireOwner(e);return service.cancel(e,t);});return service;}
module.exports={createWorkshop,registerWorkshop,numberOf};

