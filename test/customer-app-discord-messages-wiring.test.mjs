import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=file=>readFileSync(new URL("../"+file,import.meta.url),"utf8");
const server=read("server.js"),bot=read("discord-community.js"),orders=read("order-notifications.js");
const app=read("public/app-dashboard.js"),markup=read("public/index.html");
const styles=read("public/app-messages.css"),worker=read("public/sw.js");
test("Customer app nav has a working private Messages composer",()=>{
 assert.match(app,/messages: 'Messages'/);
 assert.match(app,/navLabels = \['home', 'success', 'tracking', 'profile', 'products', 'history', 'messages'\]/);
 assert.match(app,/view === 'messages'/);
 assert.match(app,/data-app-message-form/);
 assert.match(app,/data-app-message-text/);
 assert.match(app,/\/api\/account\/support\/messages/);
 assert.match(app,/sendSupportMessage/);
 assert.match(markup,/\/app-messages\.css/);
 assert.match(styles,/sng-support-thread/);
 assert.match(worker,/\"messages\"/);
});
test("Customer APIs use session-owned account IDs, not user-selected recipients",()=>{
 assert.match(server,/app\.get\("\/api\/account\/support\/messages",requireCustomer/);
 assert.match(server,/app\.post\("\/api\/account\/support\/messages",requireCustomer/);
 assert.match(server,/app\.post\("\/api\/account\/support\/read",requireCustomer/);
 assert.match(server,/customerSupportMessages\.list\(String\(req\.customerAccount\.id\)\)/);
 assert.match(server,/customerSupportMessages\.send\(req\.customerAccount,req\.body\?\.text\)/);
 assert.match(server,/req\.customerAdminPreview/);
 assert.doesNotMatch(server,/customerSupportMessages\.list\(.*req\.query/);
});
test("Discord channel is owner-only under Admin Only and replies are checked before routing",()=>{
 assert.match(bot,/name:"app-messages",type:0,parent_id:adminCategory\.id/);
 assert.match(bot,/appSupportOwnerOnly/);
 assert.match(bot,/type:0,deny:"1024"/);
 assert.match(bot,/id:ownerId,type:1,allow:"68608"/);
 assert.match(bot,/onCustomerSupportReady/);
 assert.match(bot,/onCustomerSupportReply\(packet\.d\)/);
 assert.match(server,/onCustomerSupportReply:message=>customerSupportMessages\.handleDiscordReply\(message\)/);
 assert.match(server,/onCustomerSupportReady:bridge=>customerSupportMessages\.setBridge\(bridge\)/);
});
test("Support replies create a deduplicated push with a Messages deep link",()=>{
 assert.match(orders,/notifySupportReply: \(accountId, message\)/);
 assert.match(orders,/kind:"admin_message"/);
 assert.match(orders,/tab:"messages"/);
 assert.match(orders,/if\(eligible\)enqueue\(id,event\)/);
 assert.match(server,/appOrderNotifications\.notifySupportReply\(accountId,message\)/);
 assert.match(server,/appOrderNotifications\.tick\(\)/);
 assert.match(worker,/\"messages\"/);
});
