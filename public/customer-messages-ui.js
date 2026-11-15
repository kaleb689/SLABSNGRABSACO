// Authenticated customer Messages tab. Never render customer-controlled HTML.
(() => {
  const panel=document.getElementById("account-tab-messages");
  const dashboard=document.getElementById("customer-dashboard");
  const section=document.getElementById("my-profile");
  const feed=document.getElementById("customer-messages-list");
  const status=document.getElementById("customer-messages-status");
  const form=document.getElementById("customer-message-form");
  const field=document.getElementById("customer-message-text");
  const sendButton=document.getElementById("customer-message-send");
  const unread=document.getElementById("account-messages-unread");
  if(!panel||!dashboard||!feed||!form)return;
  let loading=false,sending=false,pendingId=null,ready=false,lastRender="";
  const signedIn=()=>!dashboard.hidden;
  const active=()=>signedIn()&&!panel.hidden&&section?.classList.contains("active");
  const requestId=()=>crypto.randomUUID?crypto.randomUUID():
    [...crypto.getRandomValues(new Uint8Array(16))]
      .map(byte=>byte.toString(16).padStart(2,"0")).join("");
  function updateUnread(count) {
    const value=Math.min(99,Math.max(0,Number(count)||0));
    if(!unread)return;
    unread.hidden=!value;
    unread.textContent=value>0?String(value):"";
    unread.setAttribute("aria-label",value?value+" unread support replies":"No unread replies");
    document.dispatchEvent(new CustomEvent("customer-message-unread-changed",{detail:{unread:value}}));
  }
  function render(rows) {
    const safe=Array.isArray(rows)?rows:[];
    const fingerprint=JSON.stringify(safe.map(item=>[item.id,item.createdAt]));
    if(lastRender===fingerprint)return;
    lastRender=fingerprint;
    feed.replaceChildren();
    if(!safe.length) {
      const empty=document.createElement("p");
      empty.className="account-muted";
      empty.textContent="No messages yet. Send a message below to contact support.";
      feed.append(empty);return;
    }
    for(const item of safe) {
      const bubble=document.createElement("article");
      bubble.className="customer-message-bubble "+(item.role==="owner"?"from-support":"from-customer");
      const head=document.createElement("div");
      head.className="customer-message-meta";
      const author=document.createElement("strong");
      author.textContent=item.role==="owner"?"SLABSNGRABSACO Support":"You";
      const time=document.createElement("time");
      const date=new Date(item.createdAt);
      time.textContent=Number.isFinite(date.getTime())?
        date.toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"";
      head.append(author,time);
      const text=document.createElement("p");
      text.textContent=String(item.text||"");
      bubble.append(head,text);feed.append(bubble);
    }
    feed.scrollTop=feed.scrollHeight;
  }
  async function api(url,options) {
    const response=await fetch(url,{credentials:"same-origin",cache:"no-store",...options});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(data.error||"Messages are temporarily unavailable.");
    return data;
  }
  async function loadMessages() {
    if(loading||!signedIn()||document.hidden)return;
    loading=true;
    try {
      const result=await api("/api/account/messages");
      ready=result.ready===true;
      sendButton.disabled=!ready||sending;
      if(active()) {
        render(result.messages);
        status.textContent=ready?
          "Private conversation with support. Replies update automatically.":
          "The private Discord Admin inbox is connecting. Your conversation is safe.";
      }
      updateUnread(result.unread);
      if(active()&&Number(result.unread)>0) {
        await api("/api/account/messages/read",{method:"POST",
          headers:{"Content-Type":"application/json"},body:"{}"});
        updateUnread(0);
      }
    } catch(error) {
      if(active())status.textContent=error.message;
    } finally {loading=false;}
  }
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    if(sending||!ready)return;
    const text=field.value.trim();
    if(!text)return;
    pendingId ||= requestId();
    sending=true;sendButton.disabled=true;
    status.textContent="Sending to private Discord support…";
    try{
      await api("/api/account/messages",{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({text,requestId:pendingId})});
      field.value="";pendingId=null;
      status.textContent="Message sent to support.";
      lastRender="";
      await loadMessages();
    }catch(error){status.textContent=error.message+" Your draft was kept for retry.";}
    finally {sending=false;sendButton.disabled=!ready;}
  });
  field.addEventListener("input",()=>{pendingId=null;});
  document.addEventListener("click",event=>{
    if(event.target.closest('[data-account-tab="messages"]'))
      setTimeout(()=>{lastRender="";void loadMessages();},0);
  });
  document.addEventListener("account-session-changed",()=>{
    if(!signedIn()){
      ready=false;pendingId=null;lastRender="";
      field.value="";feed.replaceChildren();updateUnread(0);
      status.textContent="Sign in to view your private messages.";
      sendButton.disabled=true;
    }else void loadMessages();
  });
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)void loadMessages();});
  setInterval(()=>{if(signedIn())void loadMessages();},12000);
  sendButton.disabled=true;
  if(signedIn())void loadMessages();
})();
