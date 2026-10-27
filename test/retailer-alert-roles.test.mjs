import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RETAILER_ALERTS, retailerFromDropLabel, mentionedRetailers,
  retailerAlertButtons, receivesRetailerAlert } from "../retailer-alert-roles.js";
import { createOrderNotifications } from "../order-notifications.js";

test("Server Roles has five distinct retailer buttons",()=>{
  const row=retailerAlertButtons()[0];
  assert.equal(row.components.length,5);
  assert.equal(new Set(row.components.map(x=>x.custom_id)).size,5);
  assert.deepEqual(row.components.map(x=>x.custom_id),
    RETAILER_ALERTS.map(x=>"retailer:role:"+x.key));
});

test("upcoming and SKU retailer matching is scoped",()=>{
  assert.equal(retailerFromDropLabel("PKC Drops"),"pokemoncenter");
  assert.equal(retailerFromDropLabel("Sam's Drops"),"sams");
  assert.deepEqual(mentionedRetailers("Pokemon Center and Walmart tomorrow"),
    ["walmart","pokemoncenter"]);
  assert.deepEqual(mentionedRetailers("New drop soon"),[]);
  assert.equal(receivesRetailerAlert({target:true},"walmart"),false);
  assert.equal(receivesRetailerAlert({target:true},["walmart","target"]),true);
});

test("linked app opt-ins filter push recipients and persist opt-outs",async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"sng-retailer-roles-"));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const sent=[];
  const service=createOrderNotifications({dataDir,baseUrl:"https://slabsngrabsaco.com",
    getRecords:async()=>[],getAccounts:async()=>[{id:"one"},{id:"two"}],
    sendPush:async (sub,payload)=>sent.push({endpoint:sub.endpoint,...JSON.parse(payload)})});
  await service.initialize();
  const sub={endpoint:"https://fcm.googleapis.com/fcm/send/retailer-a",
    keys:{p256dh:"A".repeat(87),auth:"B".repeat(22)}};
  await service.subscribe("one",sub);
  await service.subscribe("two",{...sub,endpoint:"https://fcm.googleapis.com/fcm/send/retailer-b"});
  const sync=await service.syncRetailerRoles("one",["target"]);
  assert.equal(sync.pushConfigured,true);
  await service.syncRetailerRoles("two",["walmart"]);
  assert.deepEqual((await service.preferences("one")).retailerAlerts,{
    target:true,walmart:false,pokemoncenter:false,costco:false,sams:false
  });
  let r=await service.notifyDropUpdate(["one","two"],{
    kind:"drop_skus_updated",retailer:"target",title:"Target Drop",
    message:"Target SKUs",tab:"drops",sourceUrl:"https://discord.com/channels/1/2/3"
  },"drop:2:3:aaa");
  assert.deepEqual(r.pushAccountIds,["one"]);
  await service.tick();
  assert.equal(sent.length,1);
  r=await service.notifyDropUpdate(["one","two"],{
    kind:"drop_announcement",retailers:["walmart"],title:"Upcoming Walmart",
    message:"Walmart drop tomorrow",tab:"drops",sourceUrl:"https://discord.com/channels/1/2/4"
  },"drop:2:4:announcement");
  assert.deepEqual(r.pushAccountIds,["two"]);
  await service.tick();
  assert.equal(sent.length,2);
  assert.equal((await service.syncRetailerRoles("one",["target"])).changed,false);
  await service.syncRetailerRoles("one",[]);
  assert.equal((await service.preferences("one")).retailerAlerts.target,false);
  r=await service.notifyDropUpdate(["one","two"],{
    kind:"drop_skus_updated",retailer:"target",title:"Target 2",
    message:"New",tab:"drops",sourceUrl:"https://discord.com/channels/1/2/5"
  },"drop:2:5:bbb");
  assert.deepEqual(r.pushAccountIds,[]);
  assert.equal((await service.list("one")).filter(x=>x.kind==="drop_skus_updated").length,1);
});
