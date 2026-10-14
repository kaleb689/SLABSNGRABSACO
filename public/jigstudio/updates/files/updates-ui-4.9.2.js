'use strict';
(() => {
 const $=id=>document.getElementById(id);
 const btn=$('jigUpdateButton'), panel=$('jigUpdatePanel');
 if(!btn||!panel)return;
 const status=$('jigUpdateStatus');
 const check=$('jigUpdateCheck'),install=$('jigUpdateInstall');
 const api=()=>window.desktopAPI?.updates;
 const notify=(text)=>{status.textContent=String(text);};
 const connection=document.createElement('span');
 connection.id='jigInternetStatus';connection.className='jigInternetStatus';
 connection.setAttribute('role','status');connection.textContent='Checking connection...';
 btn.before(connection);
 async function checkConnection(){
  if(!api()?.connection){connection.textContent='Internet: Desktop app required';return;}
  try{const r=await api().connection();
   connection.textContent=r.online?'● Internet connected'+(r.serverReachable?' · Update server reachable':' · Update server unavailable'):'○ Cannot reach the internet';
   connection.dataset.online=String(r.online);
  }catch{connection.textContent='○ Internet connection not verified';connection.dataset.online='false';}
 }
 let available=false;
 let checking=null;
 const online=document.createElement('button');
 online.type='button';online.id='jigUpdateOnline';online.className='btn slim primary';online.textContent='Download & install';online.hidden=true;online.disabled=true;
 online.style.marginTop='12px';panel.append(online);
 async function refresh() {
  if(checking)return checking;
  const u=api();if(!u){notify('Open the installed desktop application to use updates.');return false;}
  checking=(async()=>{
    check.disabled=true;online.disabled=true;online.hidden=true;available=false;
    notify('Checking for a newer owner edition...');
    try{
      const r=await u.check();notify('Installed v'+r.version+'. '+r.message);
      available=r.status==='available';online.hidden=!available;online.disabled=!available;
      return available;
    }catch(e){notify('Update check failed: '+e.message+' You can still install a trusted ZIP update.');return false;}
    finally{check.disabled=false;}
  })();
  try{return await checking;}finally{checking=null;}
 }
 btn.addEventListener('click',()=>{const open=panel.hidden;panel.hidden=!open;btn.setAttribute('aria-expanded',String(open));if(open){void checkConnection();void refresh();}});
 $('jigUpdateClose').addEventListener('click',()=>{panel.hidden=true;btn.setAttribute('aria-expanded','false');});
 check.addEventListener('click',()=>{void checkConnection();void refresh();});
 void checkConnection();
 install.addEventListener('click',async()=>{
  if(!api()){notify('The installed desktop application is required.');return;}
  if(!confirm('Only open Jig Studio updates from a source you trust. The application will restart after a successful update. Continue?'))return;
  install.disabled=true;notify('Select the new Jig Studio owner ZIP file...');
  try{const result=await api().installZip();if(!result?.started)notify('No update selected.');else notify(result.message);}
  catch(e){notify('Update could not start: '+e.message);}finally{install.disabled=false;}
 });
 online.addEventListener('click',async()=>{
  if(online.disabled)return;
  if(!confirm('Check the approved update server again, then download and install the verified owner release?'))return;
  online.disabled=true;check.disabled=true;
  notify('Checking online and downloading the verified update. Keep the app open until it restarts...');
  try{
    const result=await api().installOnline();
    notify(result?.message||'The update service returned no installation result.');
    if(!result?.started){available=false;online.hidden=true;}
  }catch(e){notify('Could not install update: '+e.message+' Try Check online again or use a verified update ZIP.');}
  finally{check.disabled=false;online.disabled=!available;}
 });
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){panel.hidden=true;btn.setAttribute('aria-expanded','false');}});
})();
