import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createCustomerSupportMessages,normalizeSupportText,resolveSupportRecipient} from "../customer-support-messages.js";

const guildId="777777777777777777",channelId="888888888888888888",ownerId="999999999999999999";
const a={id:"account-a",name:"Alice",discordUserId:"123456789012345678",discordLinkedAt:"2026-11-15T10:00:00Z"};
const b={id:"account-b",name:"Bob",discordUserId:"234567890123456789",discordLinkedAt:"2026-11-15T10:00:00Z"};
const packet=(id,content,reference=null,author=ownerId)=>({
 id,guild_id:guildId,channel_id:channelId,author:{id:author,bot:false},content,
 mentions:[...content.matchAll(/<@!?(\d{17,22})>/g)].map(match=>({id:match[1]})),
 ...(reference?{message_reference:{message_id:reference}}:{})
});
const setup=async fn=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"sng-private-support-"));
 try{await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}
};
test("Only valid text may reach the owner; unsafe or oversized text is refused",()=>{
 assert.equal(normalizeSupportText("  hello \r\n there  "),"hello \n there");
 assert.throws(()=>normalizeSupportText(""),/1 to 1,500/);
 assert.throws(()=>normalizeSupportText("x".repeat(1501)),/1 to 1,500/);
 assert.throws(()=>normalizeSupportText("private\u0001data"),/1 to 1,500/);
});
test("Messages remain scoped to their account and queue safely before Discord is available",()=>setup(async dir=>{
 const accounts=[a,b],out=[],notified=[];
 const service=createCustomerSupportMessages({dataDir:dir,getAccounts:async()=>accounts,
  onReply:async(...args)=>notified.push(args)});
 const alice=await service.send(a,"Can you check my profile?");
 const bob=await service.send(b,"I need help with my SKU selection");
 assert.equal(alice.message.delivery,"queued");
 assert.equal((await service.list(a.id)).messages[0].text,"Can you check my profile?");
 assert.equal((await service.list(b.id)).messages[0].text,"I need help with my SKU selection");
 assert.equal((await service.list("third-account")).messages.length,0);
 let serial=111111111111111110n;
 service.setBridge({guildId,channelId,ownerId,
  send:async item=>{out.push(item);return {id:String(++serial)};}});
 await service.flush();
 assert.equal(out.length,2);
 assert.ok(out.every(item=>item.allowed_mentions.parse.length===0));
 assert.ok(out[0].content.includes("Account ID: account-a"));
 assert.ok(!out[0].content.includes("Bob"));
 assert.ok(out[1].content.includes("Account ID: account-b"));
 assert.equal((await service.list(a.id)).messages[0].delivery,"delivered");
 const reply=packet("555555555555555551","<@123456789012345678> Your profile is ready.",String(111111111111111111n));
 assert.equal((await service.handleDiscordReply(reply)).recorded,true);
 assert.equal(notified.length,1);
 assert.equal(notified[0][0],a.id);
 assert.equal((await service.list(a.id)).messages.at(-1).text,"Your profile is ready.");
 assert.equal((await service.list(b.id)).messages.length,1);
 assert.equal((await service.list(a.id)).unread,1);
 await service.markRead(a.id);
 assert.equal((await service.list(a.id)).unread,0);
 assert.equal((await service.handleDiscordReply(reply)).duplicate,true);
 assert.equal(notified.length,1);
 const wrong=packet("555555555555555552","<@234567890123456789> Here is your answer",String(111111111111111111n));
 assert.equal((await service.handleDiscordReply(wrong)).unmatched,true);
 assert.equal(notified.length,1,"cross-customer mismatch must not notify either account");
 const bobReply=packet("555555555555555553","<@234567890123456789> Check your SKUs");
 assert.equal((await service.handleDiscordReply(bobReply)).recorded,true);
 assert.equal(notified.length,2);
 assert.equal((await service.list(b.id)).messages.at(-1).text,"Check your SKUs");
 assert.equal((await service.handleDiscordReply(packet("555555555555555554","<@123456789012345678> forged",null,"666666666666666666"))).ignored,true);
 const restored=createCustomerSupportMessages({dataDir:dir,getAccounts:async()=>accounts});
 assert.equal((await restored.list(a.id)).messages.length,2);
 assert.equal((await restored.list(b.id)).messages.length,2);
}));
test("Discord reply destination rejects missing, duplicate and contradictory recipients",()=>{
 const data={accounts:{"account-a":{messages:[{discordMessageId:"111111111111111111"}]},
  "account-b":{messages:[{discordMessageId:"222222222222222222"}]}}};
 assert.equal(resolveSupportRecipient(packet("555555555555555555","<@123456789012345678> okay"),data,[a,b],ownerId,channelId),a.id);
 assert.equal(resolveSupportRecipient(packet("555555555555555556","No recipient"),data,[a,b],ownerId,channelId),null);
 assert.equal(resolveSupportRecipient(packet("555555555555555557","<@123456789012345678> <@234567890123456789> both"),data,[a,b],ownerId,channelId),null);
 assert.equal(resolveSupportRecipient(packet("555555555555555558","<@234567890123456789> mismatch","111111111111111111"),data,[a,b],ownerId,channelId),null);
 assert.equal(resolveSupportRecipient(packet("555555555555555559","Reply by thread","111111111111111111"),data,[a,b],ownerId,channelId),a.id);
});
test("A customer cannot spam the private channel beyond the per-hour quota",()=>setup(async dir=>{
 const service=createCustomerSupportMessages({dataDir:dir,getAccounts:async()=>[a,b]});
 for(let i=0;i<12;i++)await service.send(a,"Message "+i);
 await assert.rejects(service.send(a,"Message 13"),/Message limit reached/);
 assert.equal((await service.list(b.id)).messages.length,0);
}));
