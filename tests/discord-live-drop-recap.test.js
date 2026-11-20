import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DROP_RECAP_DELAY_MS,DROP_RECAP_RETAILERS,dropControlRows,
  buildDropAnnouncement,buildDropRecapPost,parseDiscordSuccessForRecap,
  createDiscordDropRecapController,buildTypedDropRecapPreview,handleTypedDropRecapPreview
} from "../discord-live-drop-recap.js";
import {SLABSNGRABSTC_SUCCESS_CHANNEL_ID} from "../discord-source-price-field-policy.js";

const GUILD="803097107660931082",GENERAL="1532179373292257291",
  CONTROL="1532179373292257292",OWNER="1532179373292257293";
const startAt=Date.parse("2026-11-14T19:00:00.000Z");
const verified={
  readyToPublish:true,periodStart:new Date(startAt).toISOString(),
  totalSpentCents:3273,totalUnits:1,ordersPlaced:1,
  deduplicatedCancelledOrders:0,
  topProducts:[{name:"Pokemon 30th Celebration Tin",quantity:1,
    imageUrl:"https://target.scene7.com/is/image/Target/GUEST-test"}]
};
function responseBody(fields){
  return {id:"1611111111111111111",webhook_id:"1511111111111111111",
    timestamp:new Date(startAt).toISOString(),
    embeds:[{color:0x00cc66,
      thumbnail:{url:"https://target.scene7.com/is/image/Target/GUEST-test"},
      fields}]};
}
function sourceFields(order="TGT123456"){
  return [{name:"Site",value:"Target"},
    {name:"Product",value:"Pokemon 30th Celebration Tin"},
    {name:"Order ID",value:order},
    {name:"Quantity",value:"2"},
    {name:"Price",value:"$49.98"}];
}
async function harness(t,{complete=true}={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"sng-drop-recap-"));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  let time=startAt,n=1611111111111111000n;
  const requests=[],scan=[];
  const api=async (url,method="GET",payload)=>{
    requests.push({url,method,payload});
    if(method==="POST"&&url.includes("/messages")&&!url.includes("/webhooks/")){
      return {id:String(n++),embeds:payload?.embeds||[]};
    }
    if(method==="GET"&&url.startsWith("/channels/")&&url.includes("/messages?"))
      return [];
    if(method==="POST"&&url.startsWith("/interactions/"))return {ok:true};
    if(method==="PATCH"&&url.startsWith("/webhooks/"))return {ok:true};
    throw Error("Unexpected mock REST route "+method+" "+url);
  };
  const controller=createDiscordDropRecapController({
    dataDir,api,token:"dummy-test-token",guildId:GUILD,
    ownerId:OWNER,generalChannelId:GENERAL,controlChannelId:CONTROL,
    now:()=>time,
    getSource:async(_token,start,end)=>{
      scan.push({start,end});return {messages:[],historyComplete:true};
    },
    makeReport:()=>complete?verified:{
      ...verified,readyToPublish:false,totalSpentCents:null,
      blockedReasons:["missing_source_unit_prices_for_rule_total"]
    }
  });
  return {controller,requests,scan,at:x=>{time=x;},dataDir};
}
const publicPosts=h=>h.requests.filter(x=>
  x.url==="/channels/"+GENERAL+"/messages"&&x.method==="POST");

test("drop buttons cover five retailers and show private status without public action",()=>{
  const ids=dropControlRows().flatMap(row=>row.components.map(b=>b.custom_id));
  assert.deepEqual(ids.slice(0,5),Object.keys(DROP_RECAP_RETAILERS).map(x=>"sngdrop:start:"+x));
  assert.ok(ids.includes("sngdrop:status"));
  assert.equal(DROP_RECAP_DELAY_MS,12*60*60*1000);
});

test("public live announcement goes to @everyone only after owner confirmation",async t=>{
  const h=await harness(t);
  const data={member:{user:{id:OWNER}},channel_id:CONTROL,type:3,
    id:"1611111111111111320",token:"mock-interaction",
    application_id:"1611111111111111321",
    data:{custom_id:"sngdrop:start:target"}};
  await h.controller.handleInteraction(data);
  assert.equal(publicPosts(h).length,0);
  const prompt=h.requests.find(r=>r.url.includes("/interactions/"));
  assert.equal(prompt.payload.data.flags,64);
  assert.match(prompt.payload.data.content,/12 hours/i);
  await h.controller.handleInteraction({...data,data:{custom_id:"sngdrop:confirm:target"}});
  assert.equal(publicPosts(h).length,1);
  const post=publicPosts(h)[0].payload;
  assert.match(post.content,/DROP IS LIVE/);
  assert.equal(post.allowed_mentions.parse[0],"everyone");
  assert.match(post.embeds[0].description,/12 hours/);
  assert.equal((await h.controller.statusText()).includes("recap scheduled"),true);
});

test("verified owner can confirm through a private Discord DM fallback",async t=>{
  const h=await harness(t);
  const msg={
    type:3,id:"1611111111111111555",token:"dm-token",
    user:{id:OWNER},channel_id:CONTROL,
    application_id:"1611111111111111441",
    data:{custom_id:"sngdrop:confirm:target"}
  };
  await h.controller.handleInteraction(msg);
  assert.equal(publicPosts(h).length,1);
  assert.ok(h.requests.some(x=>x.url.includes("/webhooks/")));
});

test("owner gate rejects arbitrary members without public messages",async t=>{
  const h=await harness(t);
  await h.controller.handleInteraction({
    type:3,id:"1611111111111111333",token:"x",
    member:{user:{id:"1611111111111111444"}},
    channel_id:CONTROL,data:{custom_id:"sngdrop:confirm:target"}
  });
  assert.equal(publicPosts(h).length,0);
  assert.equal(h.requests[0].payload.data.flags,64);
});

test("one active retailer drop cannot be started twice",async t=>{
  const h=await harness(t);
  await h.controller.startRetailer("target");
  await assert.rejects(h.controller.startRetailer("target"),/still open/);
  assert.equal(publicPosts(h).length,1);
});

test("exact twelve-hour schedule posts only source-verified recap",async t=>{
  const h=await harness(t);
  await h.controller.startRetailer("target");
  h.at(startAt+DROP_RECAP_DELAY_MS-1);
  await h.controller.dueRecaps();
  assert.equal(publicPosts(h).length,1);
  h.at(startAt+DROP_RECAP_DELAY_MS);
  await h.controller.dueRecaps();
  assert.equal(publicPosts(h).length,2);
  assert.equal(h.scan.length,1);
  const post=publicPosts(h)[1].payload;
  assert.match(post.content,/DROP RECAP/);
  assert.match(post.embeds[0].fields[0].value,/\$32\.73/);
  assert.match(post.embeds[0].fields.find(x=>x.name==="TOP PRODUCTS").value,/Celebration Tin/);
  assert.equal(post.embeds[0].thumbnail.url,verified.topProducts[0].imageUrl);
  await h.controller.dueRecaps();
  assert.equal(publicPosts(h).length,2);
});

test("missing evidence holds recap privately; never invents totals",async t=>{
  const h=await harness(t,{complete:false});
  await h.controller.startRetailer("target");
  h.at(startAt+DROP_RECAP_DELAY_MS);
  await h.controller.dueRecaps();
  assert.equal(publicPosts(h).length,1);
  assert.match(await h.controller.statusText(),/verification pending/);
  const alerts=h.requests.filter(r=>r.url==="/channels/"+CONTROL+"/messages");
  assert.equal(alerts.length,1);
  assert.match(alerts[0].payload.content,/held for verification/);
});

test("source-only parser extracts quantities and line totals without order PII in report",()=>{
  const data=responseBody(sourceFields());
  const parsed=parseDiscordSuccessForRecap(data);
  assert.equal(parsed.orderNumber,"TGT123456");
  assert.equal(parsed.items.length,1);
  assert.equal(parsed.items[0].price,24.99);
  assert.equal(parsed.items[0].quantity,2);
  assert.equal(parsed.items[0].imageUrl,"https://target.scene7.com/is/image/Target/GUEST-test");
  assert.equal(parseDiscordSuccessForRecap(data,"wrong-channel"),null);
  assert.equal(parseDiscordSuccessForRecap({...data,webhook_id:null}),null);
});

test("recap parser reads explicitly labeled prices and quantities from original embed description",()=>{
  const message=responseBody([{name:"Site",value:"Target"},{name:"Order ID",value:"TGT001234"}]);
  message.embeds[0].description="[Pokemon 30th Celebration Tin](https://www.target.com/p/tin)\nQty: 2\nPrice: **$49.98**";
  const parsed=parseDiscordSuccessForRecap(message);
  assert.equal(parsed.items.length,1);
  assert.equal(parsed.items[0].quantity,2);
  assert.equal(parsed.items[0].price,24.99);
  assert.equal(parsed.orderNumber,"TGT001234");
});
test("recap parser preserves exact line vs unit pricing and currency thousands separators",()=>{
  const msg=responseBody([{name:"Site",value:"Target"},{name:"Order ID",value:"TGT001235"},
    {name:"Quantity",value:"2"},{name:"Line Total",value:"$1,299.98"}]);
  msg.embeds[0].description="[Pokemon Special Item](https://www.target.com/p/special)";
  assert.equal(parseDiscordSuccessForRecap(msg).items[0].price,649.99);
  msg.embeds[0].fields.pop();
  msg.embeds[0].fields.push({name:"Unit Price",value:"$24.99"});
  assert.equal(parseDiscordSuccessForRecap(msg).items[0].price,24.99);
});
test("conflicting source prices remain unknown, never inferred",()=>{
  const msg=responseBody([{name:"Site",value:"Target"},{name:"Order ID",value:"TGT001236"},
    {name:"Quantity",value:"1"},{name:"Price",value:"$19.99"},{name:"Price",value:"$29.99"}]);
  msg.embeds[0].description="[Pokemon Special Item](https://www.target.com/p/special)";
  assert.equal(parseDiscordSuccessForRecap(msg).items[0].price,null);
});

test("unverified spend cannot be published in public recap",()=>{
  assert.throws(()=>buildDropRecapPost("target","test",
    {...verified,readyToPublish:false}),/Unverified/);
  assert.throws(()=>buildDropRecapPost("target","test",
    {...verified,totalSpentCents:null}),/Unverified/);
  const valid=buildDropRecapPost("target","test",verified);
  assert.ok(!JSON.stringify(valid).includes("TGT123456"));
  assert.equal(valid.allowed_mentions.parse[0],"everyone");
});

test("stick rate equals retained placed orders and handles complete cancellation",()=>{
  const result=buildDropRecapPost("target","example",{
    ...verified,ordersPlaced:132,deduplicatedCancelledOrders:56
  });
  const stick=result.embeds[0].fields.find(f=>f.name.includes("STICK RATE"));
  assert.equal(stick.value,"**57.6%**");
  const none=buildDropRecapPost("target","example",{
    ...verified,ordersPlaced:5,deduplicatedCancelledOrders:5
  });
  assert.equal(none.embeds[0].fields.find(f=>f.name.includes("STICK RATE")).value,"**0.0%**");
  const empty=buildDropRecapPost("target","example",{
    ...verified,ordersPlaced:0,deduplicatedCancelledOrders:0
  });
  assert.equal(empty.embeds[0].fields.find(f=>f.name.includes("STICK RATE")).value,"**0.0%**");
});

test("source parser supports multiple independent product embeds",()=>{
  const one=responseBody(sourceFields());
  one.embeds.push({color:0x00cc66,fields:[
    {name:"Site",value:"Target"},
    {name:"Product",value:"Pokemon 30th Celebration Booster"},
    {name:"Quantity",value:"1"},
    {name:"Unit Price",value:"$9.99"}
  ]});
  const parsed=parseDiscordSuccessForRecap(one);
  assert.equal(parsed.items.length,2);
  assert.equal(parsed.items.reduce((n,i)=>n+i.quantity,0),3);
});

test("legacy recaps from a different Discord general channel cannot post in the member server",async t=>{
  const h=await harness(t);
  const oldGeneral="1570500003850354729";
  await fs.writeFile(path.join(h.dataDir,"discord-live-drop-recaps.json"),JSON.stringify({
    drops:[{id:"legacy-tcg-post",retailer:"target",
      startedAt:new Date(startAt-13*3600000).toISOString(),
      dueAt:new Date(startAt-3600000).toISOString(),
      status:"scheduled",generalChannelId:oldGeneral}]
  }));
  await h.controller.dueRecaps();
  assert.equal(publicPosts(h).length,0);
  assert.equal(h.scan.length,0);
  assert.match(await h.controller.statusText(),/No drops started/);
  await h.controller.startRetailer("target");
  assert.equal(publicPosts(h).length,1);
});

test("plain 'Drop recap 11/13' renders a blue Discord box without mentions or totals",()=>{
  const preview=buildTypedDropRecapPreview("Drop recap 11/13");
  assert.deepEqual(preview.allowed_mentions,{parse:[]});
  assert.equal(preview.embeds.length,1);
  assert.equal(preview.embeds[0].color,0x3498db);
  assert.equal(preview.embeds[0].description,["```ini","[Drop recap 11/13]","```"].join(String.fromCharCode(10)));
  assert.equal(preview.content,undefined);
  assert.ok(!JSON.stringify(preview).includes("@everyone"));
  assert.ok(buildTypedDropRecapPreview(" drop  recap  3/9 ").embeds[0].description.includes("[Drop recap 3/9]"));
  assert.equal(buildTypedDropRecapPreview("Drop recap 0/13"),null);
  assert.equal(buildTypedDropRecapPreview("Drop recap 13/13"),null);
  assert.equal(buildTypedDropRecapPreview("Drop recap 11/31"),null);
  assert.equal(buildTypedDropRecapPreview("Drop recap 11/13 publish now"),null);
  assert.equal(buildTypedDropRecapPreview("random channel message"),null);
});

test("typed recap works only for the verified owner and does not schedule a real drop",async()=>{
  const calls=[],seen=new Set();
  const message={id:"1611111111111111960",guild_id:GUILD,channel_id:GENERAL,
    author:{id:OWNER},type:0,content:"Drop recap 11/13"};
  const api=async(url,method,payload)=>{calls.push({url,method,payload});return {id:"1911111111111111111"};};
  const run=msg=>handleTypedDropRecapPreview({
    message:msg,ownerId:OWNER,guildId:GUILD,api,seenMessageIds:seen
  });
  assert.equal(await run(message),true);
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(x=>x.method),["POST","DELETE"]);
  assert.equal(calls[0].url,"/channels/"+GENERAL+"/messages");
  assert.equal(calls[0].payload.embeds[0].color,0x3498db);
  assert.deepEqual(calls[0].payload.allowed_mentions,{parse:[]});
  assert.equal(await run(message),false,"replayed gateway event must not duplicate preview");
  assert.equal(await run({...message,id:"1611111111111111961",author:{id:"wrong-user"}}),false);
  assert.equal(await run({...message,id:"1611111111111111962",guild_id:"wrong-guild"}),false);
  assert.equal(await run({...message,id:"1611111111111111963",author:{id:OWNER,bot:true}}),false);
  assert.equal(await run({...message,id:"1611111111111111964",webhook_id:"webhook"}),false);
  assert.equal(await run({...message,id:"1611111111111111965",content:"DROP IS LIVE"}),false);
  assert.equal(calls.length,2,"unrelated events must never post or delete");
});

test("typed preview remains posted if original cannot be deleted; failed posts may retry",async()=>{
  const message={id:"1611111111111111966",guild_id:GUILD,channel_id:CONTROL,
    author:{id:OWNER},content:"drop recap 11/13"};
  const seen=new Set(),calls=[];
  let failPost=true;
  const api=async(url,method,payload)=>{
    calls.push({url,method,payload});
    if(method==="POST"&&failPost)throw Error("post failed");
    if(method==="DELETE")throw Error("missing Manage Messages permission");
    return {id:"1611111111111111967"};
  };
  const opts={message,ownerId:OWNER,guildId:GUILD,api,seenMessageIds:seen};
  await assert.rejects(handleTypedDropRecapPreview(opts),/post failed/);
  assert.equal(seen.size,0);
  failPost=false;
  assert.equal(await handleTypedDropRecapPreview(opts),true);
  assert.equal(calls.filter(x=>x.method==="POST").length,2);
  assert.equal(calls.filter(x=>x.method==="DELETE").length,1);
});
