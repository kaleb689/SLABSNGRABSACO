"use strict";
const $=id=>document.getElementById(id),api=window.PrivateStudio;
const stores={target:"Target",walmart:"Walmart",pokemoncenter:"Pokémon Center (PKC)",costco:"Costco",sams:"Sam's"};
const labels={suffix:"Street suffix swap",directional:"Directional abbreviations",ordinal:"Ordinal street numbers",doubleLetter:"Double-letter street name",fraction:"Fractional house number",hyphen:"Hyphen house number",randomUnit:"Random unit on unassigned addresses",phone:"Randomize phone digits",name:"Randomize first and last name"};
let overview={sources:[],cards:[],addresses:[],activity:[]},page="home";
let remoteAllowed=null;
const selectedProfileFiles=new Set();
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
  const title={home:"Welcome to your ACO STUDIO workspace",accounts:"Account Banks",profiles:"Retailer Profiles",cards:"Card Bank",
    addresses:"Address Bank",jig:"Jig Studio",transfer:"Import / Export",rules:"Rules",
    license:"License",settings:"Settings"};
  $("page-title").textContent=title[view]||"ACO STUDIO";
  $("page-desc").textContent=view==="home"?"Your profiles, bank data and export files stay under your control.":"Your workspace. Your device. Your data.";
  if(view==="transfer"||view==="accounts"||view==="profiles")drawFiles();
  if(view==="settings")void loadBackups();
}
async function call(name,arg){try{return await api[name](arg);}catch(e){message(e?.message||"Operation failed.",true);return null;}}
async function refresh(){const result=await call("vault_overview");if(!result)return;overview=result;
  $("total-accounts").textContent=String(result.sources.reduce((n,s)=>n+s.count,0));
  $("total-cards").textContent=String((result.cardPool||result.cards).length);
  $("total-addresses").textContent=String(result.addresses.length);
  for(const id of [...selectedProfileFiles])if(!result.sources.some(x=>x.id===id))selectedProfileFiles.delete(id);
  drawFiles();drawCards();drawAddresses();drawSources();
  const allowed=await call("jigs_permissions");
  if(allowed)applyJigPermissions(allowed);
  const a=$("activity");a.replaceChildren();
  for(const item of result.activity.slice(0,10))a.append(node("p",item.action+" · "+new Date(item.at).toLocaleString(),"activity-line"));
  if(!a.children.length)a.append(node("p","No recent activity."));
}
function drawFiles(){
  for(const [area,id] of [["accounts","account-files"],["transfer","transfer-list"],["profiles","profiles-list"]]){
    const target=$(id);target.replaceChildren();
    const retailer=$(area==="accounts"?"account-retailer":area==="transfer"?"transfer-retailer":"profiles-retailer").value;
    const files=overview.sources.filter(s=>s.retailer===retailer&&
      (area!=="profiles"||(s.bank||"working")===$("profiles-bank").value));
    for(const f of files){const box=node("div",undefined,"file-row");const summary=node("div");
      if(area==="profiles"){
        const pick=document.createElement("input");pick.type="checkbox";pick.setAttribute("aria-label","Select "+f.filename);
        pick.checked=selectedProfileFiles.has(f.id);
        pick.addEventListener("change",()=>{pick.checked?selectedProfileFiles.add(f.id):selectedProfileFiles.delete(f.id);updateBulkToolbar();});
        summary.append(pick);
      }
      summary.append(node("strong",f.filename),node("small",f.kind.toUpperCase()+" · "+f.count+" profile(s) · "+((f.bank||"working")==="live"?"Live Profiles":"Working Profiles")+" · Original format "+(f.changed?"edited":"retained")));
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
              const item=node("div",undefined,"file-row");
              item.append(node("pre",String(row.index+1)+". "+Object.entries(row.fields).map(([key,v])=>key+": "+String(v)).join(" | ")));
              item.append(button("Edit profile",()=>{
                const editor=node("form",undefined,"panel");
                editor.append(node("h3","Edit profile "+(row.index+1)+" · "+data.filename));
                const fields=node("div",undefined,"fields"),updates={};
                for(const [key,value] of Object.entries(row.fields)){
                  if(value!==null&&typeof value==="object")continue;
                  const label=node("label",key),input=document.createElement("input");
                  input.name=key;input.value=String(value??"");input.maxLength=5000;
                  label.append(input);fields.append(label);
                }
                const save=button("Save profile changes",async()=>{
                  for(const input of fields.querySelectorAll("input")){
                    if(input.value!==String(row.fields[input.name]??""))updates[input.name]=input.value;
                  }
                  if(!Object.keys(updates).length){message("No profile fields changed.");return;}
                  const saved=await call("vault_editRow",{fileId:f.id,rowIndex:row.index,updates});
                  if(saved?.saved){
                    Object.assign(row.fields,updates);editor.remove();render();
                    await refresh();message("Profile fields saved in original retailer format.");
                  }
                },"primary");
                const cancel=button("Cancel",()=>editor.remove());
                editor.append(fields,save,cancel);
                pane.insertBefore(editor,pane.querySelector(".mini-actions"));
              }));
              container.append(item);
            }
            const count=Math.max(1,Math.ceil(data.rows.length/pageSize));
            pager.textContent="Page "+(page+1)+" of "+count;
            previous.disabled=page===0;next.disabled=page>=count-1;
          }
          controls.append(previous,pager,next);pane.append(controls,container);render();modal.append(pane);
        }),
        button((f.bank||"working")==="live"?"Move to Working":"Move to Live",async()=>{
          const destination=(f.bank||"working")==="live"?"working":"live";
          const updated=await call("vault_setBank",{fileId:f.id,bank:destination});
          if(updated?.saved){await refresh();message("File moved to "+destination+" bank. No profiles were removed.");}
        }),button("Delete",async()=>{if(!confirm("Delete only "+f.filename+" from this private local vault?"))return;
          if(await call("vault_remove",{kind:"source",id:f.id})){message("Local file removed.");await refresh();}
        },"danger"));
      box.append(summary,actions);target.append(box);
    }
    if(!files.length)target.append(node("p",area==="profiles"?"No profiles in this selected retailer and bank. Import or move a file here.":"No imported files for this retailer yet. Import an existing file or create a profile."));
  }
  updateBulkToolbar();
}
// Actions work on exact imported source files inside the currently visible bank.
// All writes go through the existing encrypted, pre-save-snapshot transaction.
const bulkToolbar=node("div",undefined,"panel"),bulkActions=node("div",undefined,"mini-actions");
const bulkCount=node("span","0 selected");bulkToolbar.append(node("h3","Bulk profile bank actions"),bulkCount,bulkActions);
$("profiles-list").before(bulkToolbar);
const currentFiles=()=>overview.sources.filter(x=>x.retailer===$("profiles-retailer").value&&
 (x.bank||"working")===$("profiles-bank").value);
const selectedFiles=()=>currentFiles().filter(x=>selectedProfileFiles.has(x.id));
function updateBulkToolbar(){
 const count=selectedFiles().length;bulkCount.textContent=count+" file(s) selected";
 for(const b of bulkActions.querySelectorAll("button[data-requires-selection]"))b.disabled=!count;
}
bulkActions.append(
 button("Select all visible",()=>{for(const x of currentFiles())selectedProfileFiles.add(x.id);drawFiles();}),
 button("Clear selection",()=>{selectedProfileFiles.clear();drawFiles();})
);
const bulkMove=button("Move All Selected",async()=>{
 const chosen=selectedFiles();if(!chosen.length)return;
 const fromBank=$("profiles-bank").value,toBank=fromBank==="live"?"working":"live";
 if(!confirm("Move "+chosen.length+" selected "+stores[$("profiles-retailer").value]+" file(s) from "+fromBank+
    " to "+toBank+"? No profile details will change."))return;
 const result=await call("vault_bulkMove",{retailer:$("profiles-retailer").value,fromBank,toBank,
    fileIds:chosen.map(x=>x.id),confirmed:true});
 if(result?.saved){selectedProfileFiles.clear();await refresh();message("Moved "+result.moved+" files to "+toBank+".");}
});bulkMove.dataset.requiresSelection="true";
const bulkDelete=button("Delete All Selected",async()=>{
 const chosen=selectedFiles();if(!chosen.length)return;
 if(!confirm("DELETE "+chosen.length+" selected local "+stores[$("profiles-retailer").value]+
  " file(s)? This does not affect your other retailers, cards, addresses or website accounts. An encrypted recovery snapshot is saved before removal."))return;
 const result=await call("vault_bulkDelete",{retailer:$("profiles-retailer").value,
   fromBank:$("profiles-bank").value,fileIds:chosen.map(x=>x.id),confirmed:true});
 if(result?.deleted){selectedProfileFiles.clear();await refresh();message("Deleted "+result.deleted+" selected local profile files. Recovery snapshots are available in Settings.");}
},"danger");bulkDelete.dataset.requiresSelection="true";
const historyButton=button("Import History",async()=>{
 const modal=$("inspect");modal.replaceChildren();modal.classList.remove("hidden");
 const pane=node("section",undefined,"inspect-panel");pane.append(node("h2","Import history"),
  node("p","Each import session is tracked separately. Removing a batch deletes only the files originally created in that import; later imports and saved card/address banks are preserved."),
  button("Close",()=>modal.classList.add("hidden")));
 const rows=overview.importHistory||[];
 if(!rows.length)pane.append(node("p","No tracked imports yet. Older files remain available but cannot be deleted by unverified batch association."));
 for(const batch of rows){
  const record=node("div",undefined,"file-row"),details=node("div");
  const label=stores[batch.retailer]||batch.retailer;
  details.append(node("strong",label+" · "+(batch.bank==="live"?"Live":"Working")+" · "+new Date(batch.at).toLocaleString()),
    node("small",batch.fileCount+" imported files · "+batch.profileCount+" profiles · "+batch.remainingFiles+" currently present"),
    node("small",(batch.filenames||[]).join(", ").slice(0,500)));
  record.append(details);
  if(!batch.removedAt&&batch.remainingFiles){
   record.append(button("Remove this import",async()=>{
    if(!confirm("Remove ONLY the "+batch.remainingFiles+" remaining files from this exact import batch? You can recover a previous encrypted vault snapshot in Settings."))return;
    const result=await call("vault_removeImportBatch",{batchId:batch.id,confirmed:true});
    if(result){modal.classList.add("hidden");selectedProfileFiles.clear();await refresh();message("Removed "+result.removed+" files from the selected import. Other batches are untouched.");}
   },"danger"));
  }else record.append(node("small",batch.removedAt?"Removed "+new Date(batch.removedAt).toLocaleString():"All files already deleted"));
  pane.append(record);
 }
 modal.append(pane);
});
bulkActions.append(bulkMove,bulkDelete,historyButton);updateBulkToolbar();

function drawCards(){const target=$("card-list");target.replaceChildren();
  const records=overview.cardPool||[];
  if(!records.length)target.append(node("p","No saved or imported-profile cards in this private vault."));
  for(const c of records){
   const stored=c.fromSavedBank?overview.cards.find(x=>"saved:"+x.id===c.ref):null;
   const row=node("div",undefined,"file-row");
   const info=node("div");
   info.append(node("strong",(c.hardCard?"HARD CARD · ":"")+(stored?.label||c.label||"Card")+" · ending "+c.last4),
    node("small",[c.expiry,c.status,c.availableRetailers.length?"Available for: "+c.availableRetailers.map(x=>stores[x]||x).join(", "):"Not available for additional profiles"].filter(Boolean).join(" · ")));
   if(c.conflict)info.append(node("small","Existing duplicate assignments detected. Review before applying another card."));
   row.append(info,button(c.hardCard?"Unset Hard Card":"Set Hard Card",async()=>{
    if(!confirm((c.hardCard?"Disable":"Enable")+" Hard Card for the card ending "+c.last4+"? It will be usable at most once per retailer in this private vault."))return;
    const result=await call("vault_setHardCard",{cardRef:c.ref,hard:!c.hardCard,confirmed:true});
    if(result?.saved){await refresh();message("Hard Card setting updated only in your private vault.");}
   }));
   if(stored){
    row.append(button("Delete",async()=>{if(!confirm("Remove this stored card from your private card bank? Imported profiles retain their original card data."))return;
      if(await call("vault_remove",{kind:"card",id:stored.id}))await refresh();},"danger"));
   }else row.append(button("Add to saved card bank",async()=>{
    if(!confirm("Copy card number and expiration from this profile into your saved Card Bank? The unrelated profile Security Code will not be copied."))return;
    const result=await call("vault_promoteCard",{cardRef:c.ref,confirmed:true});
    if(result?.saved){await refresh();message("Imported card added to your saved pool.");}
   }));
   target.append(row);
  }
}
function drawAddresses(){const target=$("address-list");target.replaceChildren();
  for(const a of overview.addresses){const row=node("div",undefined,"file-row");row.append(node("strong",[a.label,a.address,a.unit,a.city,a.state,a.zip].filter(Boolean).join(" · ")),
    button("Delete",async()=>{if(!confirm("Delete this local address?"))return;if(await call("vault_remove",{kind:"address",id:a.id}))await refresh();},"danger"));target.append(row);}
}
function drawSources(){const selector=$("jig-source"),previous=selector.value;selector.replaceChildren();
  for(const f of overview.sources){const option=new Option(stores[f.retailer]+": "+f.filename+" ("+f.count+", "+((f.bank||"working")==="live"?"Live":"Working")+")",f.id);selector.append(option);}
  if(overview.sources.some(s=>s.id===previous))selector.value=previous;
}
for(const buttonEl of document.querySelectorAll("[data-view]"))buttonEl.addEventListener("click",()=>nav(buttonEl.dataset.view));
for(const buttonEl of document.querySelectorAll("[data-go]"))buttonEl.addEventListener("click",()=>nav(buttonEl.dataset.go));
for(const selector of document.querySelectorAll(".retailer"))for(const [id,label] of Object.entries(stores))selector.append(new Option(label,id));
$("profiles-retailer").addEventListener("change",()=>{selectedProfileFiles.clear();drawFiles();});
$("profiles-bank").addEventListener("change",()=>{selectedProfileFiles.clear();drawFiles();});
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
async function importFiles(retailer,bank="working"){const result=await call("vault_import",{retailer,bank});
  if(result?.imported){message("Imported "+result.imported+" file(s) with "+result.profiles+" profile(s); original formats retained.");await refresh();}
}
$("import-accounts").addEventListener("click",()=>importFiles($("account-retailer").value));
$("transfer-import").addEventListener("click",()=>importFiles($("transfer-retailer").value));
$("profiles-import").addEventListener("click",()=>importFiles($("profiles-retailer").value,$("profiles-bank").value));
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

async function loadBackups(){
  const backups=await call("vault_backupList");
  const list=$("backup-list");list.replaceChildren();
  if(!backups)return;
  if(!backups.length){list.append(node("p","No automatic snapshots yet. A snapshot is saved before each change to an existing vault."));return;}
  for(const entry of backups){
    const line=node("div",undefined,"file-row");
    line.append(node("span","Encrypted snapshot · "+new Date(entry.createdAt).toLocaleString()),
      button("Restore",async()=>{
        if(!confirm("Restore all saved information from "+new Date(entry.createdAt).toLocaleString()+"?"))return;
        const result=await call("vault_backupRestore",entry.name);
        if(result?.restored){await refresh();message("Encrypted profile bank restored.");await loadBackups();}
      }));
    list.append(line);
  }
}
$("backup-refresh").addEventListener("click",()=>void loadBackups());
$("backup-export").addEventListener("click",async()=>{
  const password=$("backup-passphrase").value;
  if(password.length<12){message("Backup passphrase must have at least 12 characters.",true);return;}
  const output=await call("vault_backupExport",password);
  if(output?.saved)message("Encrypted portable backup exported. Store the file and its passphrase separately.");
  $("backup-passphrase").value="";
});
$("backup-import").addEventListener("click",async()=>{
  const password=$("backup-passphrase").value;
  if(!password){message("Enter the existing backup's passphrase first.",true);return;}
  const output=await call("vault_backupImport",password);
  $("backup-passphrase").value="";
  if(output?.restored){message("Encrypted portable backup restored.");await refresh();await loadBackups();}
});

async function loadLockedSnapshots(){
 const target=$("locked-snapshots-list");target.replaceChildren();
 const backups=await call("vault_backupList");
 if(!backups){target.append(node("p","Local snapshots are unavailable."));return;}
 if(!backups.length){target.append(node("p","No automatic recovery snapshots were found on this computer."));return;}
 target.append(node("p",backups.length+" encrypted snapshots available on this computer."));
 for(const entry of backups){
   const line=node("div",undefined,"file-row");
   line.append(node("span",new Date(entry.createdAt).toLocaleString()),
     button("Restore",async()=>{
       if(!confirm("Restore saved profiles, cards, addresses and retailer banks from "+new Date(entry.createdAt).toLocaleString()+"?"))return;
       const restored=await call("vault_backupRestore",entry.name);
       if(!restored?.restored)return;
       const active=await call("license_status");
       $("activate-status").textContent=active?"Local encrypted vault restored and license verified.":"Local encrypted vault restored. Verify your license to continue.";
       if(active){$("lock").classList.add("hidden");$("application").classList.remove("hidden");await refresh();nav("home");}
     }));
   target.append(line);
 }
}
$("locked-snapshots-refresh").addEventListener("click",()=>void loadLockedSnapshots());

$("locked-backup-restore").addEventListener("click",async()=>{
  const password=$("locked-backup-password").value;
  if(!password){$("activate-status").textContent="Enter your existing backup passphrase.";return;}
  $("activate-status").textContent="Validating encrypted backup…";
  const restored=await call("vault_backupImport",password);
  $("locked-backup-password").value="";
  if(restored?.restored){
    const active=await call("license_status");
    $("activate-status").textContent=active?"Backup restored and license active.":"Backup restored. Activate your license to continue.";
    if(active){$("lock").classList.add("hidden");$("application").classList.remove("hidden");await refresh();nav("home");}
  }else $("activate-status").textContent="Backup not restored. Original saved information was not replaced.";
});

(async()=>{const active=await call("license_status");$("activate-status").textContent=active?"License active.":"Enter the key shown in your website profile.";
  if(active){$("lock").classList.add("hidden");$("application").classList.remove("hidden");await refresh();nav("home");}
})();
