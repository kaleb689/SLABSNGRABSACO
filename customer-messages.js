// Private support messages. Customer account identity comes only from the signed-in session.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SNOWFLAKE=/^\d{17,22}$/;
const REQUEST=/^[a-f0-9-]{20,64}$/i;
const MAX_TEXT=1400;

export function cleanSupportText(value) {
  if(typeof value!=="string")throw Object.assign(Error("Enter a message."),{status:400});
  const text=value.replace(/\r\n?/g,"\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,"").trim();
  if(!text||text.length>MAX_TEXT)throw Object.assign(
    Error("Use 1 to "+MAX_TEXT+" characters."),{status:400});
  return text;
}
export function resolveOwnerSupportReply(message,threads,accounts) {
  const content=String(message?.content||"");
  const inText=[...content.matchAll(/<@!?(\d{17,22})>/g)].map(row=>row[1]);
  const inMentions=(message?.mentions||[]).map(row=>String(row.id||""))
    .filter(id=>SNOWFLAKE.test(id));
  const ids=[...new Set([...inText,...inMentions])];
  if(ids.length>1)return null;
  const reference=String(message?.message_reference?.message_id||"");
  const fromReference=reference?Object.entries(threads||{}).find(([,thread])=>
    (thread.messages||[]).some(row=>row.discordMessageId===reference))?.[0]:null;
  const linked=ids.length?(accounts||[]).filter(a=>a.disabled!==true&&a.discordLinkedAt&&
    String(a.discordUserId||"")===ids[0]):[];
  if(ids.length&&linked.length!==1)return null;
  const fromMention=linked.length?String(linked[0].id):null;
  if(fromReference&&fromMention&&fromReference!==fromMention)return null;
  const accountId=fromMention||fromReference;
  if(!accountId||!(accounts||[]).some(a=>String(a.id)===accountId&&a.disabled!==true))return null;
  const text=content.replace(/<@!?\d{17,22}>/g,"").trim();
  return text&&text.length<=MAX_TEXT?{accountId,text}:null;
}

export function createCustomerMessageBridge({dataDir,getAccounts,notifyReply,postDiscordMessage,
  now=()=>Date.now()}={}) {
  if(!dataDir||typeof getAccounts!=="function"||typeof postDiscordMessage!=="function")
    throw Error("Support bridge requires a persistent store, accounts and a Discord sender.");
  const file=path.join(dataDir,"customer-app-messages.json");
  let store=null,config=null,queue=Promise.resolve();
  const serial=action=>{const result=queue.then(action);queue=result.catch(()=>{});return result;};
  async function load(){
    if(store)return store;
    try{
      const candidate=JSON.parse(await fs.readFile(file,"utf8"));
      if(candidate?.version!==1||!candidate.threads||typeof candidate.threads!=="object"||
        !candidate.seen||typeof candidate.seen!=="object")
        throw Error("Unsupported support message store; original was preserved.");
      store=candidate;
    }catch(error){
      if(error.code!=="ENOENT")throw error;
      store={version:1,threads:{},seen:{}};
    }
    return store;
  }
  async function save(){
    await fs.mkdir(dataDir,{recursive:true,mode:0o700});
    const temp=file+"."+crypto.randomBytes(8).toString("hex")+".tmp";
    try{
      await fs.writeFile(temp,JSON.stringify(store),{mode:0o600,flag:"wx"});
      await fs.rename(temp,file);
      await fs.chmod(file,0o600).catch(()=>{});
    }finally{await fs.unlink(temp).catch(error=>{if(error.code!=="ENOENT")throw error;});}
  }
  function thread(accountId) {
    const id=String(accountId);
    store.threads[id] ||= {ticket:crypto.randomBytes(5).toString("hex").toUpperCase(),
      unread:0,messages:[]};
    return store.threads[id];
  }
  const exposed=row=>({id:row.id,role:row.role,text:row.text,createdAt:row.createdAt});
  const snapshot=row=>({ok:true,ready:Boolean(config),unread:row?.unread||0,
    messages:(row?.messages||[]).map(exposed)});
  function configure({channelId,guildId,ownerId,botId}={}) {
    if(![channelId,guildId,ownerId,botId].every(v=>SNOWFLAKE.test(String(v||""))))
      throw Error("Private Discord message channel is not verified.");
    config={channelId:String(channelId),guildId:String(guildId),ownerId:String(ownerId),
      botId:String(botId)};
    return {ready:true};
  }
  async function list(accountId) {
    return serial(async()=>{await load();return snapshot(store.threads[String(accountId)]);});
  }
  async function markRead(accountId){
    return serial(async()=>{
      await load();const row=store.threads[String(accountId)];
      if(row?.unread){row.unread=0;await save();}
      return {ok:true,unread:0};
    });
  }
  async function send(account,input={}) {
    const id=String(account?.id||""),text=cleanSupportText(input?.text);
    const requestId=String(input?.requestId||"");
    if(!id||account?.disabled===true)throw Object.assign(Error("Sign in first."),{status:401});
    if(!REQUEST.test(requestId))throw Object.assign(Error("Invalid message request."),{status:400});
    return serial(async()=>{
      await load();
      if(!config)throw Object.assign(
        Error("Private Admin messages are not connected. Try again later."),{status:503});
      const conversation=thread(id);
      const existing=conversation.messages.find(m=>m.requestId===requestId);
      if(existing)return {ok:true,duplicate:true,message:exposed(existing)};
      const recent=conversation.messages.filter(m=>m.role==="customer"&&
        now()-Date.parse(m.createdAt)>=0&&now()-Date.parse(m.createdAt)<3600000);
      if(recent.length>=20)throw Object.assign(
        Error("You reached the hourly support message limit."),{status:429});
      if(recent.length&&now()-Date.parse(recent[recent.length-1].createdAt)<3000)
        throw Object.assign(Error("Wait a few seconds before another message."),{status:429});
      const discordId=account.discordLinkedAt&&SNOWFLAKE.test(String(account.discordUserId||""))
        ?String(account.discordUserId):null;
      const name=String(account.name||account.displayName||account.firstName||"Member")
        .replace(/[\r\n\x60*_<>@\\]/g,"").slice(0,65);
      const who=discordId?"<@"+discordId+">":"No linked Discord (reply to the bot post)";
      const header="**APP MESSAGE** · Ticket "+conversation.ticket+
        "\n**Customer:** "+(name||"Member")+" · "+who+
        "\n**Reply:** @mention the customer or reply to this bot post.\n";
      const content=header+"\n"+text.split("\n").map(line=>"> "+line).join("\n");
      if(content.length>1900)throw Object.assign(Error("Message is too long for Discord."),{status:400});
      const posted=await postDiscordMessage(config.channelId,{content,
        allowed_mentions:{parse:[]},flags:4});
      if(!SNOWFLAKE.test(String(posted?.id||"")))throw Error("Discord did not confirm the send.");
      const row={id:crypto.randomUUID(),role:"customer",text,
        requestId,discordMessageId:String(posted.id),createdAt:new Date(now()).toISOString()};
      conversation.messages.push(row);
      if(conversation.messages.length>200)conversation.messages.splice(0,conversation.messages.length-200);
      await save();
      return {ok:true,message:exposed(row)};
    });
  }
  async function onDiscordMessage(message) {
    if(!config||String(message?.channel_id||"")!==config.channelId||
      String(message?.guild_id||"")!==config.guildId)return false;
    if(message.author?.bot||String(message.author?.id||"")!==config.ownerId)return true;
    const id=String(message.id||"");
    if(!SNOWFLAKE.test(id))return true;
    try{
      const saved=await serial(async()=>{
        await load();
        if(store.seen[id])return store.seen[id];
        const accounts=await getAccounts();
        const target=resolveOwnerSupportReply(message,store.threads,accounts);
        if(!target)return null;
        const conversation=thread(target.accountId);
        const row={id:crypto.randomUUID(),role:"owner",text:target.text,
          discordMessageId:id,createdAt:new Date(now()).toISOString()};
        conversation.messages.push(row);
        if(conversation.messages.length>200)conversation.messages.splice(0,conversation.messages.length-200);
        conversation.unread=Math.min(9999,(Number(conversation.unread)||0)+1);
        store.seen[id]={accountId:target.accountId,text:row.text};
        const keys=Object.keys(store.seen);
        if(keys.length>15000)for(const old of keys.slice(0,keys.length-12000))delete store.seen[old];
        await save();
        return store.seen[id];
      });
      if(saved&&typeof notifyReply==="function")await notifyReply({
        accountId:saved.accountId,text:saved.text,discordMessageId:id});
    }catch(error){console.error("Customer support reply persistence:",error.code||error.message);}
    return true;
  }
  return {configure,list,markRead,send,onDiscordMessage};
}

export function registerCustomerMessages(app,{dataDir,requireCustomer,getAccounts,notifyReply,
  discordToken,request=fetch}={}) {
  const postDiscordMessage=async(channelId,payload)=>{
    if(!discordToken)throw Error("Discord bot is not configured.");
    const url="https://discord.com/api/v10/channels/"+channelId+"/messages";
    for(let attempt=0;attempt<4;attempt++){
      const response=await request(url,{method:"POST",headers:{
        Authorization:"Bot "+discordToken,"Content-Type":"application/json"
      },body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
      if(response.status===429&&attempt<3){
        const detail=await response.json().catch(()=>({}));
        await new Promise(resolve=>setTimeout(resolve,
          Math.min(12000,Math.max(300,Number(detail.retry_after||1)*1000))));continue;
      }
      if(!response.ok)throw Error("Discord private inbox returned HTTP "+response.status);
      return response.json();
    }
    throw Error("Discord is rate limiting private messages.");
  };
  const bridge=createCustomerMessageBridge({dataDir,getAccounts,notifyReply,postDiscordMessage});
  app.get("/api/account/messages",requireCustomer,async(req,res)=>{
    try{res.set("Cache-Control","no-store");return res.json(await bridge.list(req.customerAccount.id));}
    catch{return res.status(500).json({error:"Unable to load messages."});}
  });
  app.post("/api/account/messages",requireCustomer,async(req,res)=>{
    try{return res.json(await bridge.send(req.customerAccount,req.body));}
    catch(error){return res.status(error.status||502).json({
      error:error.status?error.message:"Your message was not confirmed by Discord. Try again."});}
  });
  app.post("/api/account/messages/read",requireCustomer,async(req,res)=>{
    try{return res.json(await bridge.markRead(req.customerAccount.id));}
    catch{return res.status(500).json({error:"Unable to mark messages read."});}
  });
  return bridge;
}
