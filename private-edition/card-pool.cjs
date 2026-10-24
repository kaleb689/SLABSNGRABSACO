"use strict";
const crypto=require("node:crypto");
const Formats=require("./formats.cjs");
const RETAILERS=["target","walmart","pokemoncenter","costco","sams"];
const digits=v=>String(v??"").replace(/\D/g,"");
const numberOf=row=>digits(row?.[Formats.findField(row,Formats.aliases.cardNumber)]||"");
const expiryOf=row=>String(row?.[Formats.findField(row,Formats.aliases.cardExpiry)]||"").trim();
const validNumber=n=>/^\d{12,19}$/.test(n);
function sourceEntries(v) {
 const result=[];
 for(const source of v.sources||[]){
  if(!RETAILERS.includes(source.retailer))continue;
  (source.file?.rows||[]).forEach((row,index)=>{
   const number=numberOf(row);
   if(!validNumber(number))return;
   result.push({ref:"profile:"+source.id+":"+index,number,retailer:source.retailer,
    expiry:expiryOf(row),email:String(row?.[Formats.findField(row,Formats.aliases.email)]||'').slice(0,200),sourceId:source.id,index,sourceFile:source.file.filename});
  });
 }
 return result;
}
function ensureSettings(v){
 if(!v.cardPool||typeof v.cardPool!=="object")v.cardPool={salt:crypto.randomBytes(32).toString("hex"),hard:[]};
 if(!/^[a-f0-9]{64}$/.test(v.cardPool.salt||""))v.cardPool.salt=crypto.randomBytes(32).toString("hex");
 if(!Array.isArray(v.cardPool.hard))v.cardPool.hard=[];
 return v.cardPool;
}
function fingerprint(v,number){
 const settings=v.cardPool,n=digits(number);
 if(!settings||!/^[a-f0-9]{64}$/.test(settings.salt||"")||!validNumber(n))return "";
 return crypto.createHmac("sha256",Buffer.from(settings.salt,"hex")).update(n).digest("hex");
}
function isHard(v,number){const token=fingerprint(v,number);return !!token&&Array.isArray(v.cardPool?.hard)&&v.cardPool.hard.includes(token);}
function cardFromRef(v,ref){
 const saved=/^saved:([a-z0-9-]{1,150})$/i.exec(ref||"");
 if(saved){const card=(v.cards||[]).find(x=>x.id===saved[1]);if(card&&validNumber(digits(card.number)))return digits(card.number);}
 const profile=/^profile:([a-z0-9-]{1,150}):(\d{1,5})$/i.exec(ref||"");
 if(profile){const source=(v.sources||[]).find(x=>x.id===profile[1]),row=source?.file?.rows?.[Number(profile[2])];if(row&&validNumber(numberOf(row)))return numberOf(row);}
 throw Error("This card does not belong to the active private vault.");
}
function scanVault(v,cardNumber){
 const number=digits(cardNumber);
 if(!validNumber(number))throw Error("Select a complete card from this private vault.");
 const byRetailer=Object.fromEntries(RETAILERS.map(retailer=>[retailer,{profiles:0,working:0,live:0}]));
 let matchedProfiles=0;
 for(const entry of sourceEntries(v)){
  if(entry.number!==number)continue;
  matchedProfiles++;
  const counts=byRetailer[entry.retailer];counts.profiles++;
  if((v.sources||[]).some(source=>source.id===entry.sourceId&&source.bank==="live"))counts.live++;
  else counts.working++;
 }
 const savedCardCopies=(v.cards||[]).filter(c=>digits(c.number)===number).length;
 return {matchedProfiles,savedCardCopies,matchingEntries:matchedProfiles+savedCardCopies,byRetailer};
}
function toggle(v,ref,hard){
 if(typeof hard!=="boolean")throw Error("Select Hard Card on or off.");
 const n=cardFromRef(v,ref),settings=ensureSettings(v),token=fingerprint(v,n),set=new Set(settings.hard);
 if(!hard&&sourceEntries(v).filter(row=>row.number===n).length>1)throw Error("Card has multiple retailer assignments. Resolve them before turning off Hard Card.");
 if(hard)set.add(token);else set.delete(token);
 settings.hard=[...set].slice(0,15000);
 return {saved:true,hardCard:hard,last4:n.slice(-4),...scanVault(v,n)};
}
function inventory(v,{showFullNumbers=false}={}){
 const byNumber=new Map();
 const add=(n,ref,meta={})=>{
  n=digits(n);if(!validNumber(n))return;
  let item=byNumber.get(n);
  if(!item){item={number:n,ref,fromSavedBank:false,expiry:"",label:"",uses:[],brand:""};byNumber.set(n,item);}
  if(meta.saved){item.fromSavedBank=true;item.ref=ref;}
  item.expiry=item.expiry||meta.expiry||"";
  item.label=item.label||meta.label||"";
  if(meta.use)item.uses.push(meta.use);
 };
 for(const entry of sourceEntries(v))add(entry.number,entry.ref,{expiry:entry.expiry,use:{retailer:entry.retailer,email:entry.email,sourceId:entry.sourceId,index:entry.index}});
 for(const card of v.cards||[])add(card.number,"saved:"+card.id,{saved:true,expiry:card.expiry,label:card.label});
 return [...byNumber.values()].map(card=>{
  const hard=isHard(v,card.number),linked=[...new Set(card.uses.map(x=>x.retailer))];
  const availableRetailers=hard?RETAILERS.filter(x=>!linked.includes(x)):card.uses.length?[]:[...RETAILERS];
  return {ref:card.ref,last4:card.number.slice(-4),...(showFullNumbers?{fullNumber:card.number}:{}),linkedAccounts:card.uses.map(u=>({retailer:u.retailer,email:u.email})),label:card.label||"Imported profile card",expiry:card.expiry,
   hardCard:hard,fromSavedBank:card.fromSavedBank,linked,linkedCount:card.uses.length,availableRetailers,
   conflict:hard?linked.some(r=>card.uses.filter(x=>x.retailer===r).length>1):card.uses.length>1,
   status:card.uses.length?"Linked "+linked.join(", "):"Unused"};
 }).sort((a,b)=>a.last4.localeCompare(b.last4));
}
function toggleBulk(v,cardRefs,hard){
 if(typeof hard!=="boolean"||!Array.isArray(cardRefs)||cardRefs.length<1||cardRefs.length>200||new Set(cardRefs).size!==cardRefs.length)
  throw Error("Confirm 1-200 unique selected card entries.");
 const numbers=cardRefs.map(ref=>cardFromRef(v,ref));
 if(new Set(numbers).size!==numbers.length)throw Error("Choose each physical card only once.");
 // Ensure no partial updates if one card fails. The caller persists the local
 // vault only after this entire function returns successfully.
 if(!hard){
  const linked=sourceEntries(v);
  for(const number of numbers)if(linked.filter(x=>x.number===number).length>1)
   throw Error("A selected card is linked more than once. Resolve extra assignments before removing Hard Card; no changes were saved.");
 }
 const settings=ensureSettings(v),tokens=numbers.map(number=>fingerprint(v,number)),set=new Set(settings.hard);
 for(const token of tokens)if(hard)set.add(token);else set.delete(token);
 settings.hard=[...set].slice(0,15000);
 const scans=numbers.map(number=>scanVault(v,number));
 return {saved:true,updated:numbers.length,hardCard:hard,matchedProfiles:scans.reduce((count,scan)=>count+scan.matchedProfiles,0),savedCardCopies:scans.reduce((count,scan)=>count+scan.savedCardCopies,0)};
}
function promote(v,ref){
 const n=cardFromRef(v,ref);
 if((v.cards||[]).some(card=>digits(card.number)===n))return {saved:false,alreadyExists:true};
 const src=sourceEntries(v).find(x=>x.number===n);
 if(!src||!src.expiry)throw Error("Imported card needs an expiration before it can be added to the saved bank.");
 const row=v.sources.find(x=>x.id===src.sourceId)?.file?.rows?.[src.index]||{};
 const holder=String(row[Formats.findField(row,Formats.aliases.cardholder)]||"").slice(0,120);
 v.cards.push({id:crypto.randomUUID(),label:"Imported profile card",number:n,holder,expiry:src.expiry,createdAt:new Date().toISOString()});
 return {saved:true,last4:n.slice(-4)};
}
function allocate(v,source,indices){
 if(!source||!RETAILERS.includes(source.retailer))throw Error("Choose a retailer.");
 const selected=new Set(indices.map(index=>source.id+":"+index));
 const uses=sourceEntries(v).filter(row=>!selected.has(row.sourceId+":"+row.index));
 const allocations=[];
 for(let i=0;i<indices.length;i++){
  const index=indices[i],target=source.file?.rows?.[index];
  if(!target||!Formats.findField(target,Formats.aliases.cardNumber))throw Error("Selected profile cannot receive a card in this import format.");
  const card=(v.cards||[]).find(c=>{
   const n=digits(c.number);if(!validNumber(n))return false;
   const linked=uses.filter(row=>row.number===n);
   return isHard(v,n)?!linked.some(row=>row.retailer===source.retailer):!linked.length;
  });
  if(!card)throw Error("Not enough eligible cards in this private vault for "+source.retailer+". A Hard Card may be used only once per retailer.");
  allocations.push({index,card});
  uses.push({number:digits(card.number),retailer:source.retailer,sourceId:source.id,index});
 }
 return allocations;
}
module.exports={RETAILERS,numberOf,sourceEntries,fingerprint,isHard,cardFromRef,scanVault,toggle,toggleBulk,inventory,promote,allocate};
