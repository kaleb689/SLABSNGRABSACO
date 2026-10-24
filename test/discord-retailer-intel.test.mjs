import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import {readFileSync} from "node:fs";
import {
 normalizeRetailerIntel, retailerIntelPayload, createRetailerIntelPublisher,
 INTEL_RETENTION_MS
} from "../discord-retailer-intel.js";

async function setup(){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"sng-intel-"));
 const events=[],deleted=[],channels={
  target:"1000000000000000001",walmart:"1000000000000000002",
  pokemoncenter:"1000000000000000003",costco:"1000000000000000004",
  sams:"1000000000000000005",announcements:"1000000000000000006"
 };
 let current=Date.parse("2026-10-24T12:00:00Z"),counter=100;
 const publisher=createRetailerIntelPublisher({dataDir,channels:()=>channels,clock:()=>current,
  send:async(channelId,payload)=>{const id=String(++counter);events.push({action:"POST",channelId,id,payload});return {id};},
  edit:async(channelId,id,payload)=>{events.push({action:"PATCH",channelId,id,payload});return {id};},
  remove:async(channelId,id)=>{deleted.push({channelId,id});return null;}
 });
 return {publisher,events,deleted,channels,advance:days=>current+=days*86400000,close:()=>fs.rm(dataDir,{recursive:true,force:true})};
}

test("retailer item has blue product heading, exact stock fields, and no @mention pings",()=>{
 const data=normalizeRetailerIntel({type:"product",retailer:"Target",name:"30th Celebration Greninja ex Box",
  tcin:"1010892065",price:"$29.99",stock:"2k+",cartLimit:"2",date:"2026-10-24"});
 const embed=retailerIntelPayload(data);
 assert.equal(data.identifier.name,"TCIN");
 assert.equal(embed.embeds[0].title,"30th Celebration Greninja ex Box");
 assert.equal(embed.embeds[0].fields[0].value,"1010892065");
 assert.equal(embed.embeds[0].fields[2].value,"2k+");
 assert.equal(embed.embeds[0].fields[3].value,"2");
 assert.deepEqual(embed.allowed_mentions,{parse:[]});
 assert.equal(typeof embed.embeds[0].color,"number");
});

test("same product across feeds is one message; stock, price and cart limit update original",async t=>{
 const ctx=await setup();t.after(ctx.close);
 const input={type:"product",retailer:"Target",name:"30th Celebration Greninja ex Box",tcin:"1010892065",price:"$29.99",stock:"2k+",cartLimit:"2"};
 const first=await ctx.publisher.ingest(input);
 assert.equal(first.outcome[0].status,"created");
 await ctx.publisher.ingest({...input,date:"2026-10-25"});
 assert.equal(ctx.events.length,1,"repeated product is not reposted");
 const change=await ctx.publisher.ingest({...input,stock:"3k+"});
 assert.equal(change.outcome[0].status,"edited");
 assert.equal(ctx.events.length,2);
 assert.equal(ctx.events[1].id,ctx.events[0].id,"same Discord message ID edited");
 await ctx.publisher.ingest({...input,stock:"3k+",price:"$34.99"});
 assert.equal(ctx.events.length,3);
 await ctx.publisher.ingest({...input,stock:"3k+",price:"$34.99",cartLimit:"1"});
 assert.equal(ctx.events.length,4);
 assert.ok(ctx.events.slice(1).every(e=>e.action==="PATCH"));
});

test("missing new fields never wipe previously verified stock, price or cart limit",async t=>{
 const ctx=await setup();t.after(ctx.close);
 const input={type:"product",retailer:"costco",name:"30th Celebration Bundle",sku:"SKU-1234",price:"$49.99",stock:"10+",cartLimit:"2"};
 await ctx.publisher.ingest(input);
 await ctx.publisher.ingest({type:"product",retailer:"costco",name:input.name,sku:"SKU-1234"});
 assert.equal(ctx.events.length,1);
 await ctx.publisher.ingest({type:"product",retailer:"costco",name:input.name,sku:"SKU-1234",stock:"20+"});
 const fields=ctx.events.at(-1).payload.embeds[0].fields;
 assert.equal(fields[1].value,"$49.99");
 assert.equal(fields[2].value,"20+");
 assert.equal(fields[3].value,"2");
});

test("drop heading can precede product cards without repeating unchanged header",async t=>{
 const ctx=await setup();t.after(ctx.close);
 const head={type:"drop",retailer:"target",date:"2026-10-24",dropTime:"03:00 ET",confirmed:false};
 await ctx.publisher.ingest(head);
 await ctx.publisher.ingest({...head});
 await ctx.publisher.ingest({type:"product",retailer:"target",sku:"T-100",name:"30th Celebration Box"});
 assert.equal(ctx.events.length,2);
 assert.match(ctx.events[0].payload.content,/Possible drop/);
 assert.match(ctx.events[0].payload.content,/2026-10-24/);
 assert.equal(ctx.events[1].payload.embeds[0].title,"30th Celebration Box");
 await ctx.publisher.ingest({...head,dropTime:"04:00 ET"});
 assert.equal(ctx.events.at(-1).action,"PATCH");
});

test("in-store alerts publish one watch per retailer per date",async t=>{
 const ctx=await setup();t.after(ctx.close);
 const input={type:"in_store",retailer:"costco",date:"2026-10-24"};
 await ctx.publisher.ingest(input);await ctx.publisher.ingest(input);
 assert.equal(ctx.events.length,1);
 assert.match(ctx.events[0].payload.content,/Possible in-store stock now or coming soon/i);
 await ctx.publisher.ingest({...input,date:"2026-10-25"});
 assert.equal(ctx.events.length,2);
});

test("queue posts upcoming in announcements and PKC when important, up and down once only in PKC",async t=>{
 const ctx=await setup();t.after(ctx.close);
 const q={type:"queue",retailer:"pkc",date:"2026-10-24",source:"important-restocks"};
 await ctx.publisher.ingest({...q,stage:"upcoming"});
 await ctx.publisher.ingest({...q,stage:"upcoming"});
 await ctx.publisher.ingest({...q,stage:"up"});
 await ctx.publisher.ingest({...q,stage:"up"});
 await ctx.publisher.ingest({...q,stage:"down"});
 await ctx.publisher.ingest({...q,stage:"down"});
 assert.equal(ctx.events.length,4);
 assert.deepEqual(ctx.events.map(x=>x.channelId),[
  ctx.channels.announcements,ctx.channels.pokemoncenter,
  ctx.channels.pokemoncenter,ctx.channels.pokemoncenter]);
 assert.match(ctx.events[1].payload.content,/QUEUE DETECTED \/ UPCOMING/);
 assert.match(ctx.events[2].payload.content,/QUEUE UP/);
 assert.match(ctx.events[3].payload.content,/QUEUE DOWN/);
});

test("Pokemon Center monitoring source does not repost unrelated products; queue upcoming only PKC",async t=>{
 const ctx=await setup();t.after(ctx.close);
 await ctx.publisher.ingest({type:"queue",retailer:"pokemoncenter",source:"pokemon-center",date:"2026-10-24",stage:"upcoming"});
 assert.equal(ctx.events.length,1);
 assert.equal(ctx.events[0].channelId,ctx.channels.pokemoncenter);
});

test("14-day expiration removes tracked bot posts, not unrelated Discord messages",async t=>{
 const ctx=await setup();t.after(ctx.close);
 await ctx.publisher.ingest({type:"product",retailer:"target",name:"Example Tin",sku:"10010"});
 ctx.advance(13);
 assert.equal((await ctx.publisher.expire()).deleted,0);
 ctx.advance(1.1);
 assert.equal((await ctx.publisher.expire()).deleted,1);
 assert.equal(ctx.deleted.length,1);
 assert.equal((await ctx.publisher.expire()).deleted,0);
});

test("identical last four but different full IDs, or same ID under different retailer, stay distinct",async t=>{
 const ctx=await setup();t.after(ctx.close);
 await ctx.publisher.ingest({type:"product",retailer:"target",name:"A",sku:"1234567495"});
 await ctx.publisher.ingest({type:"product",retailer:"target",name:"B",sku:"9876567495"});
 await ctx.publisher.ingest({type:"product",retailer:"walmart",name:"A",sku:"1234567495"});
 assert.equal(ctx.events.length,3);
 assert.notEqual(ctx.events[0].channelId,ctx.events[2].channelId);
});

test("old drop purge-on-new code is gone, 14-day cleanup is scheduled, and private owner gate exists",()=>{
 const code=readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
 assert.doesNotMatch(code,/if \(isNewDropPost\(d\)\) \{\s*try \{\s*const retiredSources/);
 assert.match(code,/cleanupExpiredDropPosts/);
 assert.match(code,/created>=cutoff/);
 assert.match(code,/!ownerId \|\| String\(message.author\?\.id\)!==String\(ownerId\)/);
 assert.match(code,/String\(message.channel_id\)!==String\(adminChannelId\)/);
});


test("SKU and TCIN for the same named product resolve to one card; conflicting TCIN stays separate",async t=>{
 const ctx=await setup();t.after(ctx.close);
 const title="30th Celebration Greninja ex Box";
 await ctx.publisher.ingest({type:"product",retailer:"target",name:title,sku:"SKU-3001",stock:"10+"});
 await ctx.publisher.ingest({type:"product",retailer:"target",name:title,tcin:"1010892065",stock:"10+"});
 assert.equal(ctx.events.length,1,"same item with a second identifier is not duplicated");
 await ctx.publisher.ingest({type:"product",retailer:"target",name:title,tcin:"1010892065",stock:"12+"});
 assert.equal(ctx.events.length,2);
 assert.equal(ctx.events[1].action,"PATCH");
 await ctx.publisher.ingest({type:"product",retailer:"target",name:title,tcin:"9999999999",stock:"12+"});
 assert.equal(ctx.events.length,3,"a conflicting verified TCIN is a separate listing");
});


test("product with no retailer identifier still posts by product name and can later attach a TCIN",async t=>{
 const ctx=await setup();t.after(ctx.close);
 await ctx.publisher.ingest({type:"product",retailer:"sams",name:"30th Celebration Bundle",stock:"10+"});
 assert.equal(ctx.events.length,1);
 assert.equal(ctx.events[0].payload.embeds[0].fields.length,3);
 await ctx.publisher.ingest({type:"product",retailer:"sams",name:"30th Celebration Bundle",tcin:"1010892065",stock:"10+"});
 assert.equal(ctx.events.length,1,"identified update must not create a duplicate product");
 await ctx.publisher.ingest({type:"product",retailer:"sams",name:"30th Celebration Bundle",tcin:"1010892065",stock:"12+"});
 assert.equal(ctx.events.at(-1).action,"PATCH");
});
