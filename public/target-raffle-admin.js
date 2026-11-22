(function(){
"use strict";
const $=id=>document.getElementById(id);
const msg=$("raffle-admin-message"),items=$("raffle-admin-items"),subs=$("raffle-admin-subscribers");
const price=n=>"$"+(Number(n||0)/100).toFixed(2);
function node(tag,content,className){const n=document.createElement(tag);if(content!==undefined)n.textContent=String(content);
if(className)n.className=className;return n;}
function clear(el){while(el.firstChild)el.removeChild(el.firstChild);}
async function api(url,options={}){
const r=await fetch(url,{credentials:"same-origin",cache:"no-store",...options});
const data=await r.json().catch(()=>({}));
if(!r.ok)throw Error(data.error||(r.status===401?"Admin login required. Open the admin portal first.":"Operation failed."));
return data;
}
async function post(url,body){return api(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});}
function table(head,rows){
const wrap=node("div",undefined,"raffle-rows"),t=node("table",undefined,"raffle-table");
const header=node("tr");
for(const label of head)header.append(node("th",label));
t.append(header);
for(const row of rows){const tr=node("tr");for(const value of row)tr.append(node("td",value));t.append(tr);}
wrap.append(t);return wrap;
}
async function refresh(){
msg.textContent="Loading Target Raffle Club…";
try{
const data=await api("/api/admin/raffle-club/items");
clear(items);clear(subs);
if(!data.items.length)items.append(node("p","No raffle items have been posted yet."));
for(const item of data.items){
 const card=node("article",undefined,"queue-item");
 const top=node("h3",item.name+" · "+price(item.priceCents)+" each");
 card.append(top);
 const summary=node("p", (item.active?"OPEN":"CLOSED")+" · "+item.entries.length+" people · "+item.entries.reduce((n,x)=>n+x.qty,0)+" requested units"+(item.stock?" · "+item.stock+" stock":" · stock unspecified"),"meta");
 card.append(summary);
 if(item.active){
  const button=node("button","Close Queue","secondary");
  button.addEventListener("click",async()=>{
   if(!confirm("Close "+item.name+"? No more quantities can be submitted."))return;
   button.disabled=true;
   try{await post("/api/admin/raffle-club/items/"+encodeURIComponent(item.id)+"/close",{});await refresh();}
   catch(e){msg.textContent=e.message;button.disabled=false;}
  });
  card.append(button);
 }
 if(!item.entries.length)card.append(node("p","No requests yet."));
 else card.append(table(["Position","Discord user","Customer email","Quantity","Item total"],item.entries.map(x=>[
  "#"+x.position,x.name+" ("+x.userId+")",x.customerEmail||"—",x.qty,price(x.qty*item.priceCents)
 ])));
 items.append(card);
}
if(!data.subscribers.length)subs.append(node("p","No paid subscribers yet."));
else subs.append(table(["Account","Plan","Subscription status"],data.subscribers.map(s=>[
 s.accountId,s.plan==="member"?"$5 ACO add-on":"$20 standalone",s.status
])));
msg.textContent="Queue data refreshed.";
}catch(e){msg.textContent=e.message;clear(items);items.append(node("p","Sign in through the admin portal and refresh."));}
}
$("raffle-admin-create").addEventListener("submit",async e=>{
e.preventDefault();
const f=e.currentTarget,btn=$("raffle-admin-post"),v=new FormData(f),priceText=String(v.get("price")||"");
if(!/^\d+(?:\.\d{1,2})?$/.test(priceText)){msg.textContent="Enter a price with no more than two decimal places.";return;}
btn.disabled=true;msg.textContent="Posting item to Discord…";
try{
await post("/api/admin/raffle-club/items",{
 name:String(v.get("name")||"").trim(),priceCents:Math.round(Number(priceText)*100),
 stock:v.get("stock")===""?null:Number(v.get("stock")),
 maxQty:Number(v.get("maxQty")||20)
});
f.reset();msg.textContent="Item posted and queue opened.";await refresh();
}catch(err){msg.textContent=err.message;}finally{btn.disabled=false;}
});
$("raffle-admin-refresh").addEventListener("click",refresh);
void refresh();
})();