import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import read from "node:fs";
import os from "node:os";
import path from "node:path";
import {createOrderNotifications} from "../order-notifications.js";

const eventKey="drop:ad4d0ee9-93e4-46c2-bdee-d5ec26ef2ed4:live";
const sourceUrl="https://discord.com/channels/803097107660931082/1570500003850354729/1611111111111111111";
const broadcast={
  kind:"drop_broadcast",eventType:"live",title:"DROP IS LIVE — Target",
  message:"The Target drop is live. Recap in 12 hours.",
  retailer:"target",sourceUrl
};
async function fixture(t){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"sng-global-drop-app-"));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const sent=[],sub={endpoint:"https://fcm.googleapis.com/fcm/send/sng-a",
    keys:{p256dh:"A".repeat(87),auth:"B".repeat(22)}};
  const opts={dataDir,baseUrl:"https://slabsngrabsaco.com",
    getRecords:async()=>[],getAccounts:async()=>[{id:"a",notifications:[]},{id:"b",notifications:[]},{id:"c",notifications:[]}],
    sendPush:async(endpoint,payload)=>sent.push({endpoint:endpoint.endpoint,...JSON.parse(payload)})};
  const service=createOrderNotifications(opts);await service.initialize();
  return {service,sent,sub,opts};
}
test("global drop reaches every enabled account without retailer opt-in, while OS push honors device consent",async t=>{
  const f=await fixture(t);
  await f.service.subscribe("a",f.sub);
  await f.service.subscribe("b",{...f.sub,endpoint:f.sub.endpoint+"-b"});
  await f.service.setPreferences("b",{drops:false});
  const out=await f.service.notifyGlobalDropBroadcast(["a","b","c"],broadcast,eventKey);
  assert.deepEqual(out,{recorded:3,pushQueued:1});
  for(const id of ["a","b","c"]){
    const inbox=await f.service.list(id);
    assert.equal(inbox.length,1);
    assert.equal(inbox[0].kind,"drop_broadcast");
    assert.equal(inbox[0].sourceUrl,sourceUrl);
    assert.equal(inbox[0].tab,"drops");
  }
  await f.service.tick();
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].title,broadcast.title);
  assert.equal(f.sent[0].endpoint,f.sub.endpoint);
  assert.deepEqual(await f.service.notifyGlobalDropBroadcast(["a","b","c"],broadcast,eventKey),
    {recorded:0,pushQueued:0});
  assert.equal((await f.service.list("a")).length,1);
  // The persisted inbox and delivery guard survive Render service restarts.
  const restarted=createOrderNotifications(f.opts);await restarted.initialize();
  assert.deepEqual(await restarted.notifyGlobalDropBroadcast(["a","b","c"],broadcast,eventKey),
    {recorded:0,pushQueued:0});
  assert.equal((await restarted.list("a")).length,1);
});
test("recap is a separate event, opens Discord and is not dropped when account opts out of push",async t=>{
  const f=await fixture(t);
  await f.service.setPreferences("a",{drops:false});
  const recap={...broadcast,eventType:"recap",title:"DROP RECAP — Target"};
  const out=await f.service.notifyGlobalDropBroadcast(["a"],recap,eventKey.replace(/:live$/,":recap"));
  assert.equal(out.recorded,1);
  assert.equal(out.pushQueued,0);
  assert.equal((await f.service.list("a"))[0].eventType,"recap");
});
test("only owner issued safe Discord links and event keys can be broadcast",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.notifyGlobalDropBroadcast(["a"],
    {...broadcast,sourceUrl:"https://evil.test/x"},eventKey),/Invalid global/);
  await assert.rejects(f.service.notifyGlobalDropBroadcast(["a"],
    {...broadcast,kind:"drop_skus_updated"},eventKey),/Invalid global/);
  await assert.rejects(f.service.notifyGlobalDropBroadcast(["a"],
    {...broadcast,eventType:"unknown"},eventKey),/Invalid global/);
  assert.equal((await f.service.list("a")).length,0);
});
test("Discord and customer app are both wired to the same global drop event",()=>{
  const server=read.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const discord=read.readFileSync(new URL("../discord-community.js",import.meta.url),"utf8");
  const pub=read.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  assert.match(server,/onGlobalDropNotification: async/);
  assert.match(server,/notifyGlobalDropBroadcast\(/);
  assert.match(discord,/onGlobalDropNotification\(\{notification,eventKey,messageId\}\)/);
  assert.match(pub,/isFreshCustomerDrop\(/);
  assert.match(pub,/safeCustomerDropLink\(/);
  assert.match(pub,/showCustomerNotificationPopup\(notice\)/);
});
