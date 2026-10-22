"use strict";
const $=id=>document.getElementById(id),api=window.PrivateStudio;
const stores={target:"Target",walmart:"Walmart",pokemoncenter:"Pokémon Center (PKC)",costco:"Costco",sams:"Sam's"};
const labels={suffix:"Street suffix swap",directional:"Directional abbreviations",ordinal:"Ordinal street numbers",doubleLetter:"Double-letter street name",fraction:"Fractional house number",hyphen:"Hyphen house number",randomUnit:"Random unit on unassigned addresses",phone:"Randomize phone digits",name:"Randomize first and last name"};
let overview={sources:[],cards:[],addresses:[],activity:[]},page="home";
let remoteAllowed=null;
function applyJigPermissions(permissions){
  if(!permissions||typeof permissions!=="object")return;
  remoteAllowed=permissions;
  for(const box of document.querySelectorAll("#rule-checks label.rule")){
    const input=box.querySelector("input");
    if(!input)continue;
    const allowed=remoteAllowed[input.name]===true;
    box.hidden=!allowed;
    box.style.display=allowed?"":"none";
    input.disabled=!allowed;
    if(!allowed)input.checked=false;
  }
  const state=$("jig-permission-status");
  if(state)state.textContent="Jig types are controlled by your ACO Studio administrator and update automatically.";
}
api.onJigPermissions?.(applyJigPermissions);
const message=(text,bad=false)=>{const target=$("status");target.textContent=String(text);target.style.color=bad?"#ff94aa":"#9dd5de";};
function node(tag,text,cls){const element=document.createElement(tag);if(text!==undefined)element.textContent=String(text);if(cls)element.className=cls;return element;}
function button(label,click,cls){const b=node("button",label,cls);b.type="button";b.addEventListener("click",click);return b;}
function nav(view){page=view;for(const section of document.querySelectorAll(".page"))section.classList.toggle("hidden",section.id!==view);
  for(const b of document.querySelectorAll("[data-view]"))b.classList.toggle("selected",b.dataset.view===view);
  const title={home:"Welcome to your ACO STUDIO workspace",accounts:"Account Banks",cards:"Card Bank",
    addresses:"Address Bank",jig:"Jig Studio",transfer:"Import / Export",rules:"Rules",
    license:"License",settings:"Settings"};
  $("page-title").textContent=title[view]||"ACO STUDIO";
  $("page-desc").textContent=view==="home"?"Your profiles, bank data and export files stay under your control.":"Your workspace. Your device. Your data.";
  if(view==="transfer"||view==="accounts")drawFiles();
}
async function call(name,arg){try{return await api[name](arg);}catch(e){message(e?.message||"Operation failed.",true);return null;}}
async function refresh(){const result=await call("vault_overview");if(!result)return;overview=result;
  $("total-accounts").textContent=String(result.sources.reduce((n,s)=>n+s.count,0));
  $("total-cards").textContent=String(result.cards.length);
  $("total-addresses").textContent=String(result.addresses.length);
  drawFiles();drawCards();drawAddresses();drawSources();
  const allowed=await call("jigs_permissions");
  if(allowed)applyJigPermissions(allowed);
  const a=$("activity");a.replaceChildren();
  for(const item of result.activity.slice(0,10))a.append(node("p",item.action+" · "+new Date(item.at).toLocaleString(),"activity-line"));
  if(!a.children.length)a.append(node("p","No recent activity."));
}
function drawFiles(){
  for(const [area,id] of [["accounts","account-files"],["transfer","transfer-list"]]){
    const target=$(id);target.replaceChildren();
    const retailer=$(area==="accounts"?"account-retailer":"transfer-retailer").value;
    const files=overview.sources.filter(s=>s.retailer===retailer);
    for(const f of files){const box=node("div",undefined,"file-row");const summary=node("div");
      summary.append(node("strong",f.filename),node("small",f.kind.toUpperCase()+" · "+f.count+" profile(s) · Original format "+(f.changed?"edited":"retained")));
      const actions=node("div",undefined,"mini-actions");
      actions.append(button("Export",async()=>{const r=await call("vault_export",f.id);if(r?.saved)message("Exported "+r.filename+" in its source format.");}),
        button("Inspect",async()=>{const data=await call("vault_rows",f.id);if(!data)return;
          const modal=$("inspect");modal.replaceChildren();modal.classList.remove("hidden");
          const pane=node("section",undefined,"inspect-panel");pane.append(node("h2",data.filename),
            button("Close",()=>modal.classList.add("hidden")));
          const pageSize=50,container=node("div"),controls=node("div",undefined,"mini-actions"),pager=node("span");
          let page=0;
          const previous=button("Previous",()=>{page--;render();}),next=button("Next",()=>{page++;render();});
          function render(){
            container.replaceChildren();
            for(const row of data.rows.slice(page*pageSize,(page+1)*pageSize)){
              container.append(node("pre",String(row.index+1)+". "+Object.entries(row.fields).map(([key,v])=>key+": "+String(v)).join(" | ")));
            }
            const count=Math.max(1,Math.ceil(data.rows.length/pageSize));
            pager.textContent="Page "+(page+1)+" of "+count;
            previous.disabled=page===0;next.disabled=page>=count-1;
          }
          controls.append(previous,pager,next);pane.append(controls,container);render();modal.append(pane);
        }),button("Delete",async()=>{if(!confirm("Delete only "+f.filename+" from this private local vault?"))return;
          if(await call("vault_remove",{kind:"source",id:f.id})){message("Local file removed.");await refresh();}
        },"danger"));
      box.append(summary,actions);target.append(box);
    }
    if(!files.length)target.append(node("p","No imported files for this retailer yet. Import an existing file or create a profile."));
  }
}
function drawCards(){const target=$("card-list");target.replaceChildren();
  for(const c of overview.cards){const row=node("div",undefined,"file-row");row.append(node("strong",(c.label||"Card")+" · "+(c.number||"")+" · "+(c.holder||"")+" · "+(c.expiry||"")+(c.securityCode?" · Code: "+c.securityCode:"")),button("Delete",async()=>{if(!confirm("Delete this local card?"))return;
    if(await call("vault_remove",{kind:"card",id:c.id}))await refresh();},"danger"));target.append(row);}
}
function drawAddresses(){const target=$("address-list");target.replaceChildren();
  for(const a of overview.addresses){const row=node("div",undefined,"file-row");row.append(node("strong",[a.label,a.address,a.unit,a.city,a.state,a.zip].filter(Boolean).join(" · ")),
    button("Delete",async()=>{if(!confirm("Delete this local address?"))return;if(await call("vault_remove",{kind:"address",id:a.id}))await refresh();},"danger"));target.append(row);}
}
function drawSources(){const selector=$("jig-source"),previous=selector.value;selector.replaceChildren();
  for(const f of overview.sources){const option=new Option(stores[f.retailer]+": "+f.filename+" ("+f.count+")",f.id);selector.append(option);}
  if(overview.sources.some(s=>s.id===previous))selector.value=previous;
}
for(const buttonEl of document.querySelectorAll("[data-view]"))buttonEl.addEventListener("click",()=>nav(buttonEl.dataset.view));
for(const buttonEl of document.querySelectorAll("[data-go]"))buttonEl.addEventListener("click",()=>nav(buttonEl.dataset.go));
for(const selector of document.querySelectorAll(".retailer"))for(const [id,label] of Object.entries(stores))selector.append(new Option(label,id));
$("account-retailer").addEventListener("change",drawFiles);
$("transfer-retailer").addEventListener("change",drawFiles);
$("add-account-open").addEventListener("click",()=>$("account-form").classList.toggle("hidden"));
const formData=form=>Object.fromEntries(new FormData(form));
$("card-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget;
  const result=await call("vault_addCard",formData(form));if(result?.saved){form.reset();message("Card saved only in your encrypted local vault.");await refresh();}
});
$("address-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget;
  const result=await call("vault_addAddress",formData(form));if(result?.saved){form.reset();message("Address saved locally.");await refresh();}
});
$("account-form").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget;
  const result=await call("vault_addAccount",{...formData(form),retailer:$("account-retailer").value});
  if(result?.saved){form.reset();form.classList.add("hidden");message("Account profile saved in your private bank.");await refresh();}
});
async function importFiles(retailer){const result=await call("vault_import",retailer);
  if(result?.imported){message("Imported "+result.imported+" file(s) with "+result.profiles+" profile(s); original formats retained.");await refresh();}
}
$("import-accounts").addEventListener("click",()=>importFiles($("account-retailer").value));
$("transfer-import").addEventListener("click",()=>importFiles($("transfer-retailer").value));
const ruleContainer=$("rule-checks");
for(const [id,title]of Object.entries(labels)){const l=node("label",undefined,"rule");
  const cb=document.createElement("input");cb.type="checkbox";cb.name=id;cb.checked=["suffix","directional","ordinal"].includes(id);
  l.append(cb,node("span",title));ruleContainer.append(l);
}
$("jig-all").addEventListener("change",e=>$("jig-indices-label").classList.toggle("hidden",e.currentTarget.checked));
$("jig-apply").addEventListener("click",async()=>{
  const selected=$("jig-source").value,source=overview.sources.find(f=>f.id===selected);
  if(!source){message("Import a source file first.",true);return;}
  const indices=$("jig-all").checked?Array.from({length:source.count},(_,i)=>i):
    $("jig-indices").value.split(",").map(t=>Number(t.trim())-1);
  if(!indices.length||indices.some(n=>!Number.isInteger(n)||n<0||n>=source.count)){message("Enter valid profile indexes.",true);return;}
  const options=Object.fromEntries([...ruleContainer.querySelectorAll("input")].map(x=>[x.name,x.checked]));
  options.useAddressBank=$("jig-address-bank").checked;
  options.useCardBank=$("jig-card-bank").checked;
  options.billingSameAsShipping=$("jig-billing-same").checked;
  if(!Object.values(options).some(Boolean)){message("Select at least one jig or bank option.",true);return;}
  if(Object.entries(labels).some(([key])=>options[key]===true&&remoteAllowed?.[key]!==true)){
    message("One of your selected jig types is no longer available.",true);return;
  }
  if(!confirm("Apply these changes to "+indices.length+" local profile(s) in "+source.filename+"? You can still export the file in its original format."))return;
  const result=await call("vault_jig",{fileId:source.id,indices,options});
  if(result){message("Prepared "+result.edited+" profile(s) · "+result.assignedAddresses+" address assignment(s) · "+result.assignedCards+" card assignment(s). Original file format retained.");await refresh();}
});
$("check-license").addEventListener("click",async()=>{const ok=await call("license_status");$("license-state").textContent=ok?"License is active.":"License is inactive or currently unverifiable.";});
$("activate").addEventListener("submit",async e=>{e.preventDefault();$("activate-status").textContent="Verifying subscription…";
  const response=await call("license_activate",$("key").value);
  if(response?.active){$("key").value="";$("lock").classList.add("hidden");$("application").classList.remove("hidden");
    await refresh();nav("home");}else $("activate-status").textContent="License inactive or unavailable. Verify your subscription and key.";
});
(async()=>{const active=await call("license_status");$("activate-status").textContent=active?"License active.":"Enter the key shown in your website profile.";
  if(active){$("lock").classList.add("hidden");$("application").classList.remove("hidden");await refresh();nav("home");}
})();
