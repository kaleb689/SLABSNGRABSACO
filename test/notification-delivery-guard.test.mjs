import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createNotificationDeliveryGuard,notificationClaimKey} from "../notification-delivery-guard.js";
import {createShippingDiscordDmLedger,shippingDiscordDmKey} from "../shipping-discord-dm-ledger.js";

const example={accountId:"account-a",discordUserId:"123456789012345678",retailer:"PKC",orderNumber:"ORDER-42",status:"shipped"};
async function makeDir(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"notification-guard-test-"));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return dir;
}
test("one shipping DM per customer, retailer, order and stage after restart",async t=>{
 const dataDir=await makeDir(t),dm=createShippingDiscordDmLedger({dataDir});
 assert.ok(shippingDiscordDmKey(example));
 assert.equal((await dm.claim(example)).send,true);
 assert.deepEqual(await dm.claim(example),{send:false,reason:"already_notified"});
 const second=createShippingDiscordDmLedger({dataDir});
 assert.equal((await second.claim({...example,status:"shipped"})).send,false);
 assert.equal((await second.claim({...example,status:"in_transit"})).send,true);
 assert.equal((await second.claim({...example,orderNumber:"ORDER-43"})).send,true);
 assert.equal((await second.claim({...example,discordUserId:"223456789012345678"})).send,true);
 assert.equal((await second.claim({...example,retailer:"Target"})).send,true);
 assert.equal((await second.claim({...example,status:"not_a_real_stage"})).send,false);
});
test("guard protects each transport and recipient separately",async t=>{
 const guard=createNotificationDeliveryGuard({dataDir:await makeDir(t)});
 const eventKey="drop:target:post-42:revision-two";
 assert.equal((await guard.claim({channel:"discord:sku-updates",recipient:"one",eventKey})).send,true);
 assert.equal((await guard.claim({channel:"discord:sku-updates",recipient:"one",eventKey})).send,false);
 assert.equal((await guard.claim({channel:"push:customer",recipient:"one:device",eventKey})).send,true);
 assert.equal((await guard.claim({channel:"discord:sku-updates",recipient:"two",eventKey})).send,true);
 assert.equal((await guard.claim({channel:"discord:sku-updates",recipient:"one",eventKey:eventKey+"-new"})).send,true);
 assert.notEqual(notificationClaimKey({channel:"push:admin",recipient:"one",eventKey}),
                 notificationClaimKey({channel:"push:customer",recipient:"one",eventKey}));
});
test("concurrent jobs claim an event once across independent ledgers",async t=>{
 const dataDir=await makeDir(t);
 const workers=Array.from({length:6},()=>createNotificationDeliveryGuard({dataDir}));
 const outcomes=await Promise.all(workers.map(w=>w.claim({channel:"push:customer",recipient:"account-a:device-a",eventKey:"order-a:shipped"})));
 assert.equal(outcomes.filter(r=>r.send).length,1);
 assert.equal(outcomes.filter(r=>r.reason==="already_notified").length,5);
});
test("explicit short windows expire, permanent event identities do not",async t=>{
 let clock=Date.now(),dataDir=await makeDir(t);
 const guard=createNotificationDeliveryGuard({dataDir,now:()=>clock});
 const details={channel:"push:admin",recipient:"device",eventKey:"temporary-alert",windowMs:1000};
 assert.equal((await guard.claim(details)).send,true);
 clock+=999;
 assert.equal((await guard.claim(details)).send,false);
 clock+=2;
 assert.equal((await guard.claim(details)).send,true);
 const permanent={channel:"discord:shipping",recipient:"user",eventKey:"order:shipped"};
 assert.equal((await guard.claim(permanent)).send,true);
 clock+=370*86400000;
 assert.equal((await guard.claim(permanent)).send,false);
});
test("unreadable ledger fails closed instead of resending messages",async t=>{
 const dataDir=await makeDir(t),file=path.join(dataDir,"notification-delivery-guard.json");
 await fs.writeFile(file,"{not-json",{mode:0o600});
 const guard=createNotificationDeliveryGuard({dataDir});
 await assert.rejects(guard.claim({channel:"push:customer",recipient:"account",eventKey:"event"}),SyntaxError);
 assert.equal(await fs.readFile(file,"utf8"),"{not-json");
});
test("claimed event remains suppressed if external provider times out",async t=>{
 const dataDir=await makeDir(t);
 const first=createNotificationDeliveryGuard({dataDir});
 const claim=await first.claim({channel:"discord:membership",recipient:"user",eventKey:"membership-1:reminder"});
 assert.equal(claim.send,true);
 // Simulate a timeout after Discord accepted the POST; retry must not spam.
 const restart=createNotificationDeliveryGuard({dataDir});
 assert.equal((await restart.claim({channel:"discord:membership",recipient:"user",eventKey:"membership-1:reminder"})).send,false);
 const disk=await fs.readFile(path.join(dataDir,"notification-delivery-guard.json"),"utf8");
 assert.doesNotMatch(disk,/membership-1:reminder|account-a|123456789012345678|shipped/);
});
test("invalid destination and empty event keys do not produce claims",async t=>{
 const guard=createNotificationDeliveryGuard({dataDir:await makeDir(t)});
 for(const options of [{channel:"",recipient:"someone",eventKey:"event"},{channel:"push:admin",recipient:"",eventKey:"event"},{channel:"push:admin",recipient:"someone",eventKey:""}]){
  assert.deepEqual(await guard.claim(options),{send:false,reason:"invalid_event_identity"});
 }
});
