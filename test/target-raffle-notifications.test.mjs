import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRaffleOwnerNotifier } from "../target-raffle-notifications.js";

test("new member and paid item alerts persist and send one private owner mention",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"raffle-alerts-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const sent=[];
  const discord={
    guildId:"111111111111111111",ownerId:"222222222222222222",
    api:async(endpoint,method,data)=>{
      if(endpoint==="/guilds/111111111111111111/channels")return [
        {id:"333333333333333333",type:4,name:"Admin Only"},
        {id:"444444444444444444",type:0,parent_id:"333333333333333333",name:"action-needed"}
      ];
      if(endpoint==="/channels/444444444444444444/messages"&&method==="POST"){
        sent.push(data);return {id:String(sent.length)};
      }
      throw Error("Unexpected Discord operation "+endpoint);
    }
  };
  const notifier=createRaffleOwnerNotifier({dataDir:dir,getDiscord:()=>discord});
  await notifier.announce({kind:"membership",eventId:"sub_123",
    title:"New Target Raffle Club membership",body:"person@example.test joined ($5/month)."});
  await notifier.announce({kind:"paid-item",eventId:"order-123",
    title:"New paid Target raffle entry",body:"person@example.test paid $100.00 for 2."});
  await notifier.flush();
  assert.equal(sent.length,2);
  assert.equal(sent[0].allowed_mentions.users[0],discord.ownerId);
  assert.ok(sent.every(message=>message.content.includes("<@"+discord.ownerId+">")));
  assert.equal((await notifier.history()).length,2);
  assert.equal((await notifier.history()).filter(x=>x.discordSent).length,2);
  await notifier.announce({kind:"paid-item",eventId:"order-123",
    title:"New paid Target raffle entry",body:"Do not send twice."});
  await notifier.flush();
  assert.equal(sent.length,2,"duplicate Stripe events cannot create duplicate owner alerts");
  const again=createRaffleOwnerNotifier({dataDir:dir,getDiscord:()=>discord});
  await again.flush();
  assert.equal(sent.length,2,"restart does not re-send private Discord alerts");
});
