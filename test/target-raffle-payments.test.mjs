import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { raffleCartTotal, raffleAvailableStock, registerTargetRaffleItemPayments } from "../target-raffle-payments.js";

const ITEM="abcdef123456789012", USER="123456789012345678", ACCOUNT="member-01";
function appHarness(){
  const routes=new Map();
  const app={get:(p,...args)=>routes.set("GET "+p,args.at(-1)),
    post:(p,...args)=>routes.set("POST "+p,args.at(-1))};
  async function request(method,route,{body={},params={}}={}){
    let status=200,result;
    const req={body,params,customerAccount:{id:ACCOUNT,email:"member@example.test",discordUserId:USER}};
    const res={status(n){status=n;return this;},json(v){result=v;return this;},setHeader(){}};
    assert.ok(routes.has(method+" "+route),"route exists");
    await routes.get(method+" "+route)(req,res);
    return {status,result};
  }
  return {app,request};
}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"raffle-payment-test-"));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const {app,request}=appHarness(),catalog=[{
    id:ITEM,name:"Target Collector Box",sku:"0123456789",priceCents:2500,
    active:true,stock:10,maxQty:4,entries:[]}];
  const created=[],committed=[],refunds=[];
  const stripe={
    checkout:{sessions:{async create(data){
      created.push(data);
      return {id:"cs_test_COMPLETED123456789012345",url:"https://checkout.stripe.com/c/pay/123",
        expires_at:Math.floor(Date.now()/1000)+1800};
    }}},
    refunds:{async create(data,options){
      refunds.push({data,options});
      return {id:"re_"+refunds.length,status:"succeeded"};
    }}
  };
  const payments=registerTargetRaffleItemPayments({
    app,stripe,requireCustomer:()=>{},requireAdmin:()=>{},dataDir:dir,
    baseUrl:"https://example.test",getItems:async()=>catalog,
    getSubscription:async()=>({status:"active"}),
    getAccounts:async()=>[{id:ACCOUNT,email:"member@example.test"}],
    commitPaidOrder:async order=>{
      committed.push(order);
      for(const line of order.lines){
        const product=catalog.find(x=>x.id===line.itemId);
        if(!product.entries.some(x=>x.orderId===order.id))
          product.entries.push({orderId:order.id,qty:line.qty});
      }
    },
    applyOrderRefund:async order=>{
      for(const line of order.lines){
        const product=catalog.find(x=>x.id===line.itemId);
        const row=product.entries.find(x=>x.orderId===order.id);
        if(!row)continue;
        row.qty=line.qty-line.refundedQty;
        if(!row.qty)product.entries=product.entries.filter(x=>x!==row);
      }
    },
    closeItem:async id=>{
      const product=catalog.find(x=>x.id===id);
      product.active=false;product.drawCanceledAt=new Date().toISOString();
    }
  });
  function verified(orderId){
    return {type:"checkout.session.completed",created:Math.floor(Date.now()/1000),
      data:{object:{id:"cs_test_COMPLETED123456789012345",
        mode:"payment",payment_status:"paid",payment_intent:"pi_test_123",
        currency:"usd",amount_total:5000,client_reference_id:ACCOUNT,
        metadata:{purchase_type:"target_raffle_items",customer_account_id:ACCOUNT,
          raffle_order_id:orderId}}}};
  }
  return {payments,request,created,committed,refunds,catalog,verified};
}
test("SKU quantities total in cents and expired reservations release inventory",()=>{
  assert.equal(raffleCartTotal([{priceCents:2550,qty:2},{priceCents:799,qty:1}]),5899);
  assert.throws(()=>raffleCartTotal([{priceCents:99,qty:0}]));
  const stock={id:ITEM,stock:10};
  assert.equal(raffleAvailableStock(stock,[{status:"pending",
    expiresAt:new Date(Date.now()+300000).toISOString(),
    lines:[{itemId:ITEM,qty:3}]}]),7);
  assert.equal(raffleAvailableStock(stock,[{status:"partially_refunded",
    lines:[{itemId:ITEM,qty:3,refundedQty:2}]}]),9);
});
test("unpaid Discord cart does not join queue and repeat checkout reuses pending session",async t=>{
  const f=await fixture(t);
  await f.payments.setDraft({accountId:ACCOUNT,userId:USER,itemId:ITEM,qty:2});
  assert.equal((await f.payments.getCart(ACCOUNT)).totalCents,5000);
  const denied=await f.request("POST","/api/account/raffle-club/items/checkout",
    {body:{acknowledgeRefundPolicy:false}});
  assert.equal(denied.status,400);
  const first=await f.request("POST","/api/account/raffle-club/items/checkout",
    {body:{acknowledgeRefundPolicy:true}});
  assert.equal(first.status,200);
  assert.equal(f.committed.length,0);
  const repeat=await f.request("POST","/api/account/raffle-club/items/checkout",
    {body:{acknowledgeRefundPolicy:true}});
  assert.equal(repeat.result.orderId,first.result.orderId);
  assert.equal(f.created.length,1);
  assert.match(f.created[0].custom_text.submit.message,/refunded/i);
  await f.payments.onStripeEvent(f.verified(first.result.orderId));
  assert.equal(f.committed.length,1);
  assert.equal(f.catalog[0].entries[0].qty,2);
  await f.payments.onStripeEvent(f.verified(first.result.orderId));
  assert.equal(f.committed.length,1);
  assert.equal((await f.payments.getCart(ACCOUNT)).totalCents,0);
});
test("partial and full refunds are capped and idempotent",async t=>{
  const f=await fixture(t);
  await f.payments.setDraft({accountId:ACCOUNT,userId:USER,itemId:ITEM,qty:2});
  const first=await f.request("POST","/api/account/raffle-club/items/checkout",
    {body:{acknowledgeRefundPolicy:true}});
  await f.payments.onStripeEvent(f.verified(first.result.orderId));
  const url="/api/admin/raffle-club/orders/:id/refund",params={id:first.result.orderId};
  const a=await f.request("POST",url,{params,
    body:{requestId:"refund-partial-001",itemId:ITEM,amountCents:1000}});
  assert.equal(a.status,200);
  assert.equal(a.result.order.refundedCents,1000);
  assert.equal(f.catalog[0].entries[0].qty,2);
  const b=await f.request("POST",url,{params,
    body:{requestId:"refund-rest-0001",itemId:"all",amountCents:4000}});
  assert.equal(b.result.order.status,"refunded");
  assert.equal(f.catalog[0].entries.length,0);
  const retry=await f.request("POST",url,{params,
    body:{requestId:"refund-rest-0001",itemId:"all",amountCents:4000}});
  assert.equal(retry.result.idempotent,true);
  assert.equal(f.refunds.length,2);
});
test("late successful payment after draw canceled is automatically refunded",async t=>{
  const f=await fixture(t);
  await f.payments.setDraft({accountId:ACCOUNT,userId:USER,itemId:ITEM,qty:2});
  const first=await f.request("POST","/api/account/raffle-club/items/checkout",
    {body:{acknowledgeRefundPolicy:true}});
  const canceled=await f.request("POST",
    "/api/admin/raffle-club/items/:id/cancel-and-refund",
    {params:{id:ITEM},body:{confirmCancellation:true}});
  assert.equal(canceled.status,200);
  assert.equal(f.catalog[0].active,false);
  await f.payments.onStripeEvent(f.verified(first.result.orderId));
  assert.equal(f.refunds.length,1);
  assert.equal(f.refunds[0].data.amount,5000);
  assert.equal(f.catalog[0].entries.length,0);
  const history=await f.request("GET","/api/admin/raffle-club/orders");
  assert.equal(history.result.orders[0].status,"refunded");
});
