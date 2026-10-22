import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRICE_ID = "price_1UTD7yAgnoiOBmXPwB5kR3ek";
const productDescription = "SLABSNGRABSACO";

function amount(value,currency) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 100_000_000) return null;
  const code = String(currency || "usd").toUpperCase();
  return new Intl.NumberFormat("en-US",{style:"currency",currency:code}).format(num / (["JPY","KRW"].includes(code)?1:100));
}
function invoiceIsPrivate(invoice) {
  const lines=invoice?.lines?.data || [];
  return invoice?.parent?.subscription_details?.metadata?.purchase_type === "studio_private" ||
    invoice?.subscription_details?.metadata?.purchase_type === "studio_private" ||
    lines.some(line=>line?.pricing?.price_details?.price === PRICE_ID ||
      line?.price?.id === PRICE_ID);
}
export function receiptPayload(event) {
  const entity=event?.data?.object;
  if (!entity || !entity.id || !event.type) return null;
  if (event.type === "invoice.payment_succeeded") {
    if (!Number.isInteger(entity.amount_paid) || entity.amount_paid < 1) return null;
    // First ACO Studio purchase gets its own key-bearing license receipt;
    // subsequent private renewals are handled below with a billing-only email.
    const studio = invoiceIsPrivate(entity);
    if (studio && entity.billing_reason === "subscription_create") return null;
    const title=studio?"ACO Studio Private Edition renewal":"SLABSNGRABSACO subscription payment";
    return {
      id:"invoice:"+entity.id, email:entity.customer_email || null,
      stripeCustomerId:typeof entity.customer==="string"?entity.customer:null,
      name:entity.customer_name || null,
      subject:title+" — payment receipt",
      text:[
        title+" receipt",
        "Amount paid: "+amount(entity.amount_paid,entity.currency),
        "Invoice number: "+(entity.number || entity.id),
        "Paid: "+(new Date().toISOString()),
        "Subscription: "+(typeof entity.subscription==="string"?entity.subscription:
          typeof entity.parent?.subscription_details?.subscription==="string"?entity.parent.subscription_details.subscription:"N/A"),
        ...(typeof entity.hosted_invoice_url==="string"&&entity.hosted_invoice_url.startsWith("https://")
          ? ["Your official Stripe invoice: "+entity.hosted_invoice_url]:[]),
        "Stripe processes your payment securely. Your saved payment details are not included here."
      ].join("\n\n")
    };
  }
  // Covers one-time website purchases, gifts and extensions. Subscription
  // checkouts are handled by invoice events, never twice.
  if (event.type === "checkout.session.completed" && entity.mode === "payment" &&
      entity.payment_status === "paid" && Number.isInteger(entity.amount_total) && entity.amount_total > 0) {
    return {
      id:"checkout:"+entity.id,
      email:entity.customer_details?.email || entity.customer_email || null,
      stripeCustomerId:typeof entity.customer==="string"?entity.customer:null,
      name:entity.customer_details?.name || null,
      subject:"SLABSNGRABSACO — payment receipt",
      text:[
        "SLABSNGRABSACO payment receipt",
        "Amount paid: "+amount(entity.amount_total,entity.currency),
        "Payment reference: "+entity.id,
        "Paid: "+new Date().toISOString(),
        "If you need support, sign into your SLABSNGRABSACO website account.",
        "No passwords or saved payment-card details are included."
      ].join("\n\n")
    };
  }
  return null;
}
export function createBillingReceiptHandler({dataDir,stripe,sendEmail}) {
  const filename=path.join(dataDir,"customer-payment-receipts.json");
  let pending=Promise.resolve();
  function lock(fn){const task=pending.then(fn,fn);pending=task.catch(()=>{});return task;}
  async function read(){
    try{return JSON.parse(await fs.readFile(filename,"utf8"));}
    catch(e){if(e.code==="ENOENT")return {};throw e;}
  }
  async function save(rows){
    await fs.mkdir(dataDir,{recursive:true,mode:0o700});
    const tmp=filename+"."+crypto.randomUUID()+".tmp";
    await fs.writeFile(tmp,JSON.stringify(rows),{flag:"wx",mode:0o600});
    await fs.rename(tmp,filename);
  }
  async function customerAddress(payload) {
    if(emailPattern.test(payload.email||""))return payload.email.trim().toLowerCase();
    if(!payload.stripeCustomerId)return null;
    const customer=await stripe.customers.retrieve(payload.stripeCustomerId);
    if(customer?.deleted||!emailPattern.test(customer?.email||""))return null;
    return String(customer.email).trim().toLowerCase();
  }
  async function onStripeEvent(event) {
    const payload=receiptPayload(event);
    if(!payload)return false;
    return lock(async()=>{
      const rows=await read();
      if(rows[payload.id]?.sentAt)return true;
      const to=await customerAddress(payload);
      if(!to){
        // Do not send a receipt to an unverified or unidentifiable address.
        console.warn("Payment receipt missing customer email:",payload.id);
        return false;
      }
      if(typeof sendEmail!=="function")throw Error("Website receipt email provider is not configured.");
      await sendEmail({to,subject:payload.subject,text:payload.text,
        idempotencyKey:"sng-payment-receipt-"+crypto.createHash("sha256").update(payload.id).digest("hex").slice(0,32)});
      rows[payload.id]={sentAt:new Date().toISOString(),to};
      await save(rows);
      return true;
    });
  }
  return {onStripeEvent};
}
