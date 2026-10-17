import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import { isModuleLifecycleDiscordMessage } from "../discord-checkout-event-policy.js";
import {checkoutIdentityFromDiscord, checkoutStatusFromDiscord,
  checkoutProductFromDiscord} from '../discord-checkout-identity.js';
import {checkoutAssignmentContains, recoverCheckoutAssignmentOwners} from '../discord-checkout-owner-evidence.js';

const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const checkoutParser=server.slice(server.indexOf('function discordCheckoutFromMessage('),
  server.indexOf('const DISCORD_HIT_MIRROR_FILE'));
const sourceChannel='1532179373292257290';
const sampleEmail='testpkc001@example.test';

function stellarMessage(){
  const titles=['Mew', 'Pikachu', 'Espeon', 'Lapras'];
  const fields=[{name:'Site',value:'Pokemon Center US'},{name:'Mode',value:'guest'}];
  titles.forEach((title,i)=>{
    fields.push({name:'Product ('+(i+1)+')',value:'Pokemon TCG: 30th Celebration Mini Tin - '+title+' (Day)'});
    fields.push({name:'Price ('+(i+1)+')',value:'9.99'});
    fields.push({name:'Quantity ('+(i+1)+')',value:'1'});
  });
  fields.push({name:'Email',value:sampleEmail});
  fields.push({name:'Profile',value:'Synthetic Profile 3'});
  fields.push({name:'Order ID',value:'SYNTHETIC202610150123'});
  return {id:'1580000000000000801',timestamp:'2026-10-15T20:17:00Z',webhook_id:'1580000000000000200',
    content:'',embeds:[{color:0x57f287,fields}]};
}
function parse(msg){
 const context={msg,sourceChannel,result:null,discordCheckoutIdentity:checkoutIdentityFromDiscord,
  checkoutStatusFromDiscord,checkoutProductFromDiscord,checkoutExplicitPaidTotal:()=>null,
  isModuleLifecycleDiscordMessage,
  publicSuccessProductName:s=>String(s||'').slice(0,240),
  isSafeDiscordCheckoutProductName:s=>Boolean(s)&&!/@|password/i.test(s),
  publicSuccessImageUrl:()=>null,
  normalizeSuccessRetailer:s=>/pokemon center/i.test(String(s))?'PKC':String(s||'')};
 vm.runInNewContext(checkoutParser+'\nresult=discordCheckoutFromMessage(msg,sourceChannel);',context);
 return JSON.parse(JSON.stringify(context.result));
}

test('four-product Stellar AIO green webhook preserves retailer, email, products and subtotal',()=>{
 const webhook=stellarMessage();
 const parsed=parse(webhook);
 const identity=checkoutIdentityFromDiscord(webhook);
 assert.equal(identity.email,sampleEmail);
 assert.equal(identity.profileName,'Synthetic Profile 3');
 assert.equal(identity.orderNumber,'SYNTHETIC202610150123');
 assert.equal(parsed.status,'confirmed');
 assert.equal(parsed.retailer,'PKC');
 assert.equal(parsed.items.length,4);
 assert.equal(parsed.itemCount,4);
 assert.equal(parsed.orderTotalBasis,'item_subtotal');
 assert.equal(parsed.orderTotal,39.96);
 assert.ok(parsed.items.every(item=>item.quantity===1&&item.price===9.99));
 assert.ok(!JSON.stringify(parsed).includes(sampleEmail),'retailer email must not be persisted in checkout record');
});

test('generic legacy retailer pool still links a scoped PKC login but never crosses a specific Target assignment',async()=>{
 const start=server.indexOf('async function discordCheckoutOwners()');
 const end=server.indexOf('function discordCheckoutCandidateEligible(',start);
 assert.ok(start>0&&end>start);
 const accounts=[
  {id:'legacy',retailer:'Retailer',credentials:'cipher'},
  {id:'specific',retailer:'Target',credentials:'cipher'},
 ];
 const assignments=[
  {id:'assign-legacy',managedAccountId:'legacy',customerAccountId:'member-a',createdAt:'2026-10-14T12:00:00Z'},
  {id:'assign-target',managedAccountId:'specific',customerAccountId:'member-b',
    assignmentRetailer:'Target',createdAt:'2026-10-14T12:00:00Z'}
 ];
 const context={
  getRetailerProfiles:async()=>[],getManagedAccounts:async()=>accounts,
  managedAssignmentHistory:async()=>assignments,getRestoreHolds:async()=>[],
  recoverCheckoutAssignmentOwners,decryptJson:()=>({pkc:{username:sampleEmail}}),
  normalizeRetailerCredentials:value=>value,
  normalizeSuccessRetailer:value=>{
   const x=String(value||'').toLowerCase();
   return x==='pkc'?'PKC':x==='target'?'Target':x==='retailer'?'Retailer':value;
  },
  normalizeEmail:s=>String(s||'').trim().toLowerCase(),managedAccountEmailEvidence:()=>null,
  results:null
 };
 vm.runInNewContext(server.slice(start,end)+'\nresults=discordCheckoutOwners();',context);
 const results=await context.results;
 assert.equal(results.length,1);
 assert.equal(results[0].retailer,'PKC');
 assert.equal(results[0].email,sampleEmail);
 assert.equal(results[0].customerAccountId,'member-a');
 assert.equal(checkoutAssignmentContains(results[0].assignment,'2026-10-15T20:17:00Z'),true);
});

test('lightweight checkout scan preserves full historical cursor and runs on a ten second interval',()=>{
 assert.match(server,/async function scanDiscordSuccessChannel\(\{ quick = false \} = \{\}\)/);
 assert.match(server,/recentPages: quick \? 1 : 10, historyPages: quick \? 0 : 5/);
 assert.match(server,/if \(!quick && historyCheckpoints\.length === 1\)/);
 assert.match(server,/void scanDiscordSuccessChannel\(\{ quick: discordPollCount % 6 !== 0 \}\)/);
 assert.match(server,/10_000/);
 assert.match(server,/if \(!quick \|\| persistedStoreChanged\)/);
});

test('unmatched retailer logins are available only from the private admin endpoint',()=>{
 const page=readFileSync(new URL('../public/admin-checkout-match.html',import.meta.url),'utf8');
 const client=readFileSync(new URL('../public/admin-checkout-match.js',import.meta.url),'utf8');
 assert.match(server,/app\.get\("\/api\/admin\/checkout-link-diagnostics", requireAdmin/);
 assert.match(server,/retailerLogin:identity\.email/);
 assert.match(client,/\/api\/admin\/checkout-link-diagnostics/);
 assert.match(client,/unlinked-email-results/);
 assert.match(page,/Unlinked checkout emails/);
 assert.doesNotMatch(server.slice(server.indexOf('function safeSuccessCheckout('),
  server.indexOf('async function sendDiscordSuccessNotification(')),/retailerLogin:\s*identity\.email/);
});
