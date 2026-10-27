import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import {createDropMessageRetention,dropMessageExpired,DROP_MESSAGE_RETENTION_MS as TTL} from "../discord-drop-retention.js";
const now=Date.parse("2026-10-26T23:00:00Z");
const message=(id,age,extra={})=>({id,type:0,timestamp:new Date(now-age).toISOString(),...extra});

test("expiry is ten days from original posting, not latest edits or newer messages",()=>{
  assert.equal(dropMessageExpired(message("old",TTL),now),true);
  assert.equal(dropMessageExpired(message("recent",TTL-1,{edited_timestamp:new Date(now-TTL*2).toISOString()}),now),false);
  assert.equal(dropMessageExpired(message("edited",TTL+1,{edited_timestamp:new Date(now).toISOString()}),now),true);
  assert.equal(dropMessageExpired(message("pinned",TTL*2,{pinned:true}),now),false);
  assert.equal(dropMessageExpired(message("system",TTL*2,{type:7}),now),false);
  const snowflake=String((BigInt(now-TTL-1420070400000)<<22n));
  assert.equal(dropMessageExpired({id:snowflake,type:19},now),true);
  assert.equal(dropMessageExpired({id:"invalid",timestamp:"bad"},now),false);
});

test("sweeper only deletes aged messages in drop channels and preserves recent posts and pinned instructions",async()=>{
  const calls=[],retired=[];
  const cleanup=createDropMessageRetention({now:()=>now,getChannelIds:()=>new Set(["target-drops"]),
    api:async(path,method)=>{calls.push({path,method});return method==="DELETE"?{}:[
      message("recent",1000),message("old-user",TTL),
      message("old-bot",TTL+1,{author:{bot:true}}),message("old-webhook",TTL+2,{webhook_id:"hook"}),
      message("pinned",TTL*2,{pinned:true})];},
    onDeleted:async(channel,ids)=>retired.push([channel,[...ids]])});
  await cleanup();
  assert.deepEqual(calls.filter(x=>x.method==="DELETE").map(x=>x.path),[
    "/channels/target-drops/messages/old-user","/channels/target-drops/messages/old-bot","/channels/target-drops/messages/old-webhook"]);
  assert.deepEqual(retired,[["target-drops",["old-user","old-bot","old-webhook"]]]);
  assert.ok(calls.every(x=>x.path.startsWith("/channels/target-drops/")));
});

test("backlog pagination resumes on the next sweep instead of starving old messages",async()=>{
  const pages=[];let deletes=0;
  const cleanup=createDropMessageRetention({now:()=>now,maxPages:1,getChannelIds:()=>["drop"],
    api:async(path,method)=>{if(method==="DELETE"){deletes++;return {};}
      pages.push(path);return path.includes("before=")?[message("expired",TTL)]:
        Array.from({length:100},(_,i)=>message(String(1000-i),1000));}});
  await cleanup();assert.equal(deletes,0);
  await cleanup();assert.equal(deletes,1);assert.match(pages[1],/before=901$/);
  await cleanup();assert.doesNotMatch(pages[2],/before=/);
});

test("one channel error does not erase unconfirmed data or block other channels",async()=>{
  const retired=[],errors=[];
  const cleanup=createDropMessageRetention({now:()=>now,getChannelIds:()=>["bad","good"],
    onError:(error,channel)=>errors.push(channel),onDeleted:async(channel,ids)=>retired.push([channel,[...ids]]),
    api:async(path,method)=>{if(path.includes("/bad/"))throw Error("HTTP 403");
      if(method==="DELETE")throw Error("HTTP 404");return [message("already-removed",TTL)];}});
  await cleanup();assert.deepEqual(errors,["bad"]);assert.deepEqual(retired,[["good",["already-removed"]]]);
});

test("posting another drop or formatted monitor report does not delete earlier messages or the source",async()=>{
  const source=readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
  const start=source.indexOf("  async function onDropPost(d) {");
  const snippet=source.slice(start,source.indexOf("\n  async function ",start+10));
  const calls=[];
  const context={guildId:"guild",ownerId:"owner",appId:"bot",dropChannelIds:new Set(["drop"]),retailerDropLabels:{drop:"Target"},
    isNewDropPost:()=>true,parseMonitorDropProducts:()=>[{name:"Box",sku:"12345"}],
    formattedDropPayloads:()=>[{content:"formatted",embeds:[]}],
    api:async(path,method)=>{calls.push(method);return {id:"formatted"};},
    ensureSkuControls:async()=>{},notifyRetailerSkuChange:async()=>{},notifyUpcomingRetailerAnnouncement:async()=>{},console};
  vm.createContext(context);vm.runInContext(snippet,context);
  await context.onDropPost({guild_id:"guild",channel_id:"drop",id:"new",author:{id:"staff"}});
  assert.deepEqual(calls,[]);
  await context.onDropPost({guild_id:"guild",channel_id:"drop",id:"paste",author:{id:"owner"}});
  assert.deepEqual(calls,["POST"]);
});
