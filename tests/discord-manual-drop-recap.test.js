import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  manualRecapWindow,createManualDiscordRecapFlow
} from "../discord-manual-drop-recap.js";
import {
  buildDropRecapPost,createDiscordDropRecapController,dropControlRows
} from "../discord-live-drop-recap.js";
import {SLABSNGRABSTC_SUCCESS_CHANNEL_ID} from "../discord-source-price-field-policy.js";

const OWNER="1532179373292257293";
const GUILD="803097107660931082";
const CHANNEL="1532179373292257292";
const GENERAL="1532179373292257291";
const CLOCK=Date.parse("2026-11-19T21:00:00.000Z");
const REPORT={
  readyToPublish:true,
  periodStart:"2026-11-19T08:00:00.000Z",
  totalSpentCents:340894,
  totalUnits:84,
  ordersPlaced:51,
  deduplicatedCancelledOrders:3,
  topProducts:[
    {name:"Celebration Tin",quantity:44,imageUrl:"https://target.scene7.com/is/image/Target/GUEST-test"},
    {name:"Binder Collection",quantity:23,imageUrl:null}
  ],
  blockedReasons:[]
};
function interaction(custom_id,kind=3,values=null){
  return {
    type:kind,guild_id:GUILD,
    channel_id:CHANNEL,id:"1611111111111111320",token:"test-token",
    application_id:"1611111111111111321",
    member:{user:{id:OWNER}},
    data:{custom_id,...(values?{values}:{})}
  };
}
function form(retailer="target"){
  return {
    ...interaction("sngdrop:manual:form:"+retailer,5),
    data:{custom_id:"sngdrop:manual:form:"+retailer,components:[
      {type:1,components:[{custom_id:"sngdate",value:"2026-11-19"}]},
      {type:1,components:[{custom_id:"sngstart",value:"03:00"}]},
      {type:1,components:[{custom_id:"sngend",value:"08:00"}]}
    ]}
  };
}
async function harness(t,{ready=true,failPublish=false,graphic=false,failGraphic=false}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"sng-manual-recap-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const calls=[],reports=[],scans=[];
  let posted=0;
  const api=async (url,method="GET",payload)=>{
    calls.push({url,method,payload});
    if(method==="POST"&&url==="/channels/"+GENERAL+"/messages"){
      if(failPublish)throw Error("delivery timeout");
      return {id:String(1651111111111111000n+BigInt(posted++)),embeds:payload.embeds};
    }
    if(url.startsWith("/interactions/")&&method==="POST")return {ok:true};
    if(url.startsWith("/webhooks/")&&method==="PATCH")return {ok:true};
    if(method==="GET"&&url.includes("/messages?"))return [];
    throw Error("Unexpected REST action "+method+" "+url);
  };
  const getSource=async(token,start,cutoff)=>{
    scans.push({token,start,cutoff});
    return {messages:[],historyComplete:true};
  };
  const makeReport=(messages,options)=>{
    reports.push({messages,options});
    return ready?{...REPORT}:{...REPORT,readyToPublish:false,
      totalSpentCents:null,blockedReasons:["missing_source_unit_prices_for_rule_total"]};
  };
  const args={api,token:"dummy",ownerId:OWNER,guildId:GUILD,
    controlChannelId:CHANNEL,generalChannelId:GENERAL,dataDir:dir,
    getSource,makeReport,parseCheckout:()=>null,postBuilder:buildDropRecapPost,
    ...(graphic?{
      prepareGraphic:async()=>{if(failGraphic)throw Error("Missing approved PNG");return Buffer.from("verified-preview-buffer");},
      previewGraphic:async({payload})=>{calls.push({url:"/webhooks/"+OWNER+"/messages/@original",method:"PATCH",payload:{...payload,embeds:[{title:"PRIVATE RECAP GRAPHIC PREVIEW"}]}});return {ok:true};},
      sendGraphic:async({payload,graphic:bytes})=>{
        assert.ok(Buffer.isBuffer(bytes));
        calls.push({url:"/channels/"+GENERAL+"/messages",method:"POST",payload});
        return {id:String(1651111111111111000n+BigInt(posted++))};
      }
    }:{}),
    now:()=>CLOCK};
  const flow=createManualDiscordRecapFlow(args);
  const posts=()=>calls.filter(c=>c.url==="/channels/"+GENERAL+"/messages");
  const lastPatch=()=>calls.filter(c=>c.url.includes("/webhooks/")&&c.method==="PATCH").at(-1)?.payload;
  const lastReply=()=>calls.filter(c=>c.url.includes("/interactions/")&&c.method==="POST").at(-1)?.payload;
  const start=async(retailer="target")=>{
    await flow.handleInteraction(interaction("sngdrop:manual:open"));
    await flow.handleInteraction(interaction("sngdrop:manual:retailer",3,[retailer]));
    await flow.handleInteraction(form(retailer));
    return lastPatch();
  };
  return {flow,calls,reports,scans,posts,lastPatch,lastReply,start,args,dir};
}
test("manual entry is a separate owner panel button; automatic drop controls remain",()=>{
  const buttons=dropControlRows().flatMap(row=>row.components.map(c=>c.custom_id));
  assert.ok(buttons.includes("sngdrop:manual:open"));
  assert.ok(buttons.includes("sngdrop:start:target"));
  assert.ok(buttons.includes("sngdrop:status"));
});
test("Eastern manual windows support same-day and overnight with strict validation",()=>{
  const w=manualRecapWindow("2026-11-19","03:00","08:00",CLOCK);
  assert.equal(w.from,"2026-11-19T08:00:00.000Z");
  assert.equal(w.toExclusive,"2026-11-19T13:00:00.000Z");
  const over=manualRecapWindow("2026-11-18","23:00","02:00",CLOCK);
  assert.equal(over.toExclusive,"2026-11-19T07:00:00.000Z");
  assert.throws(()=>manualRecapWindow("2026-11-19","23:00","23:59",CLOCK),/must already have passed/);
  assert.throws(()=>manualRecapWindow("2026-11-31","03:00","08:00",CLOCK),/valid date/);
  assert.throws(()=>manualRecapWindow("2026-11-19","3 AM","08:00",CLOCK),/24-hour time/);
  assert.throws(()=>manualRecapWindow("2026-11-01","01:30","02:30",CLOCK),/ambiguous/);
  assert.throws(()=>manualRecapWindow("2026-03-08","02:30","03:30",CLOCK),/ambiguous or unavailable/);
});
test("owner chooses retailer then enters date/time through Discord modal",async t=>{
  const h=await harness(t);
  await h.flow.handleInteraction(interaction("sngdrop:manual:open"));
  const initial=h.lastReply().data;
  assert.equal(initial.flags,64);
  const options=initial.components[0].components[0].options;
  assert.equal(options.length,6);
  assert.ok(options.some(o=>o.value==="all"));
  assert.equal(h.posts().length,0);
  await h.flow.handleInteraction(interaction("sngdrop:manual:retailer",3,["walmart"]));
  const modal=h.lastReply();
  assert.equal(modal.type,9);
  assert.match(modal.data.title,/Walmart/);
  assert.equal(modal.data.components.length,3);
  assert.equal(h.posts().length,0);
});
test("manual preview uses original Success, never posts before confirmation",async t=>{
  const h=await harness(t);
  const preview=await h.start("target");
  assert.match(preview.content,/PRIVATE PREVIEW/);
  assert.equal(preview.allowed_mentions.parse.length,0);
  assert.equal(h.reports[0].options.channelId,SLABSNGRABSTC_SUCCESS_CHANNEL_ID);
  assert.equal(h.reports[0].options.retailer,"Target");
  assert.equal(h.reports[0].options.from,"2026-11-19T08:00:00.000Z");
  assert.equal(h.reports[0].options.toExclusive,"2026-11-19T13:00:00.000Z");
  assert.equal(h.posts().length,0);
  assert.match(preview.embeds[0].fields.map(f=>f.name).join(" "),/ORDERS PLACED/);
  assert.match(preview.embeds[0].fields.map(f=>f.name).join(" "),/CANCELLED/);
  assert.match(preview.embeds[0].fields.map(f=>f.name).join(" "),/STICK RATE/);
});
test("Placed Orders, Cancelled, and Stick Rate can be hidden independently",async t=>{
  const h=await harness(t);
  const preview=await h.start();
  const toggle=preview.components[0].components[0].custom_id;
  const id=toggle.split(":").at(-1);
  await h.flow.handleInteraction(interaction("sngdrop:manual:toggle:placed:"+id));
  let fields=h.lastReply().data.embeds[0].fields.map(f=>f.name).join(" ");
  assert.doesNotMatch(fields,/ORDERS PLACED/);
  assert.match(fields,/CANCELLED/);
  assert.match(fields,/STICK RATE/);
  await h.flow.handleInteraction(interaction("sngdrop:manual:toggle:cancels:"+id));
  await h.flow.handleInteraction(interaction("sngdrop:manual:toggle:stick:"+id));
  fields=h.lastReply().data.embeds[0].fields.map(f=>f.name).join(" ");
  assert.doesNotMatch(fields,/ORDERS PLACED|CANCELLED|STICK RATE/);
  assert.match(fields,/TOTAL SPENT/);
  assert.match(fields,/UNITS/);
  assert.match(fields,/TOP PRODUCTS/);
  assert.equal(h.posts().length,0);
  await h.flow.handleInteraction(interaction("sngdrop:manual:publish:"+id));
  assert.equal(h.posts().length,1);
  const sent=h.posts()[0].payload;
  assert.equal(sent.allowed_mentions.parse.length,0);
  assert.doesNotMatch(sent.content,/@everyone/);
  assert.doesNotMatch(sent.embeds[0].fields.map(f=>f.name).join(" "),/ORDERS PLACED|CANCELLED|STICK RATE/);
  assert.equal(h.scans.length,2,"review and publication both verify source independently");
  assert.match(h.lastPatch().content,/posted to #general/);
});
test("approved image is privately previewed, updated on toggles, and attached on confirmation",async t=>{
  const h=await harness(t,{graphic:true});
  const initial=await h.start("target");
  assert.equal(initial.embeds[0].title,"PRIVATE RECAP GRAPHIC PREVIEW");
  assert.equal(h.posts().length,0);
  const id=initial.components[0].components[0].custom_id.split(":").at(-1);
  await h.flow.handleInteraction(interaction("sngdrop:manual:toggle:stick:"+id));
  const updated=h.lastPatch();
  assert.equal(updated.embeds[0].title,"PRIVATE RECAP GRAPHIC PREVIEW");
  assert.equal(h.posts().length,0);
  await h.flow.handleInteraction(interaction("sngdrop:manual:publish:"+id));
  assert.equal(h.posts().length,1);
  assert.equal(h.scans.length,2);
  assert.equal(h.posts()[0].payload.allowed_mentions.parse.length,0);
  assert.doesNotMatch(h.posts()[0].payload.embeds[0].fields.map(f=>f.name).join(" "),/STICK RATE/);
});
test("missing approved image fails closed before manual publish",async t=>{
  const h=await harness(t,{graphic:true,failGraphic:true});
  const response=await h.start("target");
  assert.match(response.content,/blocked until source verification/);
  assert.match(response.content,/approved_recap_graphic_unavailable/);
  assert.equal(h.posts().length,0);
});
test("all-retailer manual preview is supported",async t=>{
  const h=await harness(t);
  const preview=await h.start("all");
  assert.match(preview.embeds[0].title,/All Retailers/);
  assert.equal(h.reports[0].options.retailer,"All");
});
test("unverified Success data blocks manual publication, and no guessing",async t=>{
  const h=await harness(t,{ready:false});
  const preview=await h.start();
  assert.match(preview.content,/blocked until source verification/);
  assert.match(preview.content,/missing_source_unit_prices/);
  assert.equal(preview.components[0].components[0].label,"Close");
  assert.equal(h.posts().length,0);
});
test("invalid and future periods get private errors; nothing is public",async t=>{
  const h=await harness(t);
  const d=form();
  d.data.components[0].components[0].value="2026-11-30";
  await h.flow.handleInteraction(d);
  assert.match(h.lastPatch().content,/must already have passed/);
  assert.equal(h.posts().length,0);
});
test("unauthorized user cannot open or publish a manual recap",async t=>{
  const h=await harness(t);
  await h.flow.handleInteraction({...interaction("sngdrop:manual:open"),
    member:{user:{id:"1688888888888888888"}}});
  assert.match(h.lastReply().data.content,/Only the verified owner/);
  assert.equal(h.posts().length,0);
});
test("manual posts prevent a duplicate retailer/time window, even across sessions",async t=>{
  const h=await harness(t);
  const preview1=await h.start();
  const id1=preview1.components[0].components[0].custom_id.split(":").at(-1);
  await h.flow.handleInteraction(interaction("sngdrop:manual:publish:"+id1));
  assert.equal(h.posts().length,1);
  const preview2=await h.start();
  const id2=preview2.components[0].components[0].custom_id.split(":").at(-1);
  await h.flow.handleInteraction(interaction("sngdrop:manual:publish:"+id2));
  assert.equal(h.posts().length,1);
  assert.match(h.lastPatch().content,/Duplicate posting was prevented/);
});
test("ambiguous Discord send failure never triggers automatic duplicate",async t=>{
  const h=await harness(t,{failPublish:true});
  const preview=await h.start();
  const id=preview.components[0].components[0].custom_id.split(":").at(-1);
  await h.flow.handleInteraction(interaction("sngdrop:manual:publish:"+id));
  assert.equal(h.posts().length,1);
  assert.match(h.lastPatch().content,/could not be confirmed/);
  const file=JSON.parse(await fs.readFile(path.join(h.dir,"discord-manual-recaps.json"),"utf8"));
  assert.equal(file.posts[0].status,"delivery_unconfirmed");
});
test("existing scheduled drop controller delegates the manual button to its flow",async t=>{
  const h=await harness(t);
  const c=createDiscordDropRecapController({
    dataDir:h.dir,api:h.args.api,token:"dummy",
    guildId:GUILD,ownerId:OWNER,generalChannelId:GENERAL,controlChannelId:CHANNEL,
    getSource:h.args.getSource,makeReport:h.args.makeReport,now:()=>CLOCK
  });
  await c.handleInteraction(interaction("sngdrop:manual:open"));
  assert.match(h.lastReply().data.content,/Create manual Discord recap/);
});
