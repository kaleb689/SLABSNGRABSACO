(()=>{"use strict";
  const root=document.createElement("details");root.id="studio-private-admin-licenses";
  root.style.cssText="margin:16px 0;border:1px solid #35a4bb;border-radius:12px;padding:14px;background:#121c34;color:#e9f7ff";
  root.hidden=true;const summary=document.createElement("summary");summary.textContent="ACO STUDIO · Licenses and Revocations";summary.style.cursor="pointer";summary.style.fontWeight="750";
  const status=document.createElement("p");status.textContent="Open to load license status.";const results=document.createElement("div");
  root.append(summary,status,results);
  function text(tag,content){const e=document.createElement(tag);e.textContent=String(content);return e;}
  async function api(path,options={}){const r=await fetch(path,{credentials:"same-origin",cache:"no-store",...options});const body=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(body.error||"Could not load license data.");return body;}
  async function refresh(){status.textContent="Checking standalone desktop license records…";results.replaceChildren();
    try{const {licenses=[]}=await api("/api/admin/studio-private/licenses");status.textContent=licenses.length+" standalone license(s). Keys are hidden until explicitly revealed. Private workstation data is never available here.";
      for(const item of licenses){const row=text("div",[
        item.customerName || "Customer",
        item.customerEmail || "Email unavailable",
        item.accountId,
        item.subscriptionId,
        item.revoked?"REVOKED":item.evaluation?"OWNER EVALUATION":"Issued",
        item.customerReceiptSentAt?"Customer receipt sent":"Customer receipt pending",
        item.evaluation?("Expires: "+String(item.expiresAt || "unknown")):(item.ownerReceiptSentAt?"Owner email sent":"Owner email pending")
      ].join(" · "));
        row.style.cssText="display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #304761;padding:12px 0;flex-wrap:wrap";
        if(!item.revoked&&!item.evaluation){
          const reveal=text("button","Reveal license key");reveal.type="button";
          reveal.style.cssText="border:1px solid #25bec8;border-radius:8px;padding:8px 12px;background:#163349;color:#fff;cursor:pointer";
          const field=text("code","");field.style.cssText="display:none;width:100%;padding:10px;color:#9eeecf;overflow-wrap:anywhere;background:#0a1d30;border-radius:7px";
          reveal.addEventListener("click",async()=>{
            if(field.style.display!=="none"){field.textContent="";field.style.display="none";reveal.textContent="Reveal license key";return;}
            reveal.disabled=true;try{
              const found=await api("/api/admin/studio-private/license/"+encodeURIComponent(item.id)+"/key");
              if(!found.licenseKey)throw Error("This key is unavailable.");
              field.textContent=found.licenseKey;field.style.display="block";reveal.textContent="Hide license key";
            }catch(e){status.textContent=e.message;}finally{reveal.disabled=false;}
          });
          row.append(reveal,field);
        }
        if(!item.revoked){const b=text("button","Revoke license");b.type="button";b.style.cssText="border:1px solid #df6b83;border-radius:8px;padding:8px 12px;background:#372138;color:#fff;cursor:pointer";
          b.addEventListener("click",async()=>{if(!confirm("Revoke this desktop license? The customer will lose access at the next online check."))return;
            b.disabled=true;try{await api("/api/admin/studio-private/revoke",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({licenseId:item.id})});await refresh();}
              catch(e){status.textContent=e.message;b.disabled=false;}});
          row.append(b);}
        results.append(row);
      }
    }catch(e){status.textContent=e.message;}}
  const jigPanel=document.createElement("details");
  jigPanel.id="studio-private-admin-jig-access";
  jigPanel.style.cssText="margin:16px 0;border:1px solid #35a4bb;border-radius:12px;padding:14px;background:#121c34;color:#e9f7ff";
  jigPanel.hidden=true;
  const jigSummary=text("summary","ACO STUDIO · Customer Jig Access");
  jigSummary.style.cssText="cursor:pointer;font-weight:750";
  const jigStatus=text("p","Open to manage live customer jig types.");
  const jigLabel=text("label","Apply jig types to ");
  const jigScope=document.createElement("select");
  jigScope.style.cssText="margin:8px;max-width:100%;padding:8px;border-radius:8px";
  const jigRows=document.createElement("div");
  jigRows.style.cssText="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;margin:12px 0";
  const jigButtons=document.createElement("div");jigButtons.style.cssText="display:flex;gap:8px;flex-wrap:wrap";
  const saveJigs=text("button","Save allowed jig types");
  const resetJigs=text("button","Restore global jig types");
  for(const button of [saveJigs,resetJigs]){button.type="button";button.style.cssText="border:1px solid #27bfce;border-radius:8px;padding:9px 14px;background:#163349;color:white;cursor:pointer";}
  jigButtons.append(saveJigs,resetJigs);jigLabel.append(jigScope);
  jigPanel.append(jigSummary,jigStatus,jigLabel,jigRows,jigButtons);
  let policy=null;
  function chosen(){
    return jigScope.value==="global"?policy?.global:policy?.customers?.[jigScope.value]||policy?.global;
  }
  function drawJigs(){
    jigRows.replaceChildren();if(!policy)return;
    for(const [key,title] of Object.entries(policy.catalog||{})){
      const label=document.createElement("label");
      label.style.cssText="display:flex;gap:9px;align-items:center;cursor:pointer";
      const control=document.createElement("input");control.type="checkbox";control.name=key;control.checked=chosen()?.[key]===true;
      label.append(control,text("span",title));jigRows.append(label);
    }
    resetJigs.hidden=jigScope.value==="global";
    jigStatus.textContent=jigScope.value==="global"?"Global defaults for all customer editions. Save to publish instantly.":"Customer-specific overrides. Unchecked jig types disappear from that customer's app.";
  }
  jigScope.addEventListener("change",drawJigs);
  async function loadJigs(){
    jigStatus.textContent="Loading live permissions…";
    try{
      const [current,registered]=await Promise.all([
        api("/api/admin/studio-private/jig-permissions"),
        api("/api/admin/studio-private/licenses")
      ]);
      policy=current;
      const selected=jigScope.value||"global";jigScope.replaceChildren();
      jigScope.append(new Option("All customers · Global defaults","global"));
      for(const item of registered.licenses||[]){
        if(!item.accountId||item.revoked||item.evaluation)continue;
        jigScope.append(new Option([item.customerName,item.customerEmail].filter(Boolean).join(" · ")||item.accountId,item.accountId));
      }
      jigScope.value=[...jigScope.options].some(o=>o.value===selected)?selected:"global";
      drawJigs();
    }catch(error){jigStatus.textContent="Could not load jig permissions: "+error.message;}
  }
  saveJigs.addEventListener("click",async()=>{
    if(!policy)return;
    const selected=jigScope.value;
    const allowed=Object.fromEntries([...jigRows.querySelectorAll("input")].map(c=>[c.name,c.checked]));
    saveJigs.disabled=true;
    try{
      await api("/api/admin/studio-private/jig-permissions",{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({scope:selected==="global"?"global":"customer",accountId:selected==="global"?undefined:selected,allowed})});
      await loadJigs();
      jigStatus.textContent="Saved. Connected customer apps will update automatically.";
    }catch(error){jigStatus.textContent="Save failed: "+error.message;}
    finally{saveJigs.disabled=false;}
  });
  resetJigs.addEventListener("click",async()=>{
    if(!policy||jigScope.value==="global")return;
    resetJigs.disabled=true;
    try{
      await api("/api/admin/studio-private/jig-permissions/"+encodeURIComponent(jigScope.value),{method:"DELETE"});
      await loadJigs();jigStatus.textContent="Customer restored to global jig defaults.";
    }catch(error){jigStatus.textContent="Reset failed: "+error.message;}
    finally{resetJigs.disabled=false;}
  });
  jigPanel.addEventListener("toggle",()=>{if(jigPanel.open)void loadJigs();});

  root.addEventListener("toggle",()=>{if(root.open)void refresh();});
  const mount=()=>{const main=document.querySelector("main")||document.body;main.prepend(root);
    api("/api/admin/studio-private/licenses").then(()=>{root.hidden=false;jigPanel.hidden=false;root.after(jigPanel);}).catch(()=>{root.remove();});};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount,{once:true});else mount();
})();