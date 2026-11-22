(function () {
"use strict";
const $=id=>document.getElementById(id);
const status=$("club-status"),note=$("club-note"),join=$("club-join"),
  manage=$("club-manage"),signIn=$("club-signin"),
  panel=$("club-queue-panel"),queue=$("club-queue"),
  checkout=$("club-checkout"),cartList=$("club-cart"),cartTotal=$("club-cart-total"),
  ack=$("club-refund-ack"),pay=$("club-pay"),paymentMessage=$("club-payment-message"),
  ordersPanel=$("club-orders-panel"),ordersList=$("club-orders");
const params=new URLSearchParams(location.search);
const cash=c=>"$"+(Number(c||0)/100).toFixed(2);
let cartFingerprint="", cartLines=[];
function node(tag,text,className){
  const el=document.createElement(tag);
  if(text!==undefined)el.textContent=String(text);
  if(className)el.className=className;
  return el;
}
function clear(el){el.replaceChildren();}
async function request(url,options={}){
  const res=await fetch(url,{credentials:"same-origin",cache:"no-store",...options});
  const data=await res.json().catch(()=>({}));
  if(!res.ok){
    const error=Error(data.error||"Please try again.");
    error.status=res.status;throw error;
  }
  return data;
}
const send=(url,body={})=>request(url,{method:"POST",
  headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
function message(text){status.textContent=String(text);}
function updatePayButton(){
  pay.disabled=!cartLines.length||!ack.checked;
  pay.textContent=cartLines.length?"Pay "+cash(cartLines.reduce((n,x)=>n+x.subtotalCents,0))+" on Website":
    "Select SKUs in Discord first";
}
async function refreshCart(){
  const data=await request("/api/account/raffle-club/cart");
  cartLines=Array.isArray(data.lines)?data.lines:[];
  const next=JSON.stringify(cartLines.map(x=>[x.itemId,x.qty,x.priceCents]));
  if(next!==cartFingerprint){ack.checked=false;cartFingerprint=next;}
  clear(cartList);
  if(!cartLines.length){
    cartList.append(node("p","Your cart is empty. Select one or more SKUs using the buttons in #target-raffle-club, then return here to pay."));
  }else{
    const list=node("div",undefined,"cart-lines");
    for(const line of cartLines){
      const row=node("div",undefined,"cart-line");
      row.append(node("strong",line.name));
      row.append(node("span",cash(line.priceCents)+" × "+line.qty+" = "+cash(line.subtotalCents)));
      list.append(row);
    }
    cartList.append(list);
  }
  cartTotal.textContent="Selected item total: "+cash(data.totalCents);
  updatePayButton();
}
async function renderQueue(){
  const data=await request("/api/account/raffle-club/queue");
  clear(queue);
  const items=Array.isArray(data.items)?data.items:[];
  if(!items.length){
    queue.append(node("p","No paid item queues are available yet. The owner will post SKU prices in Discord."));
    return;
  }
  for(const item of items){
    const card=node("article",undefined,"queue-item");
    card.append(node("h3",item.name));
    card.append(node("p",cash(item.priceCents)+" each · "+(item.active?"Open":"Closed")+
      " · "+(item.queue||[]).length+" paid orders","meta"));
    const entries=Array.isArray(item.queue)?item.queue:[];
    if(!entries.length)card.append(node("p","No paid requests have entered this queue."));
    else{
      const list=node("ol");
      for(const entry of entries){
        const itemRow=node("li",(entry.name||"Member")+" — "+entry.qty+" paid unit(s)"+(entry.mine?" · YOUR PAID ORDER":""));
        if(entry.mine)itemRow.className="mine";
        list.append(itemRow);
      }
      card.append(list);
    }
    queue.append(card);
  }
}
async function renderOrders(){
  const data=await request("/api/account/raffle-club/orders");
  const orders=Array.isArray(data.orders)?data.orders:[];
  clear(ordersList);
  if(!orders.length){ordersList.append(node("p","No product payments have been made yet."));return;}
  for(const order of orders){
    const card=node("article",undefined,"queue-item");
    card.append(node("h3","Payment "+String(order.id).slice(0,8)+" · "+cash(order.totalCents)));
    const status=String(order.status||"pending").replaceAll("_"," ");
    const time=order.paidAt||order.createdAt;
    card.append(node("p",status.toUpperCase()+" · "+(time?new Date(time).toLocaleString():"")+" · Refunded "+cash(order.refundedCents),"meta"));
    const rows=node("ul");
    for(const line of order.lines||[]){
      const li=node("li",line.name+" · "+line.qty+" × "+cash(line.priceCents)+
        (line.refundedCents?" · Refunded "+cash(line.refundedCents):""));
      rows.append(li);
    }
    card.append(rows);
    ordersList.append(card);
  }
}
async function reload(){
  join.disabled=true;
  try{
    const [offer,session]=await Promise.all([
      request("/api/public/raffle-club/offer"),
      request("/api/account/raffle-club/status").catch(e=>{if(e.status===401)return null;throw e;})
    ]);
    if(!session){
      message("Sign in or create a website account to join.");
      note.textContent="Active ACO members qualify for $5/month; standalone subscribers pay $20/month.";
      signIn.hidden=false;manage.hidden=true;join.hidden=true;
      panel.hidden=true;checkout.hidden=true;ordersPanel.hidden=true;
      return;
    }
    ordersPanel.hidden=false;
    void renderOrders().catch(e=>{clear(ordersList);ordersList.append(node("p",e.message));});
    signIn.hidden=true;
    if(session.active){
      message("Target Raffle Club is active"+(session.plan==="member"?" — $5/month add-on.":" — $20/month standalone."));
      note.textContent=session.discordLinked?
        "Your Discord is linked. Choose SKU quantities there, then pay for all selections below.":
        "Link your Discord account in My Profile before selecting SKUs in the private channel.";
      join.hidden=true;manage.hidden=false;checkout.hidden=false;panel.hidden=false;
      await Promise.all([refreshCart(),renderQueue()]);
      return;
    }
    checkout.hidden=true;panel.hidden=true;manage.hidden=true;join.hidden=false;
    const price=session.memberEligible?5:20;
    message("Your Target Raffle Club membership is $"+price+"/month.");
    note.textContent=session.memberEligible?"Your ACO profile membership remains unchanged; raffle items are billed separately.":
      "The standalone plan does not include ACO profiles. Raffle item purchases are separate from the monthly fee.";
    if(!offer.available){
      join.textContent="Club checkout not yet available";join.disabled=true;
      note.textContent+=" Subscription billing is being configured.";
    }else{
      join.textContent="Join for $"+price+"/month";join.disabled=false;
    }
  }catch(e){
    message("Unable to verify membership right now.");
    note.textContent=e.message||"Please try again.";
    join.disabled=true;manage.hidden=true;checkout.hidden=true;panel.hidden=true;
  }
}
join.addEventListener("click",async()=>{
  join.disabled=true;join.textContent="Preparing checkout…";
  try{
    const data=await send("/api/account/raffle-club/checkout");
    if(!/^https:\/\/checkout\.stripe\.com\//.test(data.url||""))throw Error("Invalid secure Stripe Checkout URL.");
    location.assign(data.url);
  }catch(e){message(e.message);await reload();}
});
manage.addEventListener("click",async()=>{
  manage.disabled=true;
  try{
    const data=await send("/api/account/raffle-club/manage");
    if(!/^https:\/\/billing\.stripe\.com\//.test(data.url||""))throw Error("Invalid Stripe billing portal URL.");
    location.assign(data.url);
  }catch(e){message(e.message);manage.disabled=false;}
});
ack.addEventListener("change",updatePayButton);
pay.addEventListener("click",async()=>{
  if(!cartLines.length||!ack.checked)return;
  pay.disabled=true;paymentMessage.textContent="Preparing your selected SKUs for secure payment…";
  try{
    const result=await send("/api/account/raffle-club/items/checkout",{acknowledgeRefundPolicy:true});
    if(!/^https:\/\/checkout\.stripe\.com\//.test(result.url||""))throw Error("Invalid secure payment URL.");
    location.assign(result.url);
  }catch(e){
    paymentMessage.textContent=e.message;
    await refreshCart().catch(()=>{});updatePayButton();
  }
});
$("club-refresh").addEventListener("click",()=>void renderQueue().catch(e=>message(e.message)));
$("club-cart-refresh").addEventListener("click",()=>void refreshCart().catch(e=>paymentMessage.textContent=e.message));
$("club-orders-refresh").addEventListener("click",()=>void renderOrders().catch(e=>message(e.message)));
async function start(){
  if(params.get("raffle")==="success"&&params.has("session_id")){
    try{
      const result=await send("/api/account/raffle-club/claim",{sessionId:params.get("session_id")});
      message(result.active?"Club subscription confirmed.":"Subscription payment is still being verified.");
    }catch{message("Club subscription is being confirmed. Refresh the page shortly.");}
    history.replaceState(null,"",location.pathname+location.hash);
  }else if(params.get("items")==="success"&&params.has("session_id")){
    try{
      const result=await send("/api/account/raffle-club/items/claim",{sessionId:params.get("session_id")});
      paymentMessage.textContent=result.order?.paymentConfirmed?
        "Product payment confirmed. Your paid queue positions are recorded.":
        "Product payment is still being verified. Please refresh your order history.";
    }catch(e){paymentMessage.textContent="Payment verification in progress. "+e.message;}
    history.replaceState(null,"",location.pathname+"#club-orders-panel");
  }else if(params.get("items")==="cancelled"){
    paymentMessage.textContent="Checkout canceled. Your unpaid SKU selections remain in your cart.";
    history.replaceState(null,"",location.pathname+"#club-checkout");
  }
  await reload();
}
void start();
setInterval(()=>{
  if(document.visibilityState!=="visible")return;
  if(!panel.hidden)void renderQueue().catch(()=>{});
  if(!checkout.hidden)void refreshCart().catch(()=>{});
  if(!ordersPanel.hidden)void renderOrders().catch(()=>{});
},20000);
})();