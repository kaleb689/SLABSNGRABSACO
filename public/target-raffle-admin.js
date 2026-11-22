(function(){
"use strict";
const $=id=>document.getElementById(id);
const msg=$("raffle-admin-message"),items=$("raffle-admin-items"),
  subs=$("raffle-admin-subscribers"),payments=$("raffle-admin-orders");
const cash=n=>"$"+(Number(n||0)/100).toFixed(2);
function node(tag,text,className){
  const el=document.createElement(tag);
  if(text!==undefined)el.textContent=String(text);
  if(className)el.className=className;
  return el;
}
const clear=el=>el.replaceChildren();
async function api(url,options={}){
  const r=await fetch(url,{credentials:"same-origin",cache:"no-store",...options});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.error||(r.status===401?
    "Admin login required. Sign in through the admin portal first.":"Operation failed."));
  return data;
}
const post=(url,body)=>api(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
function table(head,rows){
  const wrap=node("div",undefined,"raffle-rows"),t=node("table",undefined,"raffle-table");
  const header=node("tr");
  for(const text of head)header.append(node("th",text));
  t.append(header);
  for(const row of rows){
    const tr=node("tr");
    for(const value of row)tr.append(node("td",value));
    t.append(tr);
  }
  wrap.append(t);return wrap;
}
function button(text,callback,className="secondary"){
  const b=node("button",text,className);
  b.type="button";b.addEventListener("click",callback);return b;
}
function refundControls(order){
  const card=node("article",undefined,"queue-item");
  const refundable=Math.max(0,Number(order.totalCents||0)-Number(order.refundedCents||0));
  card.append(node("h3","Order "+order.id.slice(0,8)+" · "+cash(order.totalCents)));
  card.append(node("p",(order.customerEmail||"Account "+order.accountId)+" · "+
    String(order.status||"pending").toUpperCase().replaceAll("_"," ")+" · "+
    "Refunded "+cash(order.refundedCents)+" · Remaining "+cash(refundable),"raffle-payment-meta"));
  if(order.lines?.length){
    card.append(table(["SKU / Item","Quantity","Paid","Already refunded","Remaining"],order.lines.map(line=>[
      line.name,line.qty,cash(line.totalCents),cash(line.refundedCents),
      cash(Math.max(0,line.totalCents-line.refundedCents))
    ])));
  }
  if(order.refunds?.length){
    card.append(node("p","Refund history","raffle-warning"));
    card.append(table(["Date","Amount","Stripe status","Reason","Refund ID"],order.refunds.map(r=>[
      new Date(r.createdAt).toLocaleString(),cash(r.amountCents),r.status,
      r.reason||"—",r.refundId||"—"
    ])));
  }
  if(!refundable||!["paid","partially_refunded"].includes(order.status))return card;
  const form=node("form",undefined,"raffle-refund-form");
  const targetLabel=node("label","Refund scope"),select=node("select");
  const all=node("option","Entire remaining order");
  all.value="all";select.append(all);
  for(const line of order.lines||[]){
    const amount=Math.max(0,Number(line.totalCents)-Number(line.refundedCents));
    if(amount<1)continue;
    const option=node("option",line.name+" — up to "+cash(amount));
    option.value=line.itemId;select.append(option);
  }
  targetLabel.append(select);form.append(targetLabel);
  const amountLabel=node("label","Refund amount (USD)"),amountInput=node("input");
  amountInput.type="number";amountInput.step=".01";amountInput.min=".01";
  amountInput.required=true;amountLabel.append(amountInput);form.append(amountLabel);
  const reasonLabel=node("label","Reason"),reasonInput=node("input");
  reasonInput.type="text";reasonInput.maxLength=120;
  reasonInput.placeholder="Retailer canceled the draw order";
  reasonInput.value="target_draw_order_canceled";reasonLabel.append(reasonInput);form.append(reasonLabel);
  const action=button("Issue Stripe Refund",()=>{},"raffle-danger");
  action.type="submit";form.append(action);
  const maxFor=()=>select.value==="all"?refundable:Math.max(0,
    Number(order.lines.find(line=>line.itemId===select.value)?.totalCents||0)-
    Number(order.lines.find(line=>line.itemId===select.value)?.refundedCents||0));
  const setMaximum=()=>{
    const limit=maxFor();
    amountInput.value=(limit/100).toFixed(2);
    amountInput.max=(limit/100).toFixed(2);
    amountInput.disabled=select.value==="all";
  };
  select.addEventListener("change",setMaximum);setMaximum();
  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const amountCents=Math.round(Number(amountInput.value)*100),limit=maxFor();
    if(!Number.isInteger(amountCents)||amountCents<1||amountCents>limit){
      msg.textContent="Refund amount must be within the selected item's remaining paid balance.";return;
    }
    if(select.value==="all"&&amountCents!==limit){
      msg.textContent="A full order refund must match the entire remaining paid balance.";return;
    }
    const name=select.value==="all"?"this entire remaining order":
      order.lines.find(line=>line.itemId===select.value)?.name||"this item";
    if(!confirm("Issue a "+cash(amountCents)+" Stripe refund for "+name+
      "? This sends real funds back to the buyer and cannot be undone."))return;
    action.disabled=true;msg.textContent="Submitting refund to Stripe…";
    try{
      const result=await post("/api/admin/raffle-club/orders/"+encodeURIComponent(order.id)+"/refund",{
        requestId:crypto.randomUUID(),itemId:select.value,
        amountCents,reason:reasonInput.value.trim()||"target_draw_order_canceled"
      });
      msg.textContent="Stripe refund "+result.status+" · "+cash(amountCents)+
        " · "+result.refundId;
      await refresh();
    }catch(error){msg.textContent=error.message;action.disabled=false;}
  });
  card.append(form);return card;
}
async function refresh(){
  msg.textContent="Loading Target Raffle Club…";
  try{
    const [data,ledger]=await Promise.all([
      api("/api/admin/raffle-club/items"),api("/api/admin/raffle-club/orders")
    ]);
    clear(items);clear(subs);clear(payments);
    if(!data.items.length)items.append(node("p","No raffle items have been posted yet."));
    for(const item of data.items){
      const card=node("article",undefined,"queue-item");
      card.append(node("h3",item.name+" · "+cash(item.priceCents)+" each"));
      card.append(node("p",(item.active?"OPEN":"CLOSED")+" · "+item.entries.length+
        " paid requests · "+item.entries.reduce((n,x)=>n+x.qty,0)+" paid units"+
        (item.stock===null?" · stock unspecified":" · "+item.stock+" stock"),"meta"));
      if(item.active){
        card.append(button("Close New Purchases",async()=>{
          if(!confirm("Close "+item.name+" for new payments? This will not refund existing purchases."))return;
          try{await post("/api/admin/raffle-club/items/"+encodeURIComponent(item.id)+"/close",{});await refresh();}
          catch(e){msg.textContent=e.message;}
        }));
      }
      card.append(button("Cancel Draw & Refund All Buyers",async()=>{
        if(!confirm("Cancel "+item.name+" and refund ALL paid amounts for that product? This is irreversible."))return;
        if(!confirm("Confirm the Target draw/order was canceled and all affected item payments must be refunded."))return;
        msg.textContent="Closing draw and requesting refunds for all buyers…";
        try{
          const result=await post("/api/admin/raffle-club/items/"+encodeURIComponent(item.id)+"/cancel-and-refund",
            {confirmCancellation:true});
          msg.textContent="Draw closed. Refunded "+result.refunded.length+" buyer(s)."+
            (result.failures.length?" "+result.failures.length+" refund(s) need attention; retry after checking Stripe.":"");
          await refresh();
        }catch(e){msg.textContent=e.message;}
      },"raffle-danger"));
      if(!item.entries.length)card.append(node("p","No paid entries yet."));
      else card.append(table(["Queue","Member","Customer email","Paid units","SKU amount"],item.entries.map(x=>[
        "#"+x.position,(x.name||"Member")+" ("+(x.userId||"unlinked")+")",
        x.customerEmail||"—",x.qty,cash(x.qty*item.priceCents)
      ])));
      items.append(card);
    }
    if(!data.subscribers.length)subs.append(node("p","No paid subscribers yet."));
    else subs.append(table(["Account","Plan","Status"],data.subscribers.map(s=>[
      s.accountId,s.plan==="member"?"$5 ACO add-on":"$20 standalone",s.status
    ])));
    if(!ledger.orders.length)payments.append(node("p","No raffle item payment attempts yet."));
    else for(const order of ledger.orders)payments.append(refundControls(order));
    msg.textContent="Paid queue and payment ledger refreshed.";
  }catch(e){
    msg.textContent=e.message;
    clear(items);items.append(node("p","Sign in through the admin portal and refresh."));
  }
}
$("raffle-admin-create").addEventListener("submit",async e=>{
  e.preventDefault();
  const form=e.currentTarget,btn=$("raffle-admin-post"),fields=new FormData(form),
    value=String(fields.get("price")||"");
  if(!/^\d+(?:\.\d{1,2})?$/.test(value)){
    msg.textContent="Enter a price with no more than two decimal places.";return;
  }
  btn.disabled=true;msg.textContent="Posting SKU to Discord…";
  try{
    await post("/api/admin/raffle-club/items",{
      name:String(fields.get("name")||"").trim(),
      priceCents:Math.round(Number(value)*100),
      stock:fields.get("stock")===""?null:Number(fields.get("stock")),
      maxQty:Number(fields.get("maxQty")||20)
    });
    form.reset();await refresh();
  }catch(error){msg.textContent=error.message;}
  finally{btn.disabled=false;}
});
$("raffle-admin-refresh").addEventListener("click",refresh);
$("raffle-admin-orders-refresh").addEventListener("click",refresh);
void refresh();
})();