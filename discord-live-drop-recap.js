// Owner-only Discord drop announcements and source-verified 12-hour recaps.
// Never publish inferred totals, PII, order numbers or website/IMAP aggregates.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {fetchDirectSourceMessages} from "./server-discord-source-recap-review.js";
import {buildDiscordSourceRecap} from "./discord-source-recap-report.js";
import {checkoutIdentityFromDiscord,checkoutProductFromDiscord} from "./discord-checkout-identity.js";
import {discordVerifiedFullCharge} from "./discord-checkout-tax-inclusive-policy.js";
import {SLABSNGRABSTC_SUCCESS_CHANNEL_ID,sourcePriceIsLineTotal} from "./discord-source-price-field-policy.js";

export const DROP_RECAP_DELAY_MS=12*60*60*1000;
export const DROP_RECAP_RETAILERS=Object.freeze({
  target:{name:"Target",label:"Target",emoji:"🎯"},
  walmart:{name:"Walmart",label:"Walmart",emoji:"🛒"},
  pokemoncenter:{name:"Pokémon Center",label:"PKC",emoji:"⚡"},
  costco:{name:"Costco",label:"Costco",emoji:"📦"},
  sams:{name:"Sam's Club",label:"Sam's Club",emoji:"⭐"}
});
const currency=cents=>"$"+(cents/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const safeText=v=>String(v||"").replace(/@everyone|@here|<@!?[0-9]+>/g,"").slice(0,160);
const stamp=ms=>new Date(ms).toISOString();
const fieldLabel=v=>String(v||"").replace(/[*_\u200b]/g,"").replace(/:\s*$/,"").trim().toLowerCase();
function findField(embed,pattern){
  return (Array.isArray(embed?.fields)?embed.fields:[])
    .find(f=>pattern.test(fieldLabel(f.name)))?.value;
}
function amount(value) {
  const raw=String(value??"").replace(/[*|,]/g,"").trim();
  const match=raw.match(/^(?:USD\s*)?\$?\s*(\d{1,8}(?:\.\d{1,2})?)(?:\s*USD)?$/i);
  if(!match)return null;
  const cents=Math.round(Number(match[1])*100);
  return Number.isSafeInteger(cents)&&cents>0&&cents<100000000?cents:null;
}
function quantity(value) {
  const n=Number(String(value??"").replace(/[*\s]/g,""));
  return Number.isSafeInteger(n)&&n>0&&n<=999?n:null;
}
function originalImage(embed){
  // Only actual source images carried by the original Discord webhook.
  for(const value of [embed?.image?.url,embed?.thumbnail?.url]){
    try{
      const u=new URL(String(value||""));
      if(u.protocol==="https:"&&
        ["cdn.discordapp.com","media.discordapp.net","target.scene7.com"].includes(u.hostname.toLowerCase()))
        return u.toString();
    }catch{}
  }
  return null;
}
// Source-only parser for the recap. Multi-product webhooks are processed embed-by-embed.
// Missing quantities/prices stay unknown; never invent item details.
export function parseDiscordSuccessForRecap(message,channelId=SLABSNGRABSTC_SUCCESS_CHANNEL_ID){
  if(String(channelId)!==SLABSNGRABSTC_SUCCESS_CHANNEL_ID||!message?.webhook_id)return null;
  const identity=checkoutIdentityFromDiscord(message);
  const embeds=Array.isArray(message.embeds)?message.embeds:[];
  const items=[],retailers=new Set();
  let malformedProduct=false;
  for(const embed of embeds){
    const rawRetailer=findField(embed,/^(retailer|site|store)$/);
    if(rawRetailer)retailers.add(String(rawRetailer).replace(/[*|]/g,"").trim());
    const hasProductField=Boolean(findField(embed,/^(product|product name|item|item name)$/));
    const name=String(findField(embed,/^(product|product name|item|item name)$/)||
      checkoutProductFromDiscord({embeds:[embed]})||"").replace(/[*]/g,"").trim();
    const rawQuantity=findField(embed,/^(qty|quantity|items? qty)$/);
    if(!name) {
      if(hasProductField||rawQuantity!==undefined)malformedProduct=true;
      continue;
    }
    const qty=quantity(rawQuantity);
    if(!qty){malformedProduct=true;continue;}
    const unitField=findField(embed,/^(unit price|price per item|each)$/);
    const lineField=findField(embed,/^(price|line total|extended price)$/);
    let cents=amount(unitField??lineField);
    if(cents!==null && unitField===undefined &&
       sourcePriceIsLineTotal({channelId,fieldLabel:"Price",quantity:qty})){
      cents=cents%qty===0?cents/qty:null;
    }
    const sku=String(findField(embed,/^(sku|pid|tcin|item number)$/)||"")
      .replace(/[*|]/g,"").trim().slice(0,60);
    items.push({name,quantity:qty,price:cents===null?null:cents/100,
      ...(sku?{sku}:{}),imageUrl:originalImage(embed)});
  }
  const exact=discordVerifiedFullCharge(message);
  return {orderNumber:identity.orderNumber,
    retailer:retailers.size===1?[...retailers][0]:"",
    items:malformedProduct?[]:items,
    orderTotal:exact.paidCents===null?null:exact.paidCents/100,
    orderTotalBasis:exact.basis||"unknown"};
}
export function dropControlRows() {
  return [
    {type:1,components:[
      {type:2,style:3,label:"🎯 Target",custom_id:"sngdrop:start:target"},
      {type:2,style:3,label:"🛒 Walmart",custom_id:"sngdrop:start:walmart"},
      {type:2,style:3,label:"⚡ Pokémon Center",custom_id:"sngdrop:start:pokemoncenter"}
    ]},
    {type:1,components:[
      {type:2,style:3,label:"📦 Costco",custom_id:"sngdrop:start:costco"},
      {type:2,style:3,label:"⭐ Sam's Club",custom_id:"sngdrop:start:sams"},
      {type:2,style:2,label:"Pending / Posted",custom_id:"sngdrop:status"}
    ]}
  ];
}
export function buildDropAnnouncement(retailer,id,startMs){
  const spec=DROP_RECAP_RETAILERS[retailer];
  if(!spec)throw Error("Unknown retailer");
  const due=startMs+DROP_RECAP_DELAY_MS;
  return {content:"@everyone 🚨 **DROP IS LIVE — "+spec.name.toUpperCase()+"**",
    allowed_mentions:{parse:["everyone"]},
    embeds:[{title:spec.emoji+" DROP IS LIVE",color:0x23de90,
      description:"**"+spec.name+"** is live!\n\nA verified **DROP RECAP** is scheduled for <t:"+
        Math.floor(due/1000)+":F> (12 hours after this announcement).",
      footer:{text:"SNG-DROP-LIVE:"+id},timestamp:stamp(startMs)}]};
}
export function buildDropRecapPost(retailer,id,report){
  if(!report?.readyToPublish||!Number.isSafeInteger(report.totalSpentCents)||
     !Number.isSafeInteger(report.totalUnits))throw Error("Unverified recap totals cannot be published");
  const spec=DROP_RECAP_RETAILERS[retailer];
  if(!spec)throw Error("Unknown recap retailer");
  const placed=Number(report.ordersPlaced)||0;
  const cancelled=Number(report.deduplicatedCancelledOrders)||0;
  const rate=placed+cancelled>0?Math.round(1000*placed/(placed+cancelled))/10:0;
  const localDate=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",
    month:"long",day:"numeric",year:"numeric"}).format(new Date(report.periodStart));
  const top=(report.topProducts||[]).slice(0,5).map((p,i)=>
    (i+1)+". "+safeText(p.name)+" × "+Number(p.quantity)).join("\n")||"No verified products";
  const sourceImage=(report.topProducts||[]).map(x=>x.imageUrl).find(Boolean);
  return {content:"@everyone 📊 **DROP RECAP — "+spec.name.toUpperCase()+" · "+localDate+"**",
    allowed_mentions:{parse:["everyone"]},
    embeds:[{title:"DROP RECAP · "+spec.name+" · "+localDate,color:0x2cbaed,
      description:"Verified only from SLABSNGRABSTC **#success** webhooks.\n"+
        "Tax: **7%** per order; shipping: **$5.99** under $35.",
      fields:[
        {name:"💚 TOTAL SPENT",value:"**"+currency(report.totalSpentCents)+"**",inline:true},
        {name:"📦 UNITS",value:"**"+report.totalUnits+"**",inline:true},
        {name:"✅ ORDERS PLACED",value:"**"+placed+"**",inline:true},
        {name:"❌ CANCELLED",value:"**"+cancelled+"**",inline:true},
        {name:"📈 STICK RATE",value:"**"+rate.toFixed(1)+"%**",inline:true},
        {name:"TOP PRODUCTS",value:top.slice(0,1000)}
      ],
      ...(sourceImage?{thumbnail:{url:sourceImage}}:{}),
      footer:{text:"SNG-DROP-RECAP:"+id},timestamp:new Date().toISOString()}]};
}
const fileStatus=record=>record.status==="posted"?"recap posted":
  record.status==="scheduled"?"recap scheduled":
  record.status==="blocked"?"verification pending":
  record.status==="posting"?"live announcement pending":
  record.status==="publishing"?"recap publication pending":record.status;
export function createDiscordDropRecapController({
  dataDir,api,token,guildId,ownerId,generalChannelId,controlChannelId,
  onDropNotification=async()=>{},getSource=fetchDirectSourceMessages,
  makeReport=buildDiscordSourceRecap,now=()=>Date.now()
}){
  if(!dataDir||typeof api!=="function"||!token||!guildId||!ownerId||
     !generalChannelId||!controlChannelId)throw Error("Drop announcement controller requires configured channels");
  const store=path.join(dataDir,"discord-live-drop-recaps.json");
  let queue=Promise.resolve(),timer=null;
  const serialized=task=>{const next=queue.then(task);queue=next.catch(()=>{});return next;};
  async function read(){
    try{
      const parsed=JSON.parse(await fs.readFile(store,"utf8"));
      return {drops:Array.isArray(parsed.drops)?parsed.drops:[]};
    }catch(e){if(e.code==="ENOENT")return {drops:[]};throw e;}
  }
  async function save(data){
    await fs.mkdir(dataDir,{recursive:true});
    const tmp=store+"."+crypto.randomUUID()+".tmp";
    await fs.writeFile(tmp,JSON.stringify(data,null,2),{mode:0o600});
    await fs.rename(tmp,store);
  }
  async function findByMarker(marker){
    let before="";
    for(let page=0;page<3;page++){
      const messages=await api("/channels/"+generalChannelId+"/messages?limit=100"+
        (before?"&before="+before:""));
      if(!Array.isArray(messages))break;
      const match=messages.find(item=>(item.embeds||[]).some(e=>
        String(e.footer?.text||"")===marker));
      if(match)return match;
      if(messages.length<100)break;
      before=String(messages[messages.length-1]?.id||"");
      if(!/^\d{17,22}$/.test(before))break;
    }
    return null;
  }
  async function notify(kind,record,message){
    const spec=DROP_RECAP_RETAILERS[record.retailer];
    const link="https://discord.com/channels/"+guildId+"/"+generalChannelId+"/"+message.id;
    try{
      await onDropNotification({notification:{kind:"drop_announcement",retailers:[record.retailer],
        title:kind==="live"?"DROP IS LIVE — "+spec.name:"DROP RECAP — "+spec.name,
        message:kind==="live"?"The "+spec.name+" drop is live. Recap in 12 hours.":
          "The verified "+spec.name+" drop recap has been posted.",
        sourceUrl:link,retailer:record.retailer,tab:"drops"},
        eventKey:"drop:"+record.id+":"+kind,messageId:message.id});
    }catch(error){console.error("Drop mobile alert:",error?.message||"unavailable");}
  }
  async function startRetailer(retailer){
    return serialized(async()=>{
      if(!DROP_RECAP_RETAILERS[retailer])throw Error("Choose a supported retailer");
      const data=await read(),time=now();
      const active=data.drops.find(d=>d.retailer===retailer&&
        ["posting","scheduled","blocked","publishing","posting_error","publishing_error"].includes(d.status));
      if(active)throw Error("A "+DROP_RECAP_RETAILERS[retailer].name+
        " drop is still open ("+fileStatus(active)+"). Use Pending / Posted to review.");
      const id=crypto.randomUUID();
      const record={id,retailer,startedAt:stamp(time),dueAt:stamp(time+DROP_RECAP_DELAY_MS),
        status:"posting",generalChannelId,createdAt:stamp(time)};
      data.drops.push(record);
      data.drops=data.drops.slice(-250);
      await save(data);
      let posted;
      try{
        posted=await api("/channels/"+generalChannelId+"/messages","POST",
          buildDropAnnouncement(retailer,id,time));
      }catch(error){
        record.status="posting_error";
        record.error="Discord delivery could not be confirmed; inspect #general before retrying.";
        await save(data);
        throw Error(record.error);
      }
      record.status="scheduled";record.liveMessageId=String(posted.id);
      await save(data);
      await notify("live",record,posted);
      return record;
    });
  }
  async function reconcileAmbiguous(record,data) {
    const marker=record.status.startsWith("publishing")?"SNG-DROP-RECAP:":"SNG-DROP-LIVE:";
    const found=await findByMarker(marker+record.id);
    if(found){
      record.status=marker.includes("RECAP")?"posted":"scheduled";
      if(marker.includes("RECAP"))record.recapMessageId=String(found.id);
      else record.liveMessageId=String(found.id);
      await save(data);
    }
    return Boolean(found);
  }
  async function dueRecaps(){
    return serialized(async()=>{
      const data=await read(),time=now();
      // Crash recovery is read-only: an ambiguous REST response can never
      // cause an automatic duplicate public announcement or recap.
      for(const record of data.drops.filter(d=>["posting","posting_error","publishing","publishing_error"].includes(d.status))){
        try{await reconcileAmbiguous(record,data);}
        catch(error){console.error("Drop post reconciliation:",error?.message);}
      }
      for(const record of data.drops.filter(d=>["scheduled","blocked"].includes(d.status)&&
        Date.parse(d.dueAt)<=time&&(!d.retryAt||Date.parse(d.retryAt)<=time))){
        const spec=DROP_RECAP_RETAILERS[record.retailer];
        if(!spec){record.status="blocked";record.retryAt=stamp(time+3600000);await save(data);continue;}
        let report;
        try{
          const history=await getSource(token,Date.parse(record.startedAt),time);
          report=makeReport(history.messages,{channelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID,
            from:record.startedAt,toExclusive:record.dueAt,asOf:time,retailer:spec.label,
            parseCheckout:parseDiscordSuccessForRecap,historyComplete:history.historyComplete});
        }catch(error){
          record.status="blocked";
          record.retryAt=stamp(time+15*60000);
          record.blockedReasons=["discord_source_read_failed"];
          await save(data);
          console.error("Drop recap source verification:",error?.message||"unavailable");
          continue;
        }
        if(!report.readyToPublish){
          const firstNotice=record.status!=="blocked";
          record.status="blocked";
          record.retryAt=stamp(time+15*60000);
          record.blockedReasons=report.blockedReasons;
          await save(data);
          if(firstNotice){
            await api("/channels/"+controlChannelId+"/messages","POST",{
              content:"⚠️ **"+spec.name+" recap held for verification.** No public totals were posted.\nReasons: "+
                report.blockedReasons.join(", ").slice(0,800)+"\nThe bot will recheck the original #success source.",
              allowed_mentions:{parse:[]}
            }).catch(error=>console.error("Recap owner alert:",error?.message));
          }
          continue;
        }
        record.status="publishing";record.blockedReasons=[];
        await save(data);
        let posted;
        try{
          posted=await api("/channels/"+generalChannelId+"/messages","POST",
            buildDropRecapPost(record.retailer,record.id,report));
        }catch(error){
          record.status="publishing_error";
          record.error="Discord recap delivery could not be confirmed; inspect #general.";
          await save(data);
          console.error("Drop recap delivery:",error?.message||"unknown");
          continue;
        }
        record.status="posted";
        record.recapMessageId=String(posted.id);
        record.postedAt=stamp(now());
        await save(data);
        await notify("recap",record,posted);
      }
    });
  }
  async function statusText(){
    const data=await read();
    const recent=data.drops.slice(-12).reverse();
    return recent.length?recent.map(d=>{
      const spec=DROP_RECAP_RETAILERS[d.retailer];
      return "**"+(spec?.name||"Unknown")+"** · "+fileStatus(d)+
        " · due <t:"+Math.floor(Date.parse(d.dueAt)/1000)+":F>"+
        (d.blockedReasons?.length?" · "+d.blockedReasons.slice(0,3).join(", "):"")+
        (d.liveMessageId?" · https://discord.com/channels/"+guildId+"/"+generalChannelId+"/"+d.liveMessageId:"");
    }).join("\n").slice(0,1900):"No drops started from this panel yet.";
  }
  async function handleInteraction(d){
    const user=String(d?.member?.user?.id||"");
    const id=String(d?.data?.custom_id||"");
    const callback="/interactions/"+d.id+"/"+d.token+"/callback";
    const reply=content=>api(callback,"POST",{type:4,data:{flags:64,content,allowed_mentions:{parse:[]}}});
    if(user!==String(ownerId)||String(d.channel_id)!==String(controlChannelId))
      return reply("Only the verified server owner can use these controls in #drop-controls.");
    if(id==="sngdrop:status")return reply(await statusText());
    const start=id.match(/^sngdrop:start:(target|walmart|pokemoncenter|costco|sams)$/);
    if(start){
      const spec=DROP_RECAP_RETAILERS[start[1]];
      return api(callback,"POST",{type:4,data:{flags:64,
        content:"**"+spec.name+" — DROP IS LIVE**\n\nThis will mention @everyone in #general immediately and schedule a source-verified recap **12 hours later**. Confirm?",
        allowed_mentions:{parse:[]},
        components:[{type:1,components:[
          {type:2,style:3,label:"CONFIRM "+spec.name+" DROP",custom_id:"sngdrop:confirm:"+start[1]},
          {type:2,style:2,label:"Cancel",custom_id:"sngdrop:cancel"}]}]}});
    }
    if(id==="sngdrop:cancel")return api(callback,"POST",{type:7,data:{
      flags:64,content:"Drop announcement cancelled. No post was sent.",components:[],
      allowed_mentions:{parse:[]}}});
    const confirm=id.match(/^sngdrop:confirm:(target|walmart|pokemoncenter|costco|sams)$/);
    if(!confirm)return reply("This drop control is no longer valid.");
    await api(callback,"POST",{type:5,data:{flags:64}});
    let message;
    try{
      const d=await startRetailer(confirm[1]);
      message="✅ **DROP IS LIVE** posted to #general.\nRecap due <t:"+
        Math.floor(Date.parse(d.dueAt)/1000)+":F>.\n"+
        "https://discord.com/channels/"+guildId+"/"+generalChannelId+"/"+d.liveMessageId;
    }catch(error){message="⚠️ "+String(error?.message||"The drop could not be posted.").slice(0,320);}
    return api("/webhooks/"+String(d.application_id)+"/"+String(d.token)+
      "/messages/@original","PATCH",{content:message,components:[],allowed_mentions:{parse:[]}});
  }
  function start(){
    if(timer)return;
    timer=setInterval(()=>void dueRecaps().catch(error=>
      console.error("Scheduled Discord recap:",error?.message)),60000);
    timer.unref?.();
    void dueRecaps().catch(error=>console.error("First Discord recap check:",error?.message));
  }
  return {start,startRetailer,dueRecaps,handleInteraction,statusText};
}
