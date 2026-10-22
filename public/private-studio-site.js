(()=>{"use strict";
  const $=id=>document.getElementById(id);
  function el(tag,text,cls){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=String(text);return node;}
  async function get(url,options={}){
    const response=await fetch(url,{credentials:"same-origin",cache:"no-store",...options});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(body.error||"Request unsuccessful.");
    return body;
  }
  function wire(){
    const pricing=document.getElementById("pricing-grid");
    if(pricing&&!$("aco-private-price")){
      const block=el("article",undefined,"aco-private-price");block.id="aco-private-price";
      block.append(el("div","STANDALONE DESKTOP SOFTWARE","aco-private-eyebrow"),
        el("h3","ACO STUDIO"),el("div","$15 / month","aco-private-amount"),
        el("p","Private account, card and address banks; Jig Studio; original-format import and export on Mac and Windows."),
        el("p","Your files and saved profile data remain on your computer."));
      const status=el("div","Checking availability…","aco-private-meta");
      const action=el("button","Checking access…","aco-private-buy");action.disabled=true;
      action.type="button";action.addEventListener("click",async()=>{
        action.disabled=true;status.textContent="Opening secure Stripe subscription checkout…";
        try{const r=await get("/api/account/studio-private/checkout",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
          if(!r.url||!r.url.startsWith("https://checkout.stripe.com/"))throw Error("Checkout unavailable.");
          window.location.assign(r.url);
        }catch(e){status.textContent=e.message;action.disabled=false;}
      });
      block.append(status,action);pricing.after(block);
      get("/api/studio-private/offer").then(offer=>{
        const ready=offer.available===true;
        action.disabled=!ready;action.textContent=ready?"Subscribe to ACO STUDIO — $15/month":"Coming soon";
        status.textContent=ready?"Recurring monthly billing. License issued to your signed-in account.":
          "Preview only · Mac/Windows verification in progress · Not available for purchase yet.";
      }).catch(()=>{action.textContent="Temporarily unavailable";status.textContent="Availability could not be verified.";});
    }
    const profile=$("my-profile");
    if(profile&&!$("aco-private-profile")){
      const panel=el("section",undefined,"aco-private-profile");panel.id="aco-private-profile";
      panel.append(el("h3","ACO STUDIO · License & downloads"),
        el("p","This license is independent of your ACO membership. It unlocks a separate locally encrypted Mac/Windows desktop app. Your cards, addresses, retailer pools and import files are never uploaded here."));
      const status=el("p","Sign in to see your license status.","aco-private-license-status");
      const key=el("code","", "aco-private-license-key");
      const buttons=el("div",undefined,"aco-private-downloads");
      panel.append(status,key,buttons);profile.append(panel);
      const reload=async()=>{
        try{const result=await get("/api/account/studio-private/license");
          const licenses=result.licenses||[];
          if(!licenses.length){status.textContent="No license is associated with this account.";key.textContent="";buttons.replaceChildren();return;}
          const first=licenses.find(l=>l.active)||licenses.at(0);
          status.textContent=first.active?"License active · subscription verified":first.revoked?"License revoked":"Subscription not active";
          key.textContent=first.active?first.licenseKey||"No key issued":"";
          buttons.replaceChildren();
          if(first.active){
            const release="https://github.com/kaleb689/SLABSNGRABSACO/releases/tag/aco-studio-v1.0.1-preview";
            for(const platform of ["Mac installer","Windows installer"]){
              const link=el("a","Download "+platform,"aco-private-download-link");link.href=release;link.target="_blank";link.rel="noopener noreferrer";buttons.append(link);
            }
          }
        }catch(e){status.textContent=e.message==="Please sign in to your customer account."?"Sign in to My Profile to view your ACO STUDIO license.":e.message;}
      };
      void reload();
      document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")void reload();});
      const params=new URLSearchParams(location.search);
      if(params.get("studio_private")==="success"&&params.has("session_id")){
        status.textContent="Confirming your ACO STUDIO purchase…";
        const sessionId=params.get("session_id");
        get("/api/account/studio-private/claim",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({sessionId})}).then(()=>{
          status.textContent="Your license was activated.";void reload();
          params.delete("session_id");params.delete("studio_private");
          window.history.replaceState(null,"",location.pathname+(params.size?"?"+params.toString():"")+location.hash);
        }).catch(e=>{status.textContent="Purchase verification: "+e.message;});
      }
    }
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",wire,{once:true});else wire();
})();