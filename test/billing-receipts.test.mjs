import test from "node:test";
import assert from "node:assert/strict";
import {receiptPayload,createBillingReceiptHandler} from "../billing-receipts.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("paid membership subscription invoice creates customer-only Stripe invoice receipt",()=>{
  const payload=receiptPayload({type:"invoice.payment_succeeded",data:{object:{
    id:"in_123",customer:"cus_123",customer_email:"member@example.test",
    amount_paid:1500,currency:"usd",number:"INV-100",hosted_invoice_url:"https://invoice.stripe.com/i/abc",
    billing_reason:"subscription_cycle",lines:{data:[{price:{id:"price_membership"}}]}
  }}});
  assert.equal(payload.id,"invoice:in_123");
  assert.equal(payload.email,"member@example.test");
  assert.match(payload.text,/\$15\.00/);
  assert.match(payload.text,/INV-100/);
  assert.match(payload.text,/invoice\.stripe\.com/);
  assert.doesNotMatch(payload.text,/CVV|card number|private vault/i);
});
test("first Studio purchase is handled only by the key receipt, not twice",()=>{
  assert.equal(receiptPayload({type:"invoice.payment_succeeded",data:{object:{
    id:"in_studio",amount_paid:1500,currency:"usd",billing_reason:"subscription_create",
    lines:{data:[{price:{id:"price_1UTD7yAgnoiOBmXPwB5kR3ek"}}]}
  }}}),null);
});
test("one-time paid checkout gets a receipt and unpaid payments are ignored",()=>{
  const o={id:"cs_abc",mode:"payment",payment_status:"paid",amount_total:3500,currency:"usd",
    customer_details:{email:"buyer@example.test"}};
  const rec=receiptPayload({type:"checkout.session.completed",data:{object:o}});
  assert.equal(rec.email,"buyer@example.test");
  assert.match(rec.text,/\$35\.00/);
  assert.equal(receiptPayload({type:"checkout.session.completed",data:{object:{...o,payment_status:"unpaid"}}}),null);
  assert.equal(receiptPayload({type:"checkout.session.completed",data:{object:{...o,mode:"subscription"}}}),null);
});
test("paid invoice notification sends once on repeated events and retries failures",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"membership-receipts-"));
  try{
    const messages=[];let failed=true;
    const sender=async m=>{if(failed){failed=false;throw Error("provider temporarily unavailable");}messages.push(m);};
    const handler=createBillingReceiptHandler({dataDir:dir,
      stripe:{customers:{retrieve:async()=>({email:"member@example.test"})}},sendEmail:sender});
    const event={type:"invoice.payment_succeeded",data:{object:{
      id:"in_paid_01",customer:"cus_123",amount_paid:3900,currency:"usd",number:"AB100",lines:{data:[]}
    }}};
    await assert.rejects(()=>handler.onStripeEvent(event),/provider temporarily unavailable/);
    assert.equal(messages.length,0);
    assert.equal(await handler.onStripeEvent(event),true);
    assert.equal(await handler.onStripeEvent(event),true);
    assert.equal(messages.length,1);
    assert.equal(messages[0].to,"member@example.test");
    assert.match(messages[0].subject,/receipt/i);
    assert.ok(messages[0].idempotencyKey);
    const persisted=JSON.parse(await fs.readFile(path.join(dir,"customer-payment-receipts.json"),"utf8"));
    assert.ok(persisted["invoice:in_paid_01"].sentAt);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
