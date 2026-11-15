import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {applyApprovedDiscordBotAvatar} from "../discord-bot-avatar.js";

const ID="1532179373292257291";

test("approved robot image updates only the actual Discord bot avatar once",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"sng-avatar-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const requests=[];
  const api=async(route,method="GET",body)=>{
    requests.push({route,method,body});
    if(method==="GET")return {id:ID,bot:true,username:"SNG Bot"};
    if(method==="PATCH")return {id:ID,bot:true,avatar:"new-image-hash"};
    throw Error("Unexpected Discord request");
  };
  const first=await applyApprovedDiscordBotAvatar({api,dataDir:dir});
  assert.equal(first.status,"updated");
  assert.deepEqual(requests.map(x=>[x.route,x.method]),[
    ["/users/@me","GET"],["/users/@me","PATCH"]]);
  const update=requests[1].body;
  assert.deepEqual(Object.keys(update),["avatar"],"No username, password or server settings are changed");
  assert.match(update.avatar,/^data:image\/jpeg;base64,\/9j\//);
  assert.ok(update.avatar.length>5000);
  const marker=JSON.parse(await fs.readFile(path.join(dir,"discord-bot-avatar-applied.json"),"utf8"));
  assert.equal(marker.discordBotId,ID);
  assert.match(marker.assetSha256,/^[a-f0-9]{64}$/);
  assert.equal(await applyApprovedDiscordBotAvatar({api,dataDir:dir}).then(x=>x.status),"unchanged");
  assert.equal(requests.length,2,"A restart must not resend the avatar update");
});

test("non-bot auth cannot be used to change a Discord profile",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"sng-avatar-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const seen=[];
  const api=async(route,method="GET")=>{
    seen.push(method);
    if(method==="GET")return {id:ID,bot:false};
    throw Error("Bot modification is forbidden");
  };
  await assert.rejects(applyApprovedDiscordBotAvatar({api,dataDir:dir}),/not a bot/);
  assert.deepEqual(seen,["GET"]);
});

test("failed Discord update does not claim the avatar was applied",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"sng-avatar-"));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const api=async(_route,method="GET")=>{
    if(method==="GET")return {id:ID,bot:true};
    throw Error("Discord rejected the avatar update");
  };
  await assert.rejects(applyApprovedDiscordBotAvatar({api,dataDir:dir}),/rejected/);
  await assert.rejects(fs.access(path.join(dir,"discord-bot-avatar-applied.json")));
});
