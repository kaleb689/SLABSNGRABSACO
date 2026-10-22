import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const root=path.resolve(import.meta.dirname,"..");
const read=pathName=>fs.readFile(path.join(root,pathName),"utf8");

test("automated Discord shipment messages require a durable order/stage claim",async()=>{
 const s=await read("server.js");
 assert.match(s,/shippingDiscordDms\.claim\(/);
 assert.match(s,/orderNumber:record\.orderNumber, status:shipping\.status/);
 assert.ok(s.indexOf("if (!claim.send) return false;",s.indexOf("async function sendShippingDiscordDm"))>=0);
});
test("automated Discord alerts use the shared guard for all core alert categories",async()=>{
 const server=await read("server.js"),bot=await read("discord-community.js"),lapse=await read("membership-lapse-notifications.js");
 const profile=server.slice(server.indexOf("async function sendDiscordAdminProfileWorkflowNotification"),server.indexOf("async function sendDiscordAdminProfileWorkflowNotification")+3500);
 const payment=server.slice(server.indexOf("async function sendDiscordAdminPaymentNotification"),server.indexOf("async function sendDiscordAdminPaymentNotification")+5400);
 assert.match(profile,/notificationDeliveryGuard\.claim/);
 assert.match(payment,/notificationDeliveryGuard\.claim/);
 assert.match(bot,/channel:"discord:sku-updates"/);
 assert.match(bot,/channel:"discord:sku-reminders"/);
 assert.match(lapse,/channel:"discord:membership"/);
 assert.match(lapse,/channel:"discord:admin:rtp"/);
 assert.match(lapse,/channel:"discord:webhook:membership"/);
});
test("order, app, and admin pushes are guarded without deduplicating deliberate manual push tests",async()=>{
 const customer=await read("order-notifications.js"),admin=await read("admin-push.js"),server=await read("server.js");
 assert.match(customer,/channel:"push:customer"/);
 assert.match(customer,/state\.eventHistory\[notification\.deliveryEventKey\]/);
 assert.match(admin,/channel:"push:admin"/);
 assert.match(server,/manual-push-test:/);
});
test("transactional email retries use stable provider idempotency identifiers",async()=>{
 const server=await read("server.js");
 assert.match(server,/"Idempotency-Key":"paid-order-"/);
 assert.match(server,/"Idempotency-Key":"consent-receipt-"/);
 assert.match(server,/"Idempotency-Key":"account-welcome-"/);
 assert.match(server,/"Idempotency-Key": idempotencyKey/);
});
