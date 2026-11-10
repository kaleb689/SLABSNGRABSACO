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

test("successful monitor paste cleanup removes only the raw source after posting the selectable product card",async()=>{
  const source=readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
  const start=source.indexOf("  async function onDropPost(d) {");
  const snippet=source.slice(start,source.indexOf("\n  async function ",start+10));
  const calls=[];
  const context={guildId:"guild",ownerId:"owner",appId:"bot",dropChannelIds:new Set(["drop"]),retailerDropLabels:{drop:"Target"},
    inStoreChannelId:"instore",dropChannelLabel:()=>"Target",
    isNewDropPost:()=>true,parseMonitorDropProducts:()=>[{name:"Box",sku:"12345"}],
    parseDropSkus:()=>[],recordTargetMasterPost:async()=>[],
    formattedDropPayloads:()=>[{content:"formatted",embeds:[]}],
    api:async(path,method)=>{calls.push(method);return {id:"formatted"};},
    ensureSkuControls:async()=>{},notifyRetailerSkuChange:async()=>{},notifyUpcomingRetailerAnnouncement:async()=>{},console};
  vm.createContext(context);vm.runInContext(snippet,context);
  await context.onDropPost({guild_id:"guild",channel_id:"drop",id:"new",author:{id:"staff"}});
  assert.deepEqual(calls,[]);
  await context.onDropPost({guild_id:"guild",channel_id:"drop",id:"paste",author:{id:"owner"}});
  assert.deepEqual(calls,["POST","DELETE"]);
});

test("In-Store Drops posts are formatted for viewing only, with no SKU picker", async () => {
  const source = readFileSync(new URL("../discord-community.js", import.meta.url), "utf8");
  const start = source.indexOf("  async function onInStorePost(d) {");
  const end = source.indexOf("\n  async function onDropPost(d) {", start);
  const snippet = source.slice(start, source.indexOf("\n  async function ", end + 10));
  const { parseDropNews, dropNewsPayloads } = await import("../drop-news-format.js");
  const { parseDropSkus } = await import("../discord-community.js");
  const calls = [], controls = [];
  const context = { guildId: "guild", ownerId: "owner", inStoreChannelId: "instore", inStoreRoleId: "role123",
    dropChannelIds: new Set(["drop"]), isNewDropPost: () => true, parseDropNews, dropNewsPayloads, parseDropSkus,
    api: async (path, method, body) => { calls.push([method, path, body?.embeds?.[0]?.title, body]); return { id: "card" }; },
    ensureSkuControls: async () => controls.push(1), console,
    waitForLinkPreviews: async message => message,
    postDropImages: async () => { calls.push(["IMAGES"]); return { id: "pics" }; } };
  vm.createContext(context); vm.runInContext(snippet, context);
  const content = "Nov 6\nTarget only\n\nUltra Premium Collection Day\nSKU: 1012850570\nRetail: $249.99";
  await context.onDropPost({ guild_id: "guild", channel_id: "instore", id: "raw", author: { id: "owner" }, content });
  assert.deepEqual(calls.map(c => c[0]), ["POST", "IMAGES", "DELETE"], "card, then picture grid, then raw paste removed");
  assert.equal(calls[0][2], "In-Store Drop · Target");
  assert.equal(controls.length, 0, "no SKU selection controls in In-Store Drops");
  assert.equal(calls[0][3].content, "<@&role123>", "pings the In-Store Drop Alerts role");
  assert.equal(JSON.stringify(calls[0][3].allowed_mentions), JSON.stringify({ parse: [], roles: ["role123"] }));
  calls.length = 0;
  await context.onDropPost({ guild_id: "guild", channel_id: "instore", id: "chat", author: { id: "staff" }, content });
  assert.deepEqual(calls, [], "only the owner's pastes are reformatted");
});
