import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sendBackgroundAdminPush } from "./admin-push.js";
import { createNotificationDeliveryGuard } from "./notification-delivery-guard.js";

const clean=value=>String(value??"").replace(/[@<>\r\n]/g," ").trim();
const normalized=value=>String(value??"").toLowerCase().replace(/[^a-z0-9]/g,"");

/** Private, persisted Target Raffle Club owner alerts with independent push and Discord delivery. */
export function createRaffleOwnerNotifier({dataDir,getDiscord}){
  const file=path.join(dataDir,"target-raffle-owner-alerts.json");
  const guard=createNotificationDeliveryGuard({dataDir});
  let updates=Promise.resolve(),deliveries=Promise.resolve();
  function exclusive(fn){
    const result=updates.then(fn,fn);
    updates=result.catch(()=>{});
    return result;
  }
  async function load(){
    try{
      const rows=JSON.parse(await fs.readFile(file,"utf8"));
      if(!Array.isArray(rows))throw Error("Invalid raffle owner alert history.");
      return rows;
    }catch(error){if(error.code==="ENOENT")return [];throw error;}
  }
  async function save(rows){
    await fs.mkdir(dataDir,{recursive:true,mode:0o700});
    const tmp=file+"."+crypto.randomUUID()+".tmp";
    await fs.writeFile(tmp,JSON.stringify(rows,null,2),{flag:"wx",mode:0o600});
    await fs.rename(tmp,file);
  }
  const history=async()=>(await load()).slice(-80).reverse().map(row=>({
    id:row.id,kind:row.kind,title:row.title,body:row.body,
    createdAt:row.createdAt,pushSent:row.pushSent,discordSent:row.discordSent
  }));
  async function mark(id,key){
    return exclusive(async()=>{
      const rows=await load(),entry=rows.find(row=>row.id===id);
      if(entry&&!entry[key]){entry[key]=true;await save(rows);}
    });
  }
  async function adminChannel(discord){
    const channels=await discord.api("/guilds/"+discord.guildId+"/channels");
    const category=channels.find(x=>x.type===4&&normalized(x.name)==="adminonly");
    if(!category)return null;
    return channels.find(x=>x.type===0&&String(x.parent_id)===String(category.id)&&
      normalized(x.name)==="actionneeded") ||
      channels.find(x=>x.type===0&&String(x.parent_id)===String(category.id)&&
      normalized(x.name)==="admin") || null;
  }
  function flush(){
    const job=deliveries.then(async()=>{
      const pending=(await load()).filter(row=>
        (!row.pushSent||!row.discordSent)&&Date.now()-Date.parse(row.createdAt)<30*86400000);
      if(!pending.length)return;
      const discord=typeof getDiscord==="function"?getDiscord():null;
      let channel=null;
      if(discord){
        try{channel=await adminChannel(discord);}
        catch(error){console.error("Raffle owner Discord channel:",error.message);}
      }
      for(const row of pending){
        if(!row.pushSent){
          try{
            const sent=await sendBackgroundAdminPush(dataDir,
              row.kind==="membership"?"newOrders":"checkouts",
              row.title,row.body,"/target-raffle-admin.html",row.id);
            if(sent)await mark(row.id,"pushSent");
          }catch(error){console.error("Raffle owner push:",error.message);}
        }
        if(!row.discordSent&&discord&&channel){
          try{
            const claim=await guard.claim({
              channel:"discord:admin:raffle",recipient:String(channel.id),eventKey:row.id
            });
            if(claim.send){
              await discord.api("/channels/"+channel.id+"/messages","POST",{
                content:"<@"+discord.ownerId+"> **"+clean(row.title)+"**\n"+clean(row.body),
                allowed_mentions:{parse:[],users:[String(discord.ownerId)]},
                embeds:[{title:"Target Raffle Club | Owner alert",description:clean(row.body),
                  color:0x39cbd6,timestamp:row.createdAt}]
              });
            }
            if(claim.send||claim.reason==="already_notified")await mark(row.id,"discordSent");
          }catch(error){console.error("Raffle owner Discord alert:",error.message);}
        }
      }
    });
    deliveries=job.catch(()=>{});
    return job;
  }
  async function announce({kind,eventId,title,body}){
    if(!["membership","paid-item"].includes(kind)||!eventId)
      throw Error("Invalid raffle owner alert.");
    const id="raffle:"+kind+":"+String(eventId);
    await exclusive(async()=>{
      const rows=await load();
      if(rows.some(row=>row.id===id))return;
      rows.push({id,kind,title:clean(title).slice(0,120),body:clean(body).slice(0,500),
        createdAt:new Date().toISOString(),pushSent:false,discordSent:false});
      await save(rows.slice(-500));
    });
    void flush().catch(error=>console.error("Raffle owner notification:",error.message));
  }
  const timer=setInterval(()=>void flush().catch(error=>
    console.error("Raffle owner alert retry:",error.message)),60000);
  timer.unref?.();
  return {announce,flush,history};
}
