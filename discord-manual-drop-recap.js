// Owner-controlled manual recap windows, independent of scheduled 12-hour drops.
// Only the original Discord Success webhook source may supply metrics.
// The draft is private; no public post is made until the owner confirms.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {SLABSNGRABSTC_SUCCESS_CHANNEL_ID} from "./discord-source-price-field-policy.js";

const TIME_ZONE="America/New_York";
const DRAFT_LIFETIME_MS=20*60*1000;
const RETAILERS=Object.freeze({
  all:{label:"All retailers",source:"All",emoji:"📊"},
  target:{label:"Target",source:"Target",emoji:"🎯"},
  walmart:{label:"Walmart",source:"Walmart",emoji:"🛒"},
  pokemoncenter:{label:"Pokémon Center",source:"PKC",emoji:"⚡"},
  costco:{label:"Costco",source:"Costco",emoji:"📦"},
  sams:{label:"Sam's Club",source:"Sam's Club",emoji:"⭐"}
});
const visibilityKeys=Object.freeze({
  placed:"showPlacedOrders",
  cancels:"showCancelled",
  stick:"showStickRate"
});
const replyData=content=>({flags:64,content,allowed_mentions:{parse:[]}});
const fmt=ms=>new Intl.DateTimeFormat("en-US",{
  timeZone:TIME_ZONE,dateStyle:"medium",timeStyle:"short"
}).format(new Date(ms));
const nextDay=d=>{
  const [y,m,day]=d.split("-").map(Number);
  return new Date(Date.UTC(y,m-1,day+1)).toISOString().slice(0,10);
};
function validDate(d){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d))return false;
  const [y,m,day]=d.split("-").map(Number);
  const x=new Date(Date.UTC(y,m-1,day));
  return Number.isFinite(x.getTime())&&x.toISOString().slice(0,10)===d;
}
// Do not guess an Eastern timestamp during a daylight-saving gap or fold.
function easternInstant(day,clock){
  if(!validDate(day)||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock))
    throw Error("Use a valid date (YYYY-MM-DD) and 24-hour time (HH:MM).");
  const [year,month,date]=day.split("-").map(Number);
  const [hour,minute]=clock.split(":").map(Number);
  const naive=Date.UTC(year,month-1,date,hour,minute);
  const dtf=new Intl.DateTimeFormat("en-US",{timeZone:TIME_ZONE,
    year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
  const matches=[];
  for(const offset of [4,5]){
    const candidate=naive+offset*3600000;
    const parts=Object.fromEntries(dtf.formatToParts(new Date(candidate))
      .filter(x=>x.type!=="literal").map(x=>[x.type,Number(x.value)]));
    if(parts.year===year&&parts.month===month&&parts.day===date&&
       parts.hour===hour&&parts.minute===minute)matches.push(candidate);
  }
  if(matches.length!==1)
    throw Error("That time is ambiguous or unavailable because of daylight saving. Choose another time.");
  return matches[0];
}
export function manualRecapWindow(date,startTime,endTime,nowMs=Date.now()){
  const start=easternInstant(String(date||"").trim(),String(startTime||"").trim());
  let end=easternInstant(String(date||"").trim(),String(endTime||"").trim());
  if(end<=start)
    end=easternInstant(nextDay(String(date||"").trim()),String(endTime||"").trim());
  if(end-start>24*3600000)throw Error("Select a window of 24 hours or less.");
  if(end>nowMs)throw Error("The recap end time must already have passed.");
  return {from:new Date(start).toISOString(),toExclusive:new Date(end).toISOString(),
    fromMs:start,toMs:end};
}
function componentsForModal(retailer){
  const textInput=(id,label,placeholder,max)=>({type:1,components:[{
    type:4,custom_id:id,style:1,label,placeholder,required:true,
    min_length:max,max_length:max
  }]});
  return {type:9,data:{
    custom_id:"sngdrop:manual:form:"+retailer,
    title:"Manual "+RETAILERS[retailer].label+" Recap",
    components:[
      textInput("sngdate","Date (YYYY-MM-DD)","2026-11-19",10),
      textInput("sngstart","Start time ET (HH:MM)","03:00",5),
      textInput("sngend","End time ET (HH:MM)","08:00",5)
    ]
  }};
}
function modalValue(d,id){
  for(const row of d?.data?.components||[]){
    for(const field of row?.components||[])
      if(field.custom_id===id)return String(field.value||"").trim();
  }
  return "";
}
function toggles(session){
  const vis=session.visibility;
  const toggle=(key,label)=>{
    const shown=vis[visibilityKeys[key]];
    return {type:2,style:shown?3:2,
      label:(shown?"✓ ":"✕ ")+label,
      custom_id:"sngdrop:manual:toggle:"+key+":"+session.id};
  };
  const controls=[{type:1,components:[
    toggle("placed","Placed Orders"),
    toggle("cancels","Cancelled"),
    toggle("stick","Stick Rate")
  ]}];
  const row=[{type:2,style:2,label:"Cancel",custom_id:"sngdrop:manual:cancel:"+session.id}];
  if(session.ready)row.unshift({type:2,style:3,label:"Confirm Post to #general",
    custom_id:"sngdrop:manual:publish:"+session.id});
  controls.push({type:1,components:row});
  return controls;
}
export function manualRecapPreviewPayload(session,postBuilder){
  const r=session.report;
  const head="**PRIVATE PREVIEW — NO DISCORD POST SENT**\n"+
    "**"+RETAILERS[session.retailer].label+"** · "+
    fmt(Date.parse(session.from))+" → "+fmt(Date.parse(session.toExclusive))+
    " (Eastern)\nThe buttons below determine which metrics members will see.";
  if(!session.ready){
    return {content:head+"\n\n⚠️ **Recap is blocked until source verification succeeds.**"+
      "\n"+(r?.blockedReasons||["Discord Success unavailable"]).slice(0,8).join(", ").slice(0,600),
      embeds:[],components:[{type:1,components:[
        {type:2,style:2,label:"Close",custom_id:"sngdrop:manual:cancel:"+session.id}
      ]}],allowed_mentions:{parse:[]}};
  }
  const sample=postBuilder(session.retailer,session.id,r,session.visibility);
  return {content:head+"\n\n**Verified only from the original Discord #success webhooks.**",
    embeds:sample.embeds,components:toggles(session),allowed_mentions:{parse:[]}};
}
function safeError(error){
  return String(error?.message||"Unexpected recap error")
    .replace(/<@!?[0-9]+>|@everyone|@here/g,"").slice(0,350);
}
export function createManualDiscordRecapFlow({
  api,token,ownerId,guildId,controlChannelId,generalChannelId,dataDir,
  getSource,makeReport,parseCheckout,postBuilder,sendGraphic=null,prepareGraphic=null,previewGraphic=null,now=()=>Date.now()
}){
  if(!api||!token||!ownerId||!guildId||!controlChannelId||!generalChannelId||
    !dataDir||!getSource||!makeReport||!parseCheckout||!postBuilder)
    throw Error("Manual recap requires the verified Discord source and owner control channel.");
  const previews=new Map(),journal=path.join(dataDir,"discord-manual-recaps.json");
  let queue=Promise.resolve();
  const serialized=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  const original=d=>"/webhooks/"+d.application_id+"/"+d.token+"/messages/@original";
  const callback=d=>"/interactions/"+d.id+"/"+d.token+"/callback";
  const acknowledge=(d,type,data)=>api(callback(d),"POST",{type,data});
  const patch=(d,data)=>api(original(d),"PATCH",data);
  async function readJournal(){
    try{
      const parsed=JSON.parse(await fs.readFile(journal,"utf8"));
      return {posts:Array.isArray(parsed.posts)?parsed.posts:[]};
    }catch(e){if(e.code==="ENOENT")return {posts:[]};throw e;}
  }
  async function saveJournal(data){
    await fs.mkdir(dataDir,{recursive:true});
    const tmp=journal+"."+crypto.randomUUID()+".tmp";
    await fs.writeFile(tmp,JSON.stringify(data,null,2),{mode:0o600});
    await fs.rename(tmp,journal);
  }
  function draft(id){
    const s=previews.get(id);
    if(!s||s.expiresAt<=now()||s.status!=="preview")return null;
    return s;
  }
  function cleanup(){
    for(const [key,value] of previews)
      if(value.expiresAt<=now()||value.status==="posted")previews.delete(key);
  }
  async function reportFor(retailer,from,to){
    const cut=now();
    const messages=await getSource(token,Date.parse(from),cut);
    const report=makeReport(messages.messages,{
      channelId:SLABSNGRABSTC_SUCCESS_CHANNEL_ID,
      from,toExclusive:to,asOf:cut,retailer:RETAILERS[retailer].source,
      parseCheckout,historyComplete:messages.historyComplete
    });
    return report;
  }
  async function publish(d,session){
    await acknowledge(d,6);
    session.status="publishing";
    let report;
    try{report=await reportFor(session.retailer,session.from,session.toExclusive);}
    catch(error){
      session.status="preview";
      return patch(d,{content:"⚠️ Could not recheck Discord Success. No recap was posted: "+safeError(error),
        embeds:[],components:[],allowed_mentions:{parse:[]}});
    }
    if(!report.readyToPublish||!Number.isSafeInteger(report.totalSpentCents)||
       !Number.isSafeInteger(report.totalUnits)){
      session.status="preview";
      return patch(d,{content:"⚠️ Source verification changed. **Nothing was posted.**\n"+
        (report.blockedReasons||["incomplete source"]).slice(0,8).join(", ").slice(0,600)+
        "\nOpen Create Manual Recap again to retry.",
        embeds:[],components:[],allowed_mentions:{parse:[]}});
    }
    // Render and validate the owner-approved graphic BEFORE journaling a publish.
    // A missing image is a private validation block, never an ambiguous Discord post.
    let graphic=null;
    if(prepareGraphic){
      try{graphic=await prepareGraphic({retailer:session.retailer,report,visibility:session.visibility});}
      catch(error){
        session.status="preview";
        return patch(d,{content:"⚠️ Approved recap graphic is unavailable. **Nothing was posted.** "+
          safeError(error),embeds:[],components:[],allowed_mentions:{parse:[]}});
      }
    }
    const publishResult=await serialized(async()=>{
      const data=await readJournal();
      const existing=data.posts.find(p=>p.retailer===session.retailer&&
        p.from===session.from&&p.toExclusive===session.toExclusive&&
        String(p.generalChannelId)===String(generalChannelId));
      if(existing)return {existing};
      const record={id:session.id,retailer:session.retailer,
        from:session.from,toExclusive:session.toExclusive,
        visibility:{...session.visibility},generalChannelId:String(generalChannelId),
        createdAt:new Date(now()).toISOString(),status:"publishing"};
      data.posts.push(record);
      data.posts=data.posts.slice(-400);
      await saveJournal(data);
      return {record};
    });
    if(publishResult.existing){
      session.status="done";
      const old=publishResult.existing;
      const link=old.messageId?
        "\nhttps://discord.com/channels/"+guildId+"/"+generalChannelId+"/"+old.messageId:"";
      return patch(d,{content:"This retailer and time window was already submitted"+
        " ("+old.status+"). Duplicate posting was prevented."+link,
        embeds:[],components:[],allowed_mentions:{parse:[]}});
    }
    const record=publishResult.record;
    const payload=postBuilder(session.retailer,"manual-"+session.id,report,session.visibility);
    // Manual posts do not ping @everyone or send app alerts.
    payload.content=payload.content.replace(/^@everyone\s*/,"");
    payload.allowed_mentions={parse:[]};
    let posted;
    try{
      posted=sendGraphic?await sendGraphic({channelId:generalChannelId,retailer:session.retailer,report,visibility:session.visibility,graphic,payload}):
        await api("/channels/"+generalChannelId+"/messages","POST",payload);
    }catch(error){
      await serialized(async()=>{
        const data=await readJournal();
        const row=data.posts.find(p=>p.id===record.id);
        if(row){row.status="delivery_unconfirmed";row.error=safeError(error);await saveJournal(data);}
      });
      session.status="done";
      return patch(d,{content:"⚠️ Discord delivery could not be confirmed. **Do not retry yet**;"+
        " check #general first. The bot will not automatically send a duplicate.",
        embeds:[],components:[],allowed_mentions:{parse:[]}});
    }
    await serialized(async()=>{
      const data=await readJournal();
      const row=data.posts.find(p=>p.id===record.id);
      if(row){row.status="posted";row.messageId=String(posted.id);
        row.postedAt=new Date(now()).toISOString();await saveJournal(data);}
    });
    session.status="posted";
    return patch(d,{content:"✅ **Manual recap posted to #general.**\n"+
      fmt(Date.parse(session.from))+" → "+fmt(Date.parse(session.toExclusive))+
      " (Eastern)\nhttps://discord.com/channels/"+guildId+"/"+generalChannelId+"/"+posted.id,
      embeds:[],components:[],allowed_mentions:{parse:[]}});
  }
  async function handleInteraction(d){
    const user=String(d?.member?.user?.id||d?.user?.id||"");
    const id=String(d?.data?.custom_id||"");
    if(user!==String(ownerId)||String(d?.channel_id)!==String(controlChannelId))
      return acknowledge(d,4,replyData("Only the verified owner may create or post recaps."));
    cleanup();
    if(id==="sngdrop:manual:open")
      return acknowledge(d,4,{...replyData("**Create manual Discord recap**\n"+
        "Choose the retailer. You will enter the date and start/end times in Eastern Time."),components:[
        {type:1,components:[{type:3,custom_id:"sngdrop:manual:retailer",
          placeholder:"Choose retailer to recap",min_values:1,max_values:1,
          options:Object.entries(RETAILERS).map(([value,x])=>({
            label:x.label,value,emoji:{name:x.emoji}
          }))}]}
      ]});
    if(id==="sngdrop:manual:retailer"){
      const retailer=String(d?.data?.values?.[0]||"");
      if(!RETAILERS[retailer])
        return acknowledge(d,4,replyData("Choose a supported retailer."));
      return api(callback(d),"POST",componentsForModal(retailer));
    }
    const form=id.match(/^sngdrop:manual:form:(all|target|walmart|pokemoncenter|costco|sams)$/);
    if(form){
      await acknowledge(d,5,{flags:64});
      let window;
      try{
        window=manualRecapWindow(modalValue(d,"sngdate"),
          modalValue(d,"sngstart"),modalValue(d,"sngend"),now());
      }catch(error){
        return patch(d,{...replyData("⚠️ "+safeError(error)+"\nNo recap was posted."),
          components:[]});
      }
      let report;
      try{report=await reportFor(form[1],window.from,window.toExclusive);}
      catch(error){
        return patch(d,{...replyData("⚠️ Discord Success could not be read: "+
          safeError(error)+"\nNo recap was posted."),components:[]});
      }
      const ready=Boolean(report.readyToPublish&&
        Number.isSafeInteger(report.totalSpentCents)&&Number.isSafeInteger(report.totalUnits));
      const session={id:crypto.randomUUID(),retailer:form[1],
        from:window.from,toExclusive:window.toExclusive,report,ready,
        visibility:{showPlacedOrders:true,showCancelled:true,showStickRate:true},
        expiresAt:now()+DRAFT_LIFETIME_MS,status:"preview"};
      previews.set(session.id,session);
      if(session.ready&&prepareGraphic&&previewGraphic){
        try{
          const graphic=await prepareGraphic({retailer:session.retailer,report,visibility:session.visibility});
          return await previewGraphic({interaction:d,graphic,payload:manualRecapPreviewPayload(session,postBuilder)});
        }catch(error){
          session.ready=false;
          session.report={...report,blockedReasons:[...(report.blockedReasons||[]),"approved_recap_graphic_unavailable"]};
        }
      }
      return patch(d,manualRecapPreviewPayload(session,postBuilder));
    }
    const toggle=id.match(/^sngdrop:manual:toggle:(placed|cancels|stick):([a-f0-9-]{36})$/);
    if(toggle){
      const s=draft(toggle[2]);
      if(!s)return acknowledge(d,4,replyData("This preview expired. Open Create Manual Recap again."));
      const key=visibilityKeys[toggle[1]];
      s.visibility[key]=!s.visibility[key];
      if(prepareGraphic&&previewGraphic){
        await acknowledge(d,6);
        try{
          const graphic=await prepareGraphic({retailer:s.retailer,report:s.report,visibility:s.visibility});
          return await previewGraphic({interaction:d,graphic,payload:manualRecapPreviewPayload(s,postBuilder)});
        }catch(error){
          s.ready=false;
          s.report={...s.report,blockedReasons:[...(s.report?.blockedReasons||[]),"approved_recap_graphic_unavailable"]};
          return patch(d,manualRecapPreviewPayload(s,postBuilder));
        }
      }
      return acknowledge(d,7,manualRecapPreviewPayload(s,postBuilder));
    }
    const cancel=id.match(/^sngdrop:manual:cancel:([a-f0-9-]{36})$/);
    if(cancel){
      previews.delete(cancel[1]);
      return acknowledge(d,7,{content:"Manual recap cancelled. **Nothing was posted.**",
        embeds:[],components:[],allowed_mentions:{parse:[]}});
    }
    const confirm=id.match(/^sngdrop:manual:publish:([a-f0-9-]{36})$/);
    if(confirm){
      const s=draft(confirm[1]);
      if(!s||!s.ready)
        return acknowledge(d,4,replyData("This preview is unavailable. Open Create Manual Recap again."));
      try{return await publish(d,s);}
      catch(error){
        console.error("Manual Discord recap:",safeError(error));
        // If Discord publication is ambiguous, never blindly retry.
        s.status="done";
        return patch(d,{content:"⚠️ Manual recap could not finish. Check #general before"+
          " submitting again. "+safeError(error),embeds:[],components:[],
          allowed_mentions:{parse:[]}});
      }
    }
    return acknowledge(d,4,replyData("Unknown manual recap control."));
  }
  return {handleInteraction};
}
