// Authorized, owner-controlled SLABSNGRABSACO retailer information publisher.
// This module NEVER connects to a third-party Discord server or user account.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const INTEL_RETENTION_MS = 14 * 86400000;
export const INTEL_RETAILERS = Object.freeze(["target", "walmart", "pokemoncenter", "costco", "sams"]);
const LABELS = { target: "Target", walmart: "Walmart", pokemoncenter: "Pokémon Center", costco: "Costco", sams: "Sam's Club" };
const COLORS = { target: 0x1693d4, walmart: 0x1693d4, pokemoncenter: 0x1693d4, costco: 0x1693d4, sams: 0x1693d4 };
const safe = (value, max=250) => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/<[@#&!][^>]*>/g, "").replace(/@everyone|@here/gi, "").replace(/\s+/g, " ").trim().slice(0, max);
const isoDay = value => /^20\d\d-\d\d-\d\d$/.test(String(value||"")) && !Number.isNaN(Date.parse(value+"T00:00:00Z")) ? String(value) : "";
const field = (name,value) => ({name, value: String(value || "Not reported").slice(0,1024), inline: true});
function retailerId(value) {
 const id=String(value||"").toLowerCase().replace(/[^a-z0-9]/g,"");
 return ({pkc:"pokemoncenter",pokemon:"pokemoncenter",pokemoncenter:"pokemoncenter",samsclub:"sams",sam:"sams",sams:"sams",costco:"costco",target:"target",walmart:"walmart"})[id] || null;
}
function officialRetailerUrl(value,retailer){
 if(!value)return "";
 try{
  const url=new URL(String(value));
  const domains={target:["target.com"],walmart:["walmart.com"],pokemoncenter:["pokemoncenter.com"],
   costco:["costco.com"],sams:["samsclub.com"]}[retailer];
  if(url.protocol!=="https:"||url.username||url.password||!domains.some(domain=>url.hostname===domain||url.hostname.endsWith("."+domain)))return "";
  return url.href.slice(0,700);
 }catch{return "";}
}
function productId(input) {
 for(const [name,label] of [["sku","SKU"],["tcin","TCIN"],["pid","PID"],["itemNumber","Item"]]) {
  const value=safe(input[name],75).toUpperCase();
  if(value && /^[A-Z0-9._-]{2,75}$/.test(value))return {name:label,value};
 }
 return null;
}
export function normalizeRetailerIntel(input, today=new Date().toISOString().slice(0,10)) {
 if(!input || typeof input!=="object" || Array.isArray(input))throw Error("Provide a structured retailer update.");
 const type=safe(input.type,32).toLowerCase();
 const retailer=retailerId(input.retailer);
 if(!retailer)throw Error("Choose Target, Walmart, Pokémon Center, Costco, or Sam's Club.");
 if(!["product","drop","in_store","queue"].includes(type))throw Error("Unknown retailer update type.");
 if(safe(input.source,40).toLowerCase()==="pokemon-center" && type!=="queue")throw Error("Pokémon Center monitoring-channel information is used for queue state only.");
 const date=isoDay(input.date || today);
 if(!date)throw Error("Use a real YYYY-MM-DD date.");
 if(type==="queue" && retailer!=="pokemoncenter")throw Error("Queue notifications apply only to Pokémon Center.");
 const event={type,retailer,date};
 if(type==="product"){
  const id=productId(input),name=safe(input.name,200);
  if(!name)throw Error("A product name is required.");
  event.name=name;event.identifier=id;event.url=officialRetailerUrl(input.url||input.productUrl,retailer);
  event.identifiers=[["sku","SKU"],["tcin","TCIN"],["pid","PID"],["itemNumber","Item"]]
   .map(([prop,label])=>({name:label,value:safe(input[prop],75).toUpperCase()}))
   .filter(item=>/^[A-Z0-9._-]{2,75}$/.test(item.value));
  for(const [dst,source] of [["price","price"],["stock","stock"],["cartLimit","cartLimit"]]){
   if(input[source]!==undefined && input[source]!==null && String(input[source]).trim())event[dst]=safe(input[source],75);
  }
  event.key="product:"+retailer+":"+(id?id.name+":"+id.value:"name:"+name.toLowerCase().replace(/[^a-z0-9]+/g,"-"));
  // No unverified price inference and no copied source post.
 }else if(type==="drop"){
  event.dropTime=safe(input.dropTime,120);
  event.confidence=input.confirmed===true?"confirmed":"potential";
  event.key="drop:"+retailer+":"+date;
 }else if(type==="in_store"){
  event.key="instore:"+retailer+":"+date;
 }else{
  const stage=safe(input.stage,30).toLowerCase().replace(/[^a-z]/g,"");
  if(!["upcoming","up","down"].includes(stage))throw Error("Queue stage must be upcoming, up, or down.");
  const source=safe(input.source,40).toLowerCase();
  event.stage=stage;
  event.source=source==="important-restocks"?"important-restocks":"pokemon-center";
  event.key="queue:"+date+":"+stage;
 }
 return event;
}
export function retailerIntelPayload(event) {
 const retailer=LABELS[event.retailer];
 const base={allowed_mentions:{parse:[]}};
 if(event.type==="product"){
  return {...base, embeds:[{title:event.name, ...(event.url?{url:event.url}:{}), color:COLORS[event.retailer],
   fields:[...(event.identifier?[field(event.identifier.name,event.identifier.value)]:[]),field("Price",event.price),field("Reported stock",event.stock),field("Cart limit",event.cartLimit)],
   footer:{text:"SLABSNGRABSACO • Retailer availability can change"}
  }]};
 }
 if(event.type==="drop"){
  const label=event.confidence==="confirmed"?"Scheduled drop":"Possible drop";
  return {...base, content:"**"+retailer+" • "+label+" • "+event.date+"**\n"+
   (event.dropTime?"Reported start: **"+event.dropTime+"**. ":"")+
   "Details below are subject to retailer changes. Stock figures are estimates unless confirmed directly."};
 }
 if(event.type==="in_store")return {...base,content:"**"+retailer+" store watch • "+event.date+"**\nPossible in-store stock now or coming soon. Check individual stores for current availability; this is not a confirmed store-level inventory count."};
 return {...base, content: event.stage==="upcoming"
  ?"**QUEUE DETECTED / UPCOMING** • Pokémon Center • "+event.date+"\nA potential queue has been reported. Timing is not guaranteed."
  : event.stage==="up"
  ?"**POKÉMON CENTER QUEUE UP** • "+event.date+"\nThe queue has been reported active."
  :"**POKÉMON CENTER QUEUE DOWN** • "+event.date+"\nThe queue has been reported closed."};
}
function sameRelevant(oldEvent,next) {
 if(next.type==="product")return ["price","stock","cartLimit"].every(k=>(oldEvent?.[k]||"")===(next?.[k]||""));
 if(next.type==="drop")return oldEvent?.dropTime===next.dropTime && oldEvent?.confidence===next.confidence;
 return true;
}
const mergeEvent=(oldEvent,event) => {
 if(event.type!=="product")return event;
 const previous=oldEvent?.identifiers||[oldEvent?.identifier].filter(Boolean);
 const next=event.identifiers||[event.identifier].filter(Boolean);
 const ids=new Map([...previous,...next].filter(Boolean).map(item=>[item.name+":"+item.value,item]));
 return {...oldEvent,...event,name:oldEvent?.name||event.name,identifier:oldEvent?.identifier||event.identifier,
  identifiers:[...ids.values()],url:event.url||oldEvent?.url||"",price:event.price??oldEvent?.price,stock:event.stock??oldEvent?.stock,
  cartLimit:event.cartLimit??oldEvent?.cartLimit};
};
export function createRetailerIntelPublisher({dataDir,channels,send,edit,remove,clock=()=>Date.now()}) {
 if(!dataDir || typeof send!=="function" || typeof edit!=="function" || typeof remove!=="function")throw Error("Authorized Discord publisher requires storage and bot methods.");
 const file=path.join(dataDir,"discord-retailer-intel-v1.json");
 let queue=Promise.resolve();
 const serialized=work=>{const result=queue.then(work);queue=result.catch(()=>{});return result;};
 async function read(){
  try{const state=JSON.parse(await fs.readFile(file,"utf8"));return state?.version===1 && state.messages && typeof state.messages==="object"?state:{version:1,messages:{}};}
  catch(e){if(e.code==="ENOENT")return {version:1,messages:{}};throw e;}
 }
 async function save(state){
  await fs.mkdir(dataDir,{recursive:true});
  const temp=file+"."+crypto.randomUUID()+".tmp";
  await fs.writeFile(temp,JSON.stringify(state),{mode:0o600});
  await fs.rename(temp,file);
 }
 const channelFor=retailer=>String(channels()?.[retailer]||"");
 function destinationEntries(event){
  const main=channelFor(event.retailer);
  if(!main)return [];
  if(event.type==="queue" && event.stage==="upcoming" && event.source==="important-restocks"){
   const announcements=channelFor("announcements");
   if(!announcements)throw Error("Announcements is unavailable; queue notice was not published anywhere.");
   return [...new Set([announcements,main])];
  }
  return [main];
 }
 async function ingest(input){
  return serialized(async()=>{
   const event=normalizeRetailerIntel(input,new Date(clock()).toISOString().slice(0,10));
   const state=await read(),destinations=destinationEntries(event);
   if(!destinations.length)throw Error("Retailer channel is not ready. No message posted.");
   const outcome=[];
   for(const channelId of destinations){
    let recordKey=channelId+":"+event.key;
    if(event.type==="product" && !state.messages[recordKey]){
      const incomingIds=new Set((event.identifiers||[event.identifier].filter(Boolean)).map(item=>item.name+":"+item.value));
      const sameName=(value)=>String(value||"").toLowerCase().replace(/[^a-z0-9]/g,"");
      for(const [candidateKey,record] of Object.entries(state.messages)){
        const priorEvent=record.event;
        if(record.channelId!==channelId || priorEvent?.type!=="product" || priorEvent.retailer!==event.retailer)continue;
        const priorIds=priorEvent.identifiers||[priorEvent.identifier].filter(Boolean);
        const shared=priorIds.some(item=>incomingIds.has(item.name+":"+item.value));
        const conflict=priorIds.some(a=>(event.identifiers||[event.identifier].filter(Boolean)).some(b=>a.name===b.name && a.value!==b.value));
        if(shared || (!conflict && sameName(priorEvent.name)===sameName(event.name))){recordKey=candidateKey;break;}
      }
    }
    const prior=state.messages[recordKey];
    const next=mergeEvent(prior?.event,event);
    if(prior && sameRelevant(prior.event,next)){
      // Record new identifier aliases without sending a duplicate Discord post.
      state.messages[recordKey].event=next;await save(state);
      outcome.push({status:"unchanged",channelId});continue;
    }
    const payload=retailerIntelPayload(next);
    let posted=null,status="created";
    if(prior?.messageId){
     try{posted=await edit(channelId,prior.messageId,payload);status="edited";}
     catch(e){if(!/HTTP 404/.test(String(e.message||e)))throw e;}
    }
    if(!posted){posted=await send(channelId,payload);status="created";}
    if(!posted?.id)throw Error("Discord did not return a message ID; update was not recorded.");
    state.messages[recordKey]={channelId,messageId:String(posted.id),event:next,createdAt:status==="edited"?prior.createdAt:clock(),updatedAt:clock()};
    await save(state);
    outcome.push({status,channelId});
   }
   return {eventKey:event.key,outcome};
  });
 }
 async function expire(){
  return serialized(async()=>{
   const state=await read(),now=clock(),deleted=[];
   for(const [key,record] of Object.entries(state.messages)){
    if(!Number.isFinite(Number(record.createdAt)) || now-Number(record.createdAt)<INTEL_RETENTION_MS)continue;
    try{await remove(record.channelId,record.messageId);}
    catch(e){if(!/HTTP 404/.test(String(e.message||e)))continue;}
    deleted.push(key);delete state.messages[key];
   }
   if(deleted.length)await save(state);
   return {deleted:deleted.length};
  });
 }
 return Object.freeze({ingest,expire});
}
