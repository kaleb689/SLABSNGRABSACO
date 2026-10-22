(()=>{"use strict";
const RELEASE="https://github.com/kaleb689/SLABSNGRABSACO/releases/download/aco-studio-v1.0.4-preview/";
const DOWNLOADS=[
 ["Mac — Apple Silicon (M1/M2/M3/M4)", "ACO.STUDIO-1.0.4-arm64.dmg"],
 ["Mac — Intel", "ACO.STUDIO-1.0.4.dmg"],
 ["Windows — x64", "ACO.STUDIO.Setup.1.0.4.exe"]
];
const status=document.getElementById("status"),ready=document.getElementById("ready");
async function api(url,options={}){
 const response=await fetch(url,{credentials:"same-origin",cache:"no-store",...options});
 const body=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(body.error||("Request failed ("+response.status+")"));
 return body;
}
async function load(){
 try {
  const params=new URLSearchParams(location.search),sessionId=params.get("session_id");
  if(sessionId){
    if(!/^cs_(?:test_)?[a-zA-Z0-9_]{12,150}$/.test(sessionId))throw Error("Invalid checkout session.");
    await api("/api/account/studio-private/claim",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId})});
    // Session identifiers are short-lived payment references; keep them out of the address bar.
    window.history.replaceState(null,"",location.pathname);
  }
  const result=await api("/api/account/studio-private/license");
  const row=(result.licenses||[]).find(x=>x.active&&x.licenseKey);
  if(!row){
    status.textContent="No active ACO STUDIO license was verified for this signed-in account. If you just paid, your payment may still be processing. Sign in to the purchasing account and reopen this page.";
    return;
  }
  document.getElementById("license").textContent=row.licenseKey;
  const links=document.getElementById("downloads");
  for(const [name,file] of DOWNLOADS){
    const a=document.createElement("a");a.href=RELEASE+encodeURIComponent(file);a.textContent="Download "+name;a.rel="noopener noreferrer";links.append(a);
  }
  ready.hidden=false;status.textContent="Your subscription is active. Your downloads are ready.";
 }catch(error){
  status.textContent="Could not verify this purchase: "+error.message+" Sign in with the account used at checkout. No download access was granted.";
 }
}
load();
})();