import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  MAX_OPERATOR_IMAP_INBOXES,OPERATOR_IMAP_HOSTS,operatorImapEmail,operatorImapProvider,
  validateOperatorImapEntry,combineOperatorImapSources,publicOperatorImapEntry
} from "../operator-imap-policy.js";

const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("owner IMAP validation permits only trusted secure provider presets",()=>{
 assert.equal(operatorImapEmail(" OWNER@GMAIL.COM "),"owner@gmail.com");
 assert.equal(operatorImapProvider("owner@gmail.com"),"google");
 assert.equal(operatorImapProvider("owner@outlook.com"),"microsoft");
 assert.equal(operatorImapProvider("owner@yahoo.com"),"yahoo");
 assert.equal(operatorImapProvider("owner@company.com"),null);
 assert.equal(operatorImapProvider("owner@company.com","google"),"google");
 assert.equal(operatorImapProvider("owner@gmail.com","https://attacker.test"),null);
 assert.ok(Object.values(OPERATOR_IMAP_HOSTS).every(x=>x.port===993));
 const input=validateOperatorImapEntry({email:"  Owner@GMail.com ",password:"secure-generated-app-password",label:"Shipping"});
 assert.equal(input.email,"owner@gmail.com");
 assert.equal(input.provider,"google");
 assert.equal(input.enabled,true);
 assert.equal(MAX_OPERATOR_IMAP_INBOXES,25);
 assert.throws(()=>validateOperatorImapEntry({email:"not-email",password:"123456"}),/valid inbox/);
 assert.throws(()=>validateOperatorImapEntry({email:"x@gmail.com",password:"123"}),/app password/);
 assert.throws(()=>validateOperatorImapEntry({email:"x@gmail.com",provider:"evil",password:"123456"}),/Choose Google/);
 assert.deepEqual(validateOperatorImapEntry({email:"x@gmail.com",provider:"google",password:""},{existingPassword:true}),
   {email:"x@gmail.com",provider:"google",label:"",enabled:true});
});

test("render-managed mailboxes win duplicate address conflicts with later admin inboxes",()=>{
 const list=combineOperatorImapSources([
  {id:"render-managed",email:"ONE@GMAIL.COM",source:"environment"}
 ],[
  {id:"first",email:"one@gmail.com",source:"admin"},
  {id:"second",email:"two@gmail.com",source:"admin"}
 ]);
 assert.equal(list.length,2);
 assert.equal(list[0].id,"render-managed");
 assert.equal(list[1].id,"second");
});

test("operator-only IMAP health excludes all secrets and classifies scanner freshness",()=>{
 const raw={id:"owner-1",email:"OWNER@GMAIL.COM",provider:"google",source:"admin",
   password:"super-secret-app-password",enabled:true,createdAt:"2026-10-30T12:00:00Z"};
 const now=Date.parse("2026-10-30T13:00:00Z");
 const last=new Date(now-2*60*1000).toISOString();
 const out=publicOperatorImapEntry(raw,{
   lastAttemptAt:last,lastConnectedAt:last,lastScanAt:last,
   messagesExamined:13,matchedMessages:2,candidateUpdates:1
 },now);
 assert.equal(out.status,"healthy");
 assert.equal(out.messagesExamined,13);
 assert.equal(out.candidateUpdates,1);
 assert.equal(out.passwordConfigured,true);
 assert.equal(out.email,"owner@gmail.com");
 assert.equal(JSON.stringify(out).includes(raw.password),false);
 assert.equal(publicOperatorImapEntry(raw,{lastScanAt:new Date(now-60*60*1000).toISOString(),
   lastConnectedAt:last},now).status,"stale");
 assert.equal(publicOperatorImapEntry(raw,{lastError:"connection_timeout"},now).status,"error");
 assert.equal(publicOperatorImapEntry({...raw,enabled:false},{},now).status,"paused");
});

test("production shipping scanner reads only operator-approved inboxes, never customer IMAP",()=>{
 const server=read("server.js");
 const start=server.indexOf("async function syncShippingTrackers()");
 const end=server.indexOf("function startShippingTrackerScheduler()",start);
 assert.ok(start>0 && end>start);
 const source=server.slice(start,end);
 assert.match(source,/approvedOperatorImapInboxes\(\)/);
 assert.match(source,/customerMailboxesScanned: 0/);
 assert.match(source,/operatorMailboxesScanned/);
 assert.doesNotMatch(source,/getCustomerSuccessMailboxes\(/);
 assert.doesNotMatch(source,/savedImapEntries\(/);
 assert.doesNotMatch(source,/createCustomerImapClient\(/);
 assert.match(server,/OPERATOR_IMAP_FILE = path\.join\(DATA_DIR, "operator-imap-inboxes\.encrypted\.json"\)/);
 assert.match(server,/writeJson\(OPERATOR_IMAP_FILE, encryptJson\(/);
 assert.match(server,/decryptJson\(encrypted\)/);
 assert.match(server,/source: "environment"/);
 assert.match(server,/process\.env\.IMAP_TEST_EMAIL/);
 assert.match(server,/process\.env\.IMAP_TEST_PASSWORD/);
 assert.match(server,/lastConnectedAt/);
 assert.match(server,/matchedMessages/);
 assert.match(server,/async function testApprovedOperatorImapConnection/);
 assert.match(server,/getMailboxLock\("INBOX",\{readOnly:true\}\)/);
 for(const route of [
  '"/api/admin/imap-health"', '"/api/admin/imap-health/:id"',
  '"/api/admin/imap-health/:id/test"', '"/api/admin/imap-health/scan"'
 ])assert.ok(server.includes(route),route);
 assert.match(server,/app\.get\("\/api\/admin\/imap-health", requireAdmin/);
 assert.match(server,/app\.post\("\/api\/admin\/imap-health", requireAdmin/);
 assert.match(server,/app\.put\("\/api\/admin\/imap-health\/:id",requireAdmin/);
 assert.match(server,/app\.delete\("\/api\/admin\/imap-health\/:id",requireAdmin/);
});

test("Admin website and installed Admin app both expose inbox management",()=>{
 const dashboard=read("public/admin.html");
 const mobile=read("public/admin-mobile.js");
 const mobileHtml=read("public/admin-app.html");
 const ui=read("public/operator-imap-health.js");
 assert.match(dashboard,/id="operator-imap-health-desktop-root"/);
 assert.match(dashboard,/SNGOperatorImapHealth\?\.mount/);
 assert.match(mobile,/id="operator-imap-health-mobile-root"/);
 assert.match(mobile,/SNGOperatorImapHealth\?\.mount/);
 assert.match(mobileHtml,/operator-imap-health\.js/);
 assert.match(ui,/data-imap-action="add"/);
 assert.match(ui,/data-imap-action="test"/);
 assert.match(ui,/data-imap-action="toggle"/);
 assert.match(ui,/data-imap-action="delete"/);
 assert.match(ui,/data-imap-action="scan"/);
 assert.match(ui,/type="password"/);
 assert.match(ui,/Customer email accounts are not scanned for tracking/);
});
