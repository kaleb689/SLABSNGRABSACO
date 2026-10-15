import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=server.indexOf('app.post("/api/admin/checkout-link-diagnostics/assign"');
const end=server.indexOf('app.get("/api/admin/discord-checkout-profile-matching"',start);
assert.ok(start>0 && end>start);
const sourceChannel='1532179373292257290';
const messageId='1580000000000000900';
const originalId='discord:'+sourceChannel+':'+messageId;
const login='pkc-owner1@example.test';

function scenario(){
 let handler, stored=[{id:originalId,sourceIds:[originalId],retailer:'PKC',
  status:'confirmed',checkoutAt:'2026-10-15T20:17:00Z',
  customerAccountId:null,items:[{name:'Synthetic card tin',price:9.99,quantity:1}]}];
 let candidates=[], saved=0, notices=[], broadcasts=[];
 const context={
  crypto,app:{post:(_path,_auth,fn)=>{handler=fn;}},requireAdmin:()=>{},
  clean:(value,max)=>String(value||'').trim().slice(0,max),
  discordCheckoutSourceChannels:async()=>({token:'synthetic_bot_token',channels:[sourceChannel]}),
  discordBotJson:async()=>({id:messageId}),
  getCustomerAccounts:async()=>[{id:'member-a'},{id:'member-b'}],
  discordCheckoutOwners:async()=>candidates,
  discordCheckoutFromMessage:msg=>({id:'discord:'+sourceChannel+':'+msg.id,
   retailer:'PKC',checkoutAt:'2026-10-15T20:17:00Z',status:'confirmed'}),
  discordCheckoutIdentity:()=>({email:login}),
  confirmedDiscordPurchase:order=>order.status==='confirmed' && !order.cancelledAt,
  reviewHoldDiscordCheckout:order=>order.status==='review_hold',
  discordCheckoutCandidateEligible:()=>true,
  withSuccessStoreLock:async callback=>callback(),
  getSuccessCheckouts:async()=>stored,
  isAuthoritativeCheckoutRecord:row=>row.id.startsWith('discord:'+sourceChannel+':'),
  saveSuccessCheckouts:async()=>{saved++;},
  announceSuccessCheckout:id=>{notices.push(id);},
  broadcastLiveDataChange:why=>{broadcasts.push(why);},
  console
 };
 vm.runInNewContext(server.slice(start,end),context);
 async function invoke(body){
  let status=200,data=null;
  const response={
   setHeader(){},
   status(code){status=code;return this;},
   json(payload){data=payload;return payload;}
  };
  await handler({body},response);
  return {status,data};
 }
 return {invoke,order:()=>stored[0],setOrders:value=>{stored=value;},
  setCandidates:value=>{candidates=value;},
  notifications:()=>notices,changes:()=>broadcasts,
  saves:()=>saved};
}

test('admin-verified original Discord checkout is safely attributed once and customer is notified',async()=>{
 const app=scenario();
 const input={sourceId:originalId,customerAccountId:'member-a',verifiedByAdmin:true};
 const result=await app.invoke(input);
 assert.equal(result.status,200);
 assert.equal(result.data.linked,1);
 assert.equal(app.order().customerAccountId,'member-a');
 assert.equal(app.order().attributionSource,'admin_verified_original_discord_checkout');
 assert.equal(app.order().attributionAudit.sourceId,originalId);
 assert.ok(app.order().attributionAudit.retailerLoginHash);
 assert.ok(!JSON.stringify(app.order()).includes(login));
 assert.equal(app.saves(),1);
 assert.equal(app.notifications().length,1);
 assert.equal(app.notifications()[0],'member-a');
 assert.deepEqual(app.changes(),['admin-verified-discord-checkout-owner']);
 const repeat=await app.invoke(input);
 assert.equal(repeat.status,200);
 assert.equal(repeat.data.alreadyLinked,true);
 assert.equal(app.saves(),1);
 assert.equal(app.notifications().length,1);
});

test('explicit admin confirmation is required and another eligible historical owner blocks reassignment',async()=>{
 const app=scenario();
 const missing=await app.invoke({sourceId:originalId,customerAccountId:'member-a',verifiedByAdmin:false});
 assert.equal(missing.status,400);
 app.setCandidates([{retailer:'PKC',email:login,customerAccountId:'member-b'}]);
 const conflict=await app.invoke({sourceId:originalId,customerAccountId:'member-a',verifiedByAdmin:true});
 assert.equal(conflict.status,409);
 assert.equal(app.order().customerAccountId,null);
 assert.equal(app.saves(),0);
});

test('cancellations and missing source records cannot be invented or reassigned',async()=>{
 const app=scenario();
 const input={sourceId:originalId,customerAccountId:'member-a',verifiedByAdmin:true};
 app.order().status='cancelled';
 assert.equal((await app.invoke(input)).status,409);
 app.setOrders([]);
 assert.equal((await app.invoke(input)).status,404);
 assert.equal(app.saves(),0);
});

test('manual recovery is admin-only and the client uses a confirmed single-order POST',()=>{
 const html=readFileSync(new URL('../public/admin-checkout-match.html',import.meta.url),'utf8');
 const js=readFileSync(new URL('../public/admin-checkout-match.js',import.meta.url),'utf8');
 assert.match(server,/app\.post\("\/api\/admin\/checkout-link-diagnostics\/assign", requireAdmin/);
 assert.match(js,/verifiedByAdmin:true/);
 assert.match(js,/sourceId:order\.id/);
 assert.match(html,/Unlinked checkout emails/);
 assert.match(js,/VERIFY OWNERSHIP AND LINK THIS ORDER/);
});
