import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {readFileSync} from "node:fs";
import {createCustomerMessageBridge,cleanSupportText,resolveOwnerSupportReply} from "../customer-messages.js";

const guildId="333333333333333333",channelId="444444444444444444";
const ownerId="555555555555555555",botId="666666666666666666";
const A={id:"customer-a",name:"Customer A",discordLinkedAt:"2026-11-15T00:00:00Z",discordUserId:"111111111111111111"};
const B={id:"customer-b",name:"Customer B",discordLinkedAt:"2026-11-15T00:00:00Z",discordUserId:"222222222222222222"};
const UNLINKED={id:"customer-c",name:"Customer C"};
const config={guildId,channelId,ownerId,botId};
const msg=(id,content,extra={})=>({id,channel_id:channelId,guild_id:guildId,
  author:{id:ownerId,bot:false},content,mentions:[],...extra});
const ref=id=>({message_reference:{message_id:id}});
function fixture(t) {
  const dataDir=path.join(os.tmpdir(),"sng-messages-"+crypto.randomUUID());
  const sent=[],notifications=[];
  let next=900000000000000001n,current=Date.parse("2026-11-15T20:00:00Z");
  const bridge=createCustomerMessageBridge({dataDir,
    getAccounts:async()=>[A,B,UNLINKED],
    now:()=>current,
    postDiscordMessage:async(channel,payload)=>{
      sent.push({channel,payload});return {id:String(next++)};
    },
    notifyReply:async args=>{notifications.push(args);}
  });
  bridge.configure(config);
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  return {bridge,sent,notifications,dataDir,
    advance:millis=>{current+=millis;}};
}

test("signed-in account identity and history are isolated and content cannot ping the guild",async t=>{
  const f=fixture(t);
  const id=crypto.randomUUID();
  await f.bridge.send(A,{text:"I need help with my Target accounts.",requestId:id});
  f.advance(3500);
  await f.bridge.send(B,{text:"Please check my subscription.",requestId:crypto.randomUUID()});
  const a=await f.bridge.list(A.id),b=await f.bridge.list(B.id);
  assert.deepEqual(a.messages.map(m=>m.text),["I need help with my Target accounts."]);
  assert.deepEqual(b.messages.map(m=>m.text),["Please check my subscription."]);
  assert.equal(a.ready,true);
  assert.equal(f.sent[0].channel,channelId);
  assert.deepEqual(f.sent[0].payload.allowed_mentions,{parse:[],users:[ownerId]});
  assert.match(f.sent[0].payload.content,/<@555555555555555555>/);
  assert.match(f.sent[0].payload.content,/Customer A/);
  assert.match(f.sent[0].payload.content,/<@111111111111111111>/);
  assert.equal((await f.bridge.send(A,{text:"same send",requestId:id})).duplicate,true);
  assert.equal(f.sent.length,2,"idempotent retry cannot post twice");
});

test("owner @mentions one linked member and notification goes to only that account",async t=>{
  const f=fixture(t);
  await f.bridge.send(A,{text:"Hi support",requestId:crypto.randomUUID()});
  const response=msg("777777777777777777","<@111111111111111111> Your profiles are ready");
  assert.equal(await f.bridge.onDiscordMessage(response),true);
  assert.equal(f.notifications.length,1);
  assert.equal(f.notifications[0].accountId,A.id);
  assert.equal(f.notifications[0].text,"Your profiles are ready");
  assert.equal((await f.bridge.list(A.id)).unread,1);
  assert.equal((await f.bridge.list(B.id)).messages.length,0);
  assert.deepEqual((await f.bridge.list(A.id)).messages.map(m=>m.role),["customer","owner"]);
  await f.bridge.markRead(A.id);
  assert.equal((await f.bridge.list(A.id)).unread,0);
  await f.bridge.onDiscordMessage(response);
  assert.equal((await f.bridge.list(A.id)).messages.length,2,"Discord replay cannot duplicate reply");
});

test("native Discord Reply works for an unlinked member even when Discord implicitly mentions the bot",async t=>{
  const f=fixture(t);
  await f.bridge.send(UNLINKED,{text:"I haven't connected Discord",requestId:crypto.randomUUID()});
  const postedId=f.sent[0].payload&&"900000000000000001";
  const response=msg("777777777777777778","Thanks. We can still help.",{
    message_reference:{message_id:postedId},mentions:[{id:botId}]});
  assert.equal(await f.bridge.onDiscordMessage(response),true);
  assert.equal(f.notifications[0].accountId,UNLINKED.id);
  assert.equal((await f.bridge.list(UNLINKED.id)).messages[1].role,"owner");
});

test("no client can leak cross-account replies with conflicting mentions or fake author",async t=>{
  const f=fixture(t);
  await f.bridge.send(A,{text:"A request",requestId:crypto.randomUUID()});
  const postedId="900000000000000001";
  const wrong=msg("777777777777777779","<@222222222222222222> Wrong recipient",ref(postedId));
  await f.bridge.onDiscordMessage(wrong);
  await f.bridge.onDiscordMessage(msg("777777777777777780",
    "<@111111111111111111> <@222222222222222222> Group reply"));
  await f.bridge.onDiscordMessage(msg("777777777777777781",
    "<@111111111111111111> Not from owner",{author:{id:"888888888888888888",bot:false}}));
  await f.bridge.onDiscordMessage({...msg("777777777777777782",
    "<@111111111111111111> Wrong channel"),channel_id:"999999999999999999"});
  await f.bridge.onDiscordMessage(msg("777777777777777783",
    "<@111111111111111111> Bot post",{author:{id:botId,bot:true}}));
  assert.equal(f.notifications.length,0);
  assert.equal((await f.bridge.list(A.id)).messages.length,1);
  assert.equal((await f.bridge.list(B.id)).messages.length,0);
});

test("customer messages persist after service restart and older ticket can still be replied to",async t=>{
  const f=fixture(t);
  await f.bridge.send(A,{text:"Question before restart",requestId:crypto.randomUUID()});
  const resumed=createCustomerMessageBridge({dataDir:f.dataDir,getAccounts:async()=>[A,B],
    postDiscordMessage:async()=>{throw Error("unexpected send");},
    notifyReply:async data=>f.notifications.push(data)});
  resumed.configure(config);
  assert.equal((await resumed.list(A.id)).messages.length,1);
  assert.equal(await resumed.onDiscordMessage(msg("777777777777777784",
    "Response after restart",ref("900000000000000001"))),true);
  assert.equal((await resumed.list(A.id)).messages[1].text,"Response after restart");
  assert.equal(f.notifications.length,1);
});

test("reject oversized, empty and rapid or excessive sends",async t=>{
  const f=fixture(t);
  assert.throws(()=>cleanSupportText(" "),/1 to 1400/);
  assert.throws(()=>cleanSupportText("x".repeat(1401)),/1400/);
  await assert.rejects(f.bridge.send(A,{text:"Hi",requestId:"forged"}),/Invalid message request/);
  await f.bridge.send(A,{text:"Hello",requestId:crypto.randomUUID()});
  await assert.rejects(f.bridge.send(A,{text:"Too fast",requestId:crypto.randomUUID()}),/Wait a few seconds/);
  for(let i=0;i<19;i++){f.advance(3100);await f.bridge.send(A,
    {text:"Message "+i,requestId:crypto.randomUUID()});}
  f.advance(3100);
  await assert.rejects(f.bridge.send(A,{text:"Message 21",requestId:crypto.randomUUID()}),/hourly/);
});

test("PWA Messages button, private Discord channel permissions, and push click route are wired",()=>{
  const server=readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const bot=readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const pwa=readFileSync(new URL("../public/pwa.js",import.meta.url),"utf8");
  const worker=readFileSync(new URL("../public/sw.js",import.meta.url),"utf8");
  const ui=readFileSync(new URL("../public/customer-messages-ui.js",import.meta.url),"utf8");
  const notif=readFileSync(new URL("../order-notifications.js",import.meta.url),"utf8");
  assert.match(server,/registerCustomerMessages\(app/);
  assert.match(server,/onAppMessageChannelReady: metadata/);
  assert.match(server,/onAppSupportReply: message/);
  assert.match(bot,/name:"app-messages"/);
  assert.match(bot,/onAppSupportReply\(packet\.d\)/);
  assert.match(bot,/ownerMessagesOverwrites/);
  assert.match(bot,/appMessagesReady=true/);
  assert.match(html,/data-account-tab="messages"/);
  assert.match(html,/data-account-panel="messages"/);
  assert.match(pwa,/\["Messages", "messages"/);
  assert.match(worker,/"messages"\]\.includes\(payload.tab\)/);
  assert.match(ui,/text\.textContent=String\(item\.text/);
  assert.match(notif,/notifyCustomerReply: \(accountId, discordMessageId\)/);
});
