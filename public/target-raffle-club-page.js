(function(){
"use strict";
const $=id=>document.getElementById(id);
const status=$("club-status"),note=$("club-note"),join=$("club-join"),
  manage=$("club-manage"),signIn=$("club-signin"),panel=$("club-queue-panel"),
  list=$("club-queue"),refresh=$("club-refresh");
const params=new URLSearchParams(location.search);
const cash=c=>"$"+(Number(c||0)/100).toFixed(2);
async function request(url,options={}){
  const response=await fetch(url,{credentials:"same-origin",cache:"no-store",...options});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=Error(data.error||"Please try again.");error.status=response.status;throw error;}
  return data;
}
async function send(url,body={}){
  return request(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
}
function message(value){status.textContent=value;}
function empty(node){while(node.firstChild)node.removeChild(node.firstChild);}
function make(tag,text,className){
  const node=document.createElement(tag);
  if(text!==undefined)node.textContent=String(text);
  if(className)node.className=className;
  return node;
}
async function renderQueue(){
  const data=await request("/api/account/raffle-club/queue");
  empty(list);
  const items=Array.isArray(data.items)?data.items:[];
  if(!items.length){
    list.append(make("p","No raffle item requests are open yet. New items and prices will appear here and in the private Discord channel."));
    return;
  }
  for(const item of items){
    const card=make("article",undefined,"queue-item");
    card.append(make("h3",String(item.name||"Raffle item")));
    card.append(make("p",cash(item.priceCents)+" each · "+(item.active?"Queue open":"Queue closed")+" · "+(item.queue||[]).length+" people","meta"));
    if(!(item.queue||[]).length){card.append(make("p","Nobody is in line yet."));list.append(card);continue;}
    const ol=make("ol");
    for(const entry of item.queue){
      const li=make("li",(entry.name||"Member")+" — "+Number(entry.qty||0)+" requested"+(entry.mine?" · YOUR REQUEST":""));
      if(entry.mine)li.classList.add("mine");
      ol.append(li);
    }
    card.append(ol);list.append(card);
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
      note.textContent="Existing ACO members are eligible for $5/month. Otherwise the standalone plan is $20/month.";
      signIn.hidden=false;manage.hidden=true;join.hidden=true;panel.hidden=true;
      return;
    }
    signIn.hidden=true;
    if(session.active){
      message("Target Raffle Club is active"+(session.plan==="member"?" — $5/month add-on.":" — $20/month standalone."));
      note.textContent=session.discordLinked?
        "Your linked Discord account will receive the paid Target Raffle Club role. Open Discord to choose items and quantities.":
        "Link your Discord account in My Profile to receive the private club channel and use its selection buttons.";
      join.hidden=true;manage.hidden=false;panel.hidden=false;
      await renderQueue();
      return;
    }
    panel.hidden=true;manage.hidden=true;join.hidden=false;
    const price=session.memberEligible?5:20;
    message("Your Target Raffle Club membership is $"+price+"/month.");
    note.textContent=session.memberEligible?"This is an add-on to your existing ACO membership. Your profile count is unchanged.":
      "This is the standalone club plan. No ACO retailer profiles are included.";
    if(!offer.available){
      join.textContent="Checkout not yet available";
      join.disabled=true;
      note.textContent+=" Stripe billing setup is being finalized.";
    }else{
      join.textContent="Join for $"+price+"/month";
      join.disabled=false;
    }
  }catch(e){
    message("Unable to verify membership right now.");
    note.textContent=e.message||"Please try again.";
    join.disabled=true;manage.hidden=true;
  }
}
join.addEventListener("click",async()=>{
  join.disabled=true;join.textContent="Preparing checkout…";
  try{
    const data=await send("/api/account/raffle-club/checkout");
    if(!/^https:\/\/checkout\.stripe\.com\//.test(data.url||""))
      throw Error("Invalid secure payment link.");
    location.assign(data.url);
  }catch(e){message(e.message||"Could not prepare payment.");join.disabled=false;await reload();}
});
manage.addEventListener("click",async()=>{
  manage.disabled=true;
  try{
    const data=await send("/api/account/raffle-club/manage");
    if(!/^https:\/\/billing\.stripe\.com\//.test(data.url||""))
      throw Error("Invalid billing portal link.");
    location.assign(data.url);
  }catch(e){message(e.message||"Unable to open billing management.");manage.disabled=false;}
});
refresh.addEventListener("click",async()=>{
  refresh.disabled=true;
  try{await renderQueue();}catch(e){message(e.message||"Unable to load queue.");}
  finally{refresh.disabled=false;}
});
async function start(){
  if(params.get("raffle")==="success"&&params.has("session_id")){
    message("Confirming your Target Raffle Club payment…");
    try{
      const result=await send("/api/account/raffle-club/claim",{sessionId:params.get("session_id")});
      message(result.active?"Club subscription confirmed.":"Payment is still processing.");
    }catch(e){message("Payment confirmation is processing. Your access will update after Stripe verifies the subscription.");}
    history.replaceState(null,"",location.pathname);
  }
  await reload();
}
void start();
setInterval(() => {
  if (!panel.hidden && document.visibilityState === "visible")
    void renderQueue().catch(() => {});
}, 15000);
})();