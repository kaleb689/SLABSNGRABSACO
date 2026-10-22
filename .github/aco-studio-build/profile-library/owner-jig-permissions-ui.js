(()=>{'use strict';
const api=window.desktopAPI?.site,root=document.getElementById('sitePage');
if(!api?.customerJigPermissions||!root)return;
const panel=document.createElement('details');panel.id='acoCustomerJigAccess';
panel.style.cssText='margin:12px 0;padding:15px;border:1px solid #2baabb;border-radius:12px;background:#0c2430;color:#f3f8ff';
const heading=document.createElement('summary');
heading.textContent='ACO STUDIO · Customer Jig Access';heading.style.cssText='cursor:pointer;font-weight:700';
const status=document.createElement('p');status.setAttribute('role','status');
status.textContent='Open to enable or disable jig types for all customers or one licensed user.';
const scope=document.createElement('select');
scope.style.cssText='margin:10px 0;max-width:100%;padding:7px';
const grid=document.createElement('div');
grid.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px;margin:12px 0';
const actions=document.createElement('div');actions.style.cssText='display:flex;gap:8px;flex-wrap:wrap';
const save=document.createElement('button');save.type='button';save.className='btn primary';save.textContent='Save customer jig access';
const reset=document.createElement('button');reset.type='button';reset.className='btn secondary';reset.textContent='Restore global rules';
actions.append(save,reset);panel.append(heading,status,scope,grid,actions);root.prepend(panel);
let policy=null;
function selection(){
  if(!policy)return {};
  return scope.value==='global'?policy.global:policy.customers?.[scope.value]||policy.global;
}
function draw(){
  grid.replaceChildren();
  if(!policy)return;
  for(const [key,caption] of Object.entries(policy.catalog||{})){
    const label=document.createElement('label');label.style.cssText='display:flex;align-items:center;gap:8px';
    const input=document.createElement('input');input.type='checkbox';input.name=key;
    input.checked=selection()[key]===true;label.append(input,document.createTextNode(caption));grid.append(label);
  }
  reset.hidden=scope.value==='global';
}
scope.addEventListener('change',draw);
async function reload(){
  status.textContent='Checking live jig permissions…';
  try{
    const response=await api.customerJigPermissions({action:'read'});
    policy=response.policy;
    const selected=scope.value||'global';scope.replaceChildren();
    scope.append(new Option('All customers · global jig types','global'));
    for(const license of response.licenses||[]){
      if(!license.accountId||license.revoked||license.evaluation)continue;
      scope.append(new Option([license.customerName,license.customerEmail].filter(Boolean).join(' · ')||license.accountId,license.accountId));
    }
    scope.value=[...scope.options].some(option=>option.value===selected)?selected:'global';
    draw();status.textContent='Connected. Changes appear in running customer editions without a download.';
  }catch(error){status.textContent='Connect to the website Admin account first. '+String(error?.message||'Could not load jig settings.');}
}
panel.addEventListener('toggle',()=>{if(panel.open)void reload();});
save.addEventListener('click',async()=>{
  if(!policy)return;
  const selected=scope.value;
  const allowed=Object.fromEntries([...grid.querySelectorAll('input')].map(input=>[input.name,input.checked]));
  save.disabled=true;
  try{
    const result=await api.customerJigPermissions({action:'save',scope:selected==='global'?'global':'customer',
      accountId:selected==='global'?null:selected,allowed});
    if(!result?.saved)throw Error('Website did not confirm the saved settings.');
    await reload();status.textContent='Saved on website. Running customer apps receive this change live.';
  }catch(error){status.textContent='Could not save: '+String(error?.message||'Unexpected error.');}
  finally{save.disabled=false;}
});
reset.addEventListener('click',async()=>{
  if(!policy||scope.value==='global')return;
  reset.disabled=true;
  try{
    const result=await api.customerJigPermissions({action:'reset',accountId:scope.value});
    if(!result?.saved)throw Error('Website did not confirm the reset.');
    await reload();status.textContent='Customer is now using global jig permissions.';
  }catch(error){status.textContent='Could not reset: '+String(error?.message||'Unexpected error.');}
  finally{reset.disabled=false;}
});
})();

(()=>{'use strict';
const api=window.desktopAPI?.profileLibrary,root=document.getElementById('sitePage');
if(!api?.backupList||!api?.backupRestore||!root)return;
const panel=document.createElement('details');panel.id='acoStudioOwnerProfileRecovery';
panel.style.cssText='margin:12px 0;padding:15px;border:1px solid #27b19a;border-radius:12px;background:#0c2430;color:#eefafa';
const summary=document.createElement('summary');summary.textContent='ACO STUDIO · Encrypted Profile Backups';
summary.style.cssText='cursor:pointer;font-weight:700';
const status=document.createElement('p');status.setAttribute('role','status');
status.textContent='Automatic OS-encrypted snapshots protect Personal and ACO profile banks before every save.';
const scope=document.createElement('select');scope.style.cssText='margin:8px;padding:8px;border-radius:8px';
scope.append(new Option('Personal · My retailer profiles','personal'),
  new Option('ACO · All customer retailer profiles','aco'));
const refresh=document.createElement('button');refresh.type='button';refresh.textContent='Refresh recovery snapshots';
refresh.style.cssText='margin:8px;padding:8px 12px;border-radius:8px;cursor:pointer';
const list=document.createElement('div');list.style.cssText='display:grid;gap:7px;padding:8px';
panel.append(summary,status,scope,refresh,list);root.prepend(panel);
async function load(){
 list.replaceChildren();status.textContent='Checking encrypted snapshots…';
 try{
   const data=await api.backupList({scope:scope.value});
   status.textContent=data.length?
     data.length+' encrypted recovery snapshots available for '+(scope.value==='aco'?'all customer banks':'your personal bank')+'.':
     'No snapshots yet. The first snapshot is created before modifying an existing profile bank.';
   for(const row of data.slice(0,120)){
     const container=document.createElement('div');
     container.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap';
     const label=document.createElement('span');
     label.textContent=new Date(row.createdAt).toLocaleString()+' · '+Math.ceil((row.bytes||0)/1024)+' KB';
     const button=document.createElement('button');button.type='button';button.textContent='Restore';
     button.style.cssText='padding:7px 10px;border:1px solid #27b19a;border-radius:8px;cursor:pointer';
     button.addEventListener('click',async()=>{
       const description=scope.value==='aco'?'EVERY customer's local ACO profile bank':'your Personal local profile bank';
       if(!window.confirm('Restore '+description+' to its state on '+new Date(row.createdAt).toLocaleString()+
         '? The current encrypted vault will be backed up first. Website customer information is not modified.'))return;
       button.disabled=true;
       try{
         const result=await api.backupRestore({scope:scope.value,name:row.name,confirmed:true});
         if(!result?.restored)throw Error('Restoration was not confirmed.');
         status.textContent='Restored '+scope.value+' local profile bank. Reopen your profile view to refresh the records.';
         window.jigSignals?.changed?.();
         await load();
       }catch(error){status.textContent='Restore failed; current bank preserved: '+String(error.message||error);}
       finally{button.disabled=false;}
     });
     container.append(label,button);list.append(container);
   }
 }catch(error){status.textContent='Backups unavailable until owner authentication: '+String(error.message||error);}
}
panel.addEventListener('toggle',()=>{if(panel.open)void load();});
scope.addEventListener('change',()=>void load());
refresh.addEventListener('click',()=>void load());
})();
