(()=>{"use strict";
  const root=document.createElement("details");root.id="studio-private-admin-licenses";
  root.style.cssText="margin:16px 0;border:1px solid #35a4bb;border-radius:12px;padding:14px;background:#121c34;color:#e9f7ff";
  root.hidden=true;const summary=document.createElement("summary");summary.textContent="ACO Studio Private Edition · Licenses and Revocations";summary.style.cursor="pointer";summary.style.fontWeight="750";
  const status=document.createElement("p");status.textContent="Open to load license status.";const results=document.createElement("div");
  root.append(summary,status,results);
  function text(tag,content){const e=document.createElement(tag);e.textContent=String(content);return e;}
  async function api(path,options={}){const r=await fetch(path,{credentials:"same-origin",cache:"no-store",...options});const body=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(body.error||"Could not load license data.");return body;}
  async function refresh(){status.textContent="Checking standalone desktop license records…";results.replaceChildren();
    try{const {licenses=[]}=await api("/api/admin/studio-private/licenses");status.textContent=licenses.length+" standalone license(s). License keys and private workstation data are not exposed to admins.";
      for(const item of licenses){const row=text("div",item.accountId+" · "+item.subscriptionId+" · "+(item.revoked?"REVOKED":"Issued"));
        row.style.cssText="display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #304761;padding:12px 0;flex-wrap:wrap";
        if(!item.revoked){const b=text("button","Revoke license");b.type="button";b.style.cssText="border:1px solid #df6b83;border-radius:8px;padding:8px 12px;background:#372138;color:#fff;cursor:pointer";
          b.addEventListener("click",async()=>{if(!confirm("Revoke this desktop license? The customer will lose access at the next online check."))return;
            b.disabled=true;try{await api("/api/admin/studio-private/revoke",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({licenseId:item.id})});await refresh();}
              catch(e){status.textContent=e.message;b.disabled=false;}});
          row.append(b);}
        results.append(row);
      }
    }catch(e){status.textContent=e.message;}}
  root.addEventListener("toggle",()=>{if(root.open)void refresh();});
  const mount=()=>{const main=document.querySelector("main")||document.body;main.prepend(root);
    api("/api/admin/studio-private/licenses").then(()=>{root.hidden=false;}).catch(()=>{root.remove();});};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount,{once:true});else mount();
})();