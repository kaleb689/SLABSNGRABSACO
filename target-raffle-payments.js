import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const RAFFLE_REFUND_NOTICE = "If a Target draw order is canceled, payments for the canceled raffle items will be refunded. If only some items or quantities are canceled, a partial refund may be issued. A paid request does not guarantee retailer fulfillment.";

const isId = value => /^[a-f0-9]{18}$/i.test(String(value || ""));
const isRequestId = value => /^[A-Za-z0-9_-]{8,100}$/.test(String(value || ""));
const isSafeAccount = value => Boolean(String(value || "").trim()) && String(value).length <= 150;
const isPaid = row => row?.status === "paid" || row?.status === "partially_refunded" || row?.status === "refunded";
export function raffleCartTotal(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 40) throw Error("Select at least one raffle item (maximum 40).");
  return lines.reduce((sum, line) => {
    const cents = Number(line.priceCents), qty = Number(line.qty);
    if (!Number.isSafeInteger(cents) || cents < 1 || cents > 99999999 ||
        !Number.isSafeInteger(qty) || qty < 1 || qty > 100) throw Error("Invalid raffle price or quantity.");
    const amount = cents * qty;
    if (!Number.isSafeInteger(amount) || amount > 99999999) throw Error("Raffle amount exceeds the permitted payment limit.");
    return sum + amount;
  }, 0);
}
export function raffleAvailableStock(item, orders, now = Date.now()) {
  if (item.stock === null || item.stock === undefined) return null;
  const occupied = (orders || []).filter(order =>
    isPaid(order) || (order.status === "pending" && Date.parse(order.expiresAt) > now))
    .flatMap(order => order.lines || [])
    .filter(line => line.itemId === item.id)
    .reduce((n, line) => n + Math.max(0, Number(line.qty || 0) - Number(line.refundedQty || 0)), 0);
  return Math.max(0, Number(item.stock) - occupied);
}
function summary(order) {
  const paid=order.status==="paid"||order.status==="partially_refunded"||order.status==="refunded";
  return {id:order.id,status:order.status,createdAt:order.createdAt,
    paidAt:order.paidAt||null,totalCents:order.totalCents,
    refundedCents:Number(order.refundedCents||0),
    lines:(order.lines||[]).map(line=>({
      itemId:line.itemId,sku:line.sku||"",name:line.name,qty:line.qty,priceCents:line.priceCents,
      totalCents:line.priceCents*line.qty,refundedCents:Number(line.refundedCents||0),
      refundedQty:Number(line.refundedQty||0)
    })),paymentConfirmed:paid};
}
export function registerTargetRaffleItemPayments({
  app,stripe,requireCustomer,requireAdmin,dataDir,baseUrl,
  getItems,commitPaidOrder,applyOrderRefund,closeItem,getSubscription,getAccounts
}){
  const cartsPath=path.join(dataDir,"target-raffle-carts.json");
  const ordersPath=path.join(dataDir,"target-raffle-orders.json");
  let chain=Promise.resolve();
  function locked(operation){const job=chain.then(operation,operation);chain=job.catch(()=>{});return job;}
  async function read(file,fallback){
    try{return JSON.parse(await fs.readFile(file,"utf8"));}
    catch(error){if(error.code==="ENOENT")return fallback;throw error;}
  }
  async function write(file,value){
    await fs.mkdir(dataDir,{recursive:true,mode:0o700});
    const temp=file+"."+crypto.randomUUID()+".tmp";
    await fs.writeFile(temp,JSON.stringify(value,null,2),{mode:0o600,flag:"wx"});
    await fs.rename(temp,file);
  }
  const carts=async()=>{
    const value=await read(cartsPath,{});
    if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid raffle cart data.");
    return value;
  };
  const orders=async()=>{
    const value=await read(ordersPath,[]);
    if(!Array.isArray(value))throw Error("Invalid raffle order data.");
    return value;
  };
  async function eligible(accountId){
    if(!isSafeAccount(accountId))return false;
    const subscription=await getSubscription(accountId);
    return !!subscription;
  }
  function validCartLines(cart,availableItems){
    const byId=new Map(availableItems.map(item=>[item.id,item]));
    const entries=Object.entries(cart?.selected||{});
    if(entries.length>40)throw Error("Only 40 raffle products can be purchased at a time.");
    const lines=entries.filter(([,qty])=>Number(qty)>0).map(([id,qty])=>{
      const item=byId.get(id),n=Number(qty);
      if(!item||!item.active)throw Error("One selected item is no longer available.");
      if(!Number.isInteger(n)||n<1||n>Number(item.maxQty||20))
        throw Error("One selected quantity exceeds the available per-person limit.");
      return {itemId:id,sku:String(item.sku||""),name:item.name,priceCents:Number(item.priceCents),qty:n,
        refundedCents:0,refundedQty:0};
    });
    if(!lines.length)throw Error("Select your products in #target-raffle-club before paying.");
    raffleCartTotal(lines);
    return lines;
  }
  async function getCart(accountId){
    const [cartItems,availableItems]=await Promise.all([carts(),getItems()]);
    const selected=cartItems[String(accountId)]||{selected:{}};
    let lines=[],error=null;
    try{lines=validCartLines(selected,availableItems);}
    catch(e){error=e.message;}
    return {lines:lines.map(x=>({itemId:x.itemId,name:x.name,
      sku:x.sku,priceCents:x.priceCents,qty:x.qty,subtotalCents:x.priceCents*x.qty})),
      totalCents:lines.length?raffleCartTotal(lines):0,
      error,notice:RAFFLE_REFUND_NOTICE};
  }
  async function setDraft({accountId,userId,itemId,qty}){
    if(!await eligible(accountId))throw Error("Active Raffle Club membership is required.");
    if(!isId(itemId)||!Number.isInteger(qty)||qty<0||qty>100)
      throw Error("Invalid item or quantity.");
    return locked(async()=>{
      const item=(await getItems()).find(x=>x.id===itemId);
      if(!item||!item.active)throw Error("This item queue is closed.");
      if(qty>Number(item.maxQty||20))throw Error("Quantity exceeds the per-person limit.");
      const rows=await carts(),record=rows[String(accountId)]||{selected:{}};
      record.selected=record.selected||{};
      if(qty)record.selected[itemId]=qty;
      else delete record.selected[itemId];
      record.userId=String(userId);
      record.updatedAt=new Date().toISOString();
      rows[String(accountId)]=record;
      await write(cartsPath,rows);
      return getCart(accountId);
    });
  }
  async function payCart(account){
    if(!await eligible(account.id))throw Error("Active Raffle Club subscription is required.");
    return locked(async()=>{
      const [allCarts,availableItems,allOrders]=await Promise.all([carts(),getItems(),orders()]);
      const cart=allCarts[String(account.id)]||{selected:{}};
      const lines=validCartLines(cart,availableItems);
      const totalCents=raffleCartTotal(lines);
      if(totalCents>99999999)throw Error("Selected item amount exceeds the maximum.");
      const now=Date.now(),nowIso=new Date(now).toISOString();
      const sameLines=(left,right)=>JSON.stringify((left||[]).map(x=>[x.itemId,x.qty,x.priceCents]).sort())===
        JSON.stringify((right||[]).map(x=>[x.itemId,x.qty,x.priceCents]).sort());
      const existing=allOrders.find(order=>order.accountId===String(account.id) &&
        order.status==="pending" && Date.parse(order.expiresAt)>now+30000 &&
        order.checkoutUrl && sameLines(order.lines,lines));
      if(existing)return {url:existing.checkoutUrl,orderId:existing.id,
        totalCents:existing.totalCents,
        lines:existing.lines.map(x=>({name:x.name,qty:x.qty,priceCents:x.priceCents}))};
      for(const line of lines){
        const item=availableItems.find(x=>x.id===line.itemId);
        const left=raffleAvailableStock(item,allOrders,now);
        if(left!==null && line.qty>left)
          throw Error("Insufficient available units for "+line.name+". Only "+left+" remain.");
      }
      const orderId=crypto.randomUUID();
      const order={id:orderId,accountId:String(account.id),
        discordUserId:String(cart.userId||account.discordUserId||""),
        status:"pending",createdAt:nowIso,expiresAt:new Date(now+30*60000).toISOString(),
        totalCents,refundedCents:0,lines,refunds:[],stripeSessionId:null,paymentIntentId:null};
      allOrders.push(order);
      await write(ordersPath,allOrders);
      try{
        const session=await stripe.checkout.sessions.create({
          mode:"payment",
          client_reference_id:String(account.id),
          customer_email:account.email,
          line_items:lines.map(line=>({
            price_data:{currency:"usd",unit_amount:line.priceCents,
              product_data:{name:line.name.slice(0,160),description:"Target SKU: "+(line.sku||"unlisted")}},
            quantity:line.qty
          })),
          expires_at:Math.floor((now+30*60000)/1000),
          success_url:baseUrl+"/target-raffle-club.html?items=success&session_id={CHECKOUT_SESSION_ID}",
          cancel_url:baseUrl+"/target-raffle-club.html?items=cancelled",
          metadata:{purchase_type:"target_raffle_items",raffle_order_id:orderId,
            customer_account_id:String(account.id)},
          payment_intent_data:{metadata:{purchase_type:"target_raffle_items",
            raffle_order_id:orderId,customer_account_id:String(account.id)}},
          custom_text:{submit:{message:RAFFLE_REFUND_NOTICE}}
        },{idempotencyKey:"raffle-item-checkout-"+orderId});
        if(!session?.id||!/^https:\/\/checkout\.stripe\.com\//.test(session.url||""))
          throw Error("Checkout did not return a secure payment URL.");
        order.stripeSessionId=session.id;
        order.checkoutUrl=session.url;
        order.expiresAt=new Date(Number(session.expires_at||Math.floor((now+30*60000)/1000))*1000).toISOString();
        await write(ordersPath,allOrders);
        return {url:session.url,orderId,totalCents,lines:lines.map(x=>({name:x.name,qty:x.qty,priceCents:x.priceCents}))};
      }catch(error){
        order.status="checkout_failed";order.checkoutErrorAt=new Date().toISOString();
        await write(ordersPath,allOrders);
        throw error;
      }
    });
  }
  async function onStripeEvent(event){
    const session=event?.data?.object||{};
    if(!["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event?.type) ||
      session.metadata?.purchase_type!=="target_raffle_items")return false;
    if(session.payment_status!=="paid")return true;
    const id=String(session.metadata?.raffle_order_id||"");
    const paidOrder=await locked(async()=>{
      const all=await orders(),order=all.find(x=>x.id===id);
      if(!order)throw Error("Paid raffle checkout order not found.");
      if(isPaid(order))return {...order};
      if(order.status!=="pending"&&order.status!=="checkout_failed")
        throw Error("Raffle checkout was not in a payable state.");
      if(order.stripeSessionId!==String(session.id) ||
        order.accountId!==String(session.metadata.customer_account_id) ||
        order.accountId!==String(session.client_reference_id) ||
        Number(session.amount_total)!==Number(order.totalCents) ||
        session.currency!=="usd"||session.mode!=="payment"||!session.payment_intent)
        throw Error("Raffle paid checkout failed integrity verification.");
      const paidAt=new Date(Number(event.created||Math.floor(Date.now()/1000))*1000).toISOString();
      const updated={...order,status:"paid",paidAt,updatedAt:new Date().toISOString(),
        paymentIntentId:typeof session.payment_intent==="string"?
          session.payment_intent:session.payment_intent.id,checkoutUrl:null};
      await commitPaidOrder(updated);
      Object.assign(order,updated);
      await write(ordersPath,all);
      const allCarts=await carts(),cart=allCarts[order.accountId];
      if(cart){
        for(const line of order.lines)
          if(Number(cart.selected?.[line.itemId])===line.qty)delete cart.selected[line.itemId];
        await write(cartsPath,allCarts);
      }
      return {...order};
    });
    // A draw may be canceled while a member is still on Stripe Checkout.
    // Accept the verified payment, then refund its affected SKU(s) even if
    // this webhook arrives after the owner canceled the draw.
    const byId=new Map((await getItems()).map(item=>[item.id,item]));
    for(const line of paidOrder.lines){
      if(!byId.get(line.itemId)?.drawCanceledAt)continue;
      const remaining=line.priceCents*line.qty-Number(line.refundedCents||0);
      if(remaining<=0)continue;
      await refund({orderId:paidOrder.id,
        requestId:"auto-cancel-"+line.itemId+"-"+paidOrder.id,
        itemId:line.itemId,amountCents:remaining,reason:"target_draw_canceled",
        adminId:"automatic_draw_cancellation"});
    }
    return true;
  }
  async function refund({orderId,requestId,itemId,amountCents,reason,adminId}){
    if(!isRequestId(requestId)||!Number.isSafeInteger(amountCents)||amountCents<1)
      throw Error("Enter a valid refund amount and unique request ID.");
    return locked(async()=>{
      const all=await orders(),order=all.find(x=>x.id===orderId);
      if(!order||!isPaid(order)||!order.paymentIntentId)
        throw Error("Only verified paid raffle orders can be refunded.");
      const past=(order.refunds||[]).find(x=>x.requestId===requestId);
      if(past){
        if(past.amountCents!==amountCents||past.itemId!==String(itemId||"all"))
          throw Error("The refund request ID was already used for a different amount.");
        await applyOrderRefund(order);
        return {order:summary(order),refundId:past.refundId,idempotent:true};
      }
      const remaining=order.totalCents-Number(order.refundedCents||0);
      const chosen=String(itemId||"all");
      if(amountCents>remaining)throw Error("Refund exceeds the remaining paid amount.");
      if(chosen!=="all"){
        const line=order.lines.find(x=>x.itemId===chosen);
        if(!line)throw Error("Refund item is not part of this order.");
        const itemRemaining=line.priceCents*line.qty-Number(line.refundedCents||0);
        if(amountCents>itemRemaining)throw Error("Refund exceeds the remaining amount on this item.");
      }else if(amountCents!==remaining){
        throw Error("Choose a specific item for a partial refund, or refund the full remaining order.");
      }
      const cleanReason=String(reason||"cancelled").replace(/[\r\n<>]/g," ").slice(0,120);
      const stripeRefund=await stripe.refunds.create({
        payment_intent:order.paymentIntentId,amount:amountCents,
        metadata:{raffle_order_id:order.id,refund_reason:cleanReason,
          raffle_item_id:chosen,admin_id:String(adminId||"website").slice(0,100)}
      },{idempotencyKey:"target-raffle-refund-"+order.id+"-"+chosen+"-"+amountCents+"-"+Number(order.refundedCents||0)});
      if(!stripeRefund?.id||stripeRefund.status==="failed")
        throw Error("Stripe did not accept the refund.");
      let toAllocate=amountCents;
      const touched=chosen==="all"?order.lines:[order.lines.find(x=>x.itemId===chosen)];
      for(const line of touched){
        const still=line.priceCents*line.qty-Number(line.refundedCents||0);
        const amount=Math.min(still,toAllocate);
        line.refundedCents=Number(line.refundedCents||0)+amount;
        line.refundedQty=Math.min(line.qty,Math.floor(line.refundedCents/line.priceCents));
        toAllocate-=amount;
        if(!toAllocate)break;
      }
      order.refundedCents=Number(order.refundedCents||0)+amountCents;
      order.refunds.push({
        requestId,refundId:stripeRefund.id,itemId:chosen,
        amountCents,status:stripeRefund.status,reason:cleanReason,
        requestedBy:String(adminId||"website"),createdAt:new Date().toISOString()
      });
      order.status=order.refundedCents>=order.totalCents?"refunded":"partially_refunded";
      order.updatedAt=new Date().toISOString();
      await write(ordersPath,all);
      await applyOrderRefund(order);
      return {order:summary(order),refundId:stripeRefund.id,status:stripeRefund.status};
    });
  }
  async function cancelAndRefundItem(itemId){
    if(!isId(itemId))throw Error("Invalid raffle product.");
    const item=(await getItems()).find(row=>row.id===itemId);
    if(!item)throw Error("This raffle product no longer exists.");
    await closeItem(itemId);
    const paid=(await orders()).filter(order=>isPaid(order)&&order.paymentIntentId&&
      order.lines.some(line=>line.itemId===itemId&&line.priceCents*line.qty>Number(line.refundedCents||0)));
    const completed=[],failures=[];
    for(const order of paid){
      const line=order.lines.find(line=>line.itemId===itemId);
      const amount=line.qty*line.priceCents-Number(line.refundedCents||0);
      try{
        const result=await refund({orderId:order.id,
          requestId:"cancel-"+itemId+"-"+order.id,
          itemId,amountCents:amount,reason:"target_draw_canceled",adminId:"owner_cancel_draw"});
        completed.push({orderId:order.id,refundId:result.refundId,amountCents:amount,status:result.status});
      }catch(error){
        failures.push({orderId:order.id,reason:String(error.message||"Refund failed").slice(0,150)});
      }
    }
    return {closed:true,refunded:completed,failures};
  }
  app.post("/api/account/raffle-club/items/claim",requireCustomer,async(req,res)=>{
    try{
      const sessionId=String(req.body?.sessionId||"");
      if(!/^cs_(?:test_)?[A-Za-z0-9_]{12,150}$/.test(sessionId))
        return res.status(400).json({error:"Invalid payment session."});
      const session=await stripe.checkout.sessions.retrieve(sessionId);
      if(session.mode!=="payment"||session.metadata?.purchase_type!=="target_raffle_items"||
        String(session.metadata?.customer_account_id)!==String(req.customerAccount.id))
        return res.status(403).json({error:"This payment does not belong to your account."});
      if(session.payment_status==="paid")
        await onStripeEvent({type:"checkout.session.completed",created:Math.floor(Date.now()/1000),
          data:{object:session}});
      const order=(await orders()).find(x=>x.stripeSessionId===session.id);
      if(!order || String(order.accountId)!==String(req.customerAccount.id))
        return res.status(404).json({error:"Payment record was not found."});
      res.json({order:summary(order),confirmed:order.status==="paid"});
    }catch(error){
      console.error("Raffle paid item claim:",error.message);
      res.status(503).json({error:"Your payment is being verified. Refresh your orders shortly."});
    }
  });
  app.get("/api/account/raffle-club/cart",requireCustomer,async(req,res)=>{
    try{
      if(!await eligible(req.customerAccount.id))
        return res.status(403).json({error:"Active Raffle Club membership required."});
      res.setHeader("Cache-Control","no-store");
      res.json(await getCart(req.customerAccount.id));
    }catch(error){res.status(503).json({error:"Raffle cart could not be loaded."});}
  });
  app.post("/api/account/raffle-club/items/checkout",requireCustomer,async(req,res)=>{
    if(req.body?.acknowledgeRefundPolicy!==true)
      return res.status(400).json({error:"Please acknowledge the cancellation and refund notice."});
    try{
      const result=await payCart(req.customerAccount);
      res.json(result);
    }catch(error){
      console.error("Raffle product checkout:",error.message);
      res.status(/required|Invalid|Insufficient|Select|closed|exceeds|no longer/.test(error.message)?409:502)
        .json({error:error.message});
    }
  });
  app.get("/api/account/raffle-club/orders",requireCustomer,async(req,res)=>{
    try{
      // Past buyers must retain access to payment/refund records after membership ends.
      const rows=await orders();
      res.setHeader("Cache-Control","no-store");
      res.json({orders:rows.filter(x=>x.accountId===String(req.customerAccount.id))
        .map(summary).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
    }catch(error){res.status(503).json({error:"Order history unavailable."});}
  });
  app.get("/api/admin/raffle-club/orders",requireAdmin,async(_req,res)=>{
    try{
      const [all,accounts]=await Promise.all([orders(),getAccounts()]);
      const byId=new Map(accounts.map(x=>[String(x.id),x]));
      res.setHeader("Cache-Control","no-store");
      res.json({orders:all.map(order=>({...summary(order),
        accountId:order.accountId,customerEmail:byId.get(String(order.accountId))?.email||"",
        paymentIntentId:order.paymentIntentId,refunds:order.refunds||[],
        discordUserId:order.discordUserId||""
      })).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
    }catch(error){res.status(503).json({error:"Raffle payment records unavailable."});}
  });
  app.post("/api/admin/raffle-club/orders/:id/refund",requireAdmin,async(req,res)=>{
    try{
      const amount=Number(req.body?.amountCents);
      const result=await refund({
        orderId:String(req.params.id||""),requestId:String(req.body?.requestId||""),
        itemId:String(req.body?.itemId||"all"),amountCents:amount,
        reason:req.body?.reason,adminId:"website-admin"
      });
      res.json(result);
    }catch(error){
      console.error("Raffle refund:",error.message);
      res.status(409).json({error:error.message||"Refund unsuccessful."});
    }
  });
  app.post("/api/admin/raffle-club/items/:id/cancel-and-refund",requireAdmin,async(req,res)=>{
    try{
      if(req.body?.confirmCancellation!==true)
        return res.status(400).json({error:"Confirm that this draw was cancelled and buyers must be refunded."});
      const result=await cancelAndRefundItem(String(req.params.id||""));
      res.status(result.failures.length?207:200).json(result);
    }catch(error){
      console.error("Raffle draw cancellation refunds:",error.message);
      res.status(503).json({error:error.message||"Could not process draw refunds."});
    }
  });
  return {setDraft,getCart,orders,onStripeEvent};
}
