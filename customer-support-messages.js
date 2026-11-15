import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SNOWFLAKE=/^\d{17,22}$/;
const snow=value=>SNOWFLAKE.test(String(value||""));
const arr=value=>Array.isArray(value)?value:[];
const empty=()=>({version:1,accounts:{},processedDiscordIds:{}});
const box=(data,id)=>data.accounts[String(id)] ||= {messages:[],readAt:null};
export function normalizeSupportText(value){
 if(typeof value!=="string")throw Error("Enter a message.");
 const text=value.trim().replace(/\r\n?/g,"\n");
 if(!text||text.length>1500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
  throw Error("Messages must contain 1 to 1,500 characters.");
 return text;
}
export function resolveSupportRecipient(packet,data,accounts,ownerId,channelId){
 if(!snow(packet?.id)||!snow(packet?.guild_id)||String(packet.channel_id)!==String(channelId)||
  String(packet.author?.id)!==String(ownerId)||packet.author?.bot||packet.webhook_id)return null;
 const linked=new Map(),refs=new Set(),mentions=new Set();
 for(const account of arr(accounts)){
  if(account?.disabled||!snow(account?.discordUserId))continue;
  const discord=String(account.discordUserId);
  if(!linked.has(discord))linked.set(discord,[]);
  linked.get(discord).push(String(account.id));
 }
 const reference=String(packet.message_reference?.message_id||"");
 if(snow(reference))for(const [id,entry] of Object.entries(data.accounts||{}))
  if(arr(entry.messages).some(m=>String(m.discordMessageId||"")===reference))refs.add(id);
 for(const member of arr(packet.mentions))
  for(const id of linked.get(String(member.id||""))||[])mentions.add(id);
 for(const match of String(packet.content||"").matchAll(/<@!?(\d{17,22})>/g))
  for(const id of linked.get(match[1])||[])mentions.add(id);
 if(refs.size>1||mentions.size>1)return null;
 const ref=[...refs][0],mention=[...mentions][0];
 return ref&&mention&&ref!==mention?null:ref||mention||null;
}
export function normalizeSupportReply(packet,discordId){
 let text=String(packet?.content||"").trim();
 if(snow(discordId))text=text.replace(new RegExp("<@!?"+discordId+">","g"),"").trim();
 if(/<@!?\d{17,22}>/.test(text))throw Error("Ambiguous Discord mentions.");
 return normalizeSupportText(text);
}
export function createCustomerSupportMessages({dataDir,getAccounts,onReply=async()=>{},onChange=()=>{},
 now=()=>Date.now(),uid=()=>crypto.randomUUID()}={}){
 const file=path.join(dataDir,"customer-support-messages.json");
 let queue=Promise.resolve(),bridge=null;
 function locked(fn){const work=queue.then(fn);queue=work.catch(()=>{});return work;}
 async function load(){
  try{
   const data=JSON.parse(await fs.readFile(file,"utf8"));
   if(data?.version!==1||!data.accounts||!data.processedDiscordIds)throw Error("Invalid support ledger.");
   return data;
  }catch(error){if(error?.code==="ENOENT")return empty();throw error;}
 }
 async function save(data){
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const tmp=file+"."+uid()+".tmp";
  try{await fs.writeFile(tmp,JSON.stringify(data),{mode:0o600,flag:"wx"});await fs.rename(tmp,file);}
  finally{await fs.unlink(tmp).catch(()=>{});}
 }
 const visible=m=>({id:m.id,direction:m.direction,text:m.text,createdAt:m.createdAt,
  delivery:m.direction==="admin"||m.discordMessageId?"delivered":"queued"});
 async function list(accountId){
  return locked(async()=>{
   const data=await load(),b=data.accounts[String(accountId)]||{messages:[],readAt:null};
   return {messages:arr(b.messages).slice(-300).map(visible),unread:arr(b.messages).filter(m=>
    m.direction==="admin"&&(!b.readAt||Date.parse(m.createdAt)>Date.parse(b.readAt))).length};
  });
 }
 async function markRead(accountId){
  return locked(async()=>{const data=await load();box(data,accountId).readAt=new Date(now()).toISOString();
   await save(data);return {ok:true};});
 }
 async function send(account,body){
  if(!account?.id||account.disabled||account.demo)throw Error("Sign in to send a message.");
  const text=normalizeSupportText(body),createdAt=new Date(now()).toISOString();
  const message=await locked(async()=>{
   const data=await load(),b=box(data,account.id);
   if(b.messages.filter(m=>m.direction==="customer"&&Date.parse(m.createdAt)>now()-3600000).length>=12)
    throw Error("Message limit reached. Please try again later.");
   const item={id:uid(),direction:"customer",text,createdAt};
   b.messages.push(item);b.messages=b.messages.slice(-300);await save(data);return item;
  });
  onChange("support-message");
  void flush().catch(e=>console.error("Customer support Discord relay:",e.message));
  return {ok:true,message:visible(message)};
 }
 async function flush(){
  if(!bridge)return {ready:false};
  return locked(async()=>{
   const data=await load(),accounts=arr(await getAccounts());
   const byId=new Map(accounts.map(a=>[String(a.id),a]));let count=0;
   for(const [accountId,b] of Object.entries(data.accounts))for(const item of arr(b.messages)){
    if(item.direction!=="customer"||item.discordMessageId)continue;
    const account=byId.get(accountId);if(!account)continue;
    const label=String(account.discordUsername||account.name||account.email||"Member").replace(/[\r\n@<>]/g," ").slice(0,90);
    const mention=snow(account.discordUserId)&&account.discordLinkedAt?"<@"+account.discordUserId+">":"";
    const clean=value=>String(value).replace(/@/g,"@\u200b").split(String.fromCharCode(96)).join("'");
    const content=[
     "**APP MESSAGE - "+label+"** "+mention,
     "Account ID: "+clean(accountId),
     "Message ID: "+item.id,
     clean(item.text),
     "Reply to this message or @mention the linked member to answer in their app."
    ].join("\n").slice(0,1950);
    const posted=await bridge.send({content,allowed_mentions:{parse:[]},
     nonce:item.id.replace(/-/g,"").slice(0,24),enforce_nonce:true});
    if(!snow(posted?.id))throw Error("Discord did not acknowledge this support message.");
    item.discordMessageId=String(posted.id);count++;await save(data);
   }
   return {ready:true,delivered:count};
  });
 }
 function setBridge({send:relay,channelId,guildId,ownerId}={}){
  if(typeof relay!=="function"||![channelId,guildId,ownerId].every(snow))
   throw Error("Discord owner support channel is not verified.");
  bridge={send:relay,channelId:String(channelId),guildId:String(guildId),ownerId:String(ownerId)};
  void flush().catch(e=>console.error("Customer support relay:",e.message));
 }
 async function handleDiscordReply(packet){
  if(!bridge||String(packet?.channel_id||"")!==bridge.channelId||
   String(packet?.guild_id||"")!==bridge.guildId||
   String(packet?.author?.id||"")!==bridge.ownerId||packet?.author?.bot||packet?.webhook_id)return {ignored:true};
  const result=await locked(async()=>{
   const data=await load();
   if(data.processedDiscordIds[String(packet.id||"")])return {duplicate:true};
   const accounts=arr(await getAccounts());
   const accountId=resolveSupportRecipient(packet,data,accounts,bridge.ownerId,bridge.channelId);
   const account=accounts.find(a=>String(a.id)===accountId);
   if(!account||account.disabled)return {unmatched:true};
   let text;try{text=normalizeSupportReply(packet,account.discordUserId);}
   catch{return {unmatched:true};}
   const item={id:uid(),direction:"admin",text,createdAt:new Date(now()).toISOString(),
    discordMessageId:String(packet.id)};
   const b=box(data,accountId);b.messages.push(item);b.messages=b.messages.slice(-300);
   data.processedDiscordIds[String(packet.id)]=item.id;
   if(Object.keys(data.processedDiscordIds).length>3000)
    for(const key of Object.keys(data.processedDiscordIds).slice(0,1000))delete data.processedDiscordIds[key];
   await save(data);return {recorded:true,accountId,item};
  });
  if(result.recorded){
   onChange("support-message");
   try{await onReply(result.accountId,result.item);}
   catch(e){console.error("Support reply push:",e.message);}
  }
  return result;
 }
 return {list,markRead,send,flush,setBridge,handleDiscordReply,storePath:file};
}