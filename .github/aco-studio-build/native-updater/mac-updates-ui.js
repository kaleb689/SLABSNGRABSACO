'use strict';
(()=>{
 const api=window.desktopAPI?.updates;if(!api?.nativeMac)return;
 const $=id=>document.getElementById(id),panel=$('jigUpdatePanel'),button=$('jigUpdateButton');if(!panel||!button)return;
 panel.innerHTML=`<div class="jigUpdateHead"><strong>Update ACO Studio</strong><button type="button" id="jigUpdateClose" class="btn slim plain" aria-label="Close updates">X</button></div>
 <p id="jigUpdateStatus" role="status" aria-live="polite">Checking installed version...</p>
 <progress id="acoUpdateProgress" max="100" value="0" hidden style="width:100%"></progress>
 <p id="jigLastUpdateResult"></p><div class="buttons"><button type="button" id="jigUpdateCheck" class="btn slim secondary">Check for updates</button><button type="button" id="jigUpdateOnline" class="btn slim primary" disabled hidden>Download &amp; Install</button></div>
 <div class="buttons"><button type="button" id="acoDesktopShortcut" class="btn slim secondary">Create Desktop Shortcut</button></div>\n <details style="margin-top:14px"><summary style="font-size:12px;cursor:pointer">Offline package</summary><button type="button" id="jigUpdateInstall" class="btn slim secondary" style="margin-top:9px">Choose official update ZIP</button><small>Requires the current official update feed to verify the package.</small></details>
 <small>Updates replace the complete app, then restart it. Saved Personal profiles, customer pools and settings stay in their existing locations. Save or export unsaved work first.</small>`;
 const status=$('jigUpdateStatus'),online=$('jigUpdateOnline'),check=$('jigUpdateCheck'),offline=$('jigUpdateInstall'),bar=$('acoUpdateProgress');
 let checking=false,installing=false,available=false,poll=null;
 function controls(){check.disabled=checking||installing;online.disabled=!available||checking||installing;offline.disabled=checking||installing;}
 async function last(){try{const r=await api.lastResult();$('jigLastUpdateResult').textContent=r?(['installed','rolledback','failed'].includes(r.phase)?r.message:'Previous update: '+r.message):'';}catch{}}
 async function refresh(){if(checking||installing)return;checking=true;controls();status.textContent='Checking the official Mac update feed...';
  try{const r=await api.check();available=r.status==='available';online.hidden=!available;status.textContent='Installed v'+r.version+'. '+r.message;}
  catch(e){status.textContent=e.message;available=false;online.hidden=true;}
  finally{checking=false;controls();await last();}
 }
 async function pollProgress(){try{const r=await api.progress();if(!installing)return;status.textContent=r.message||status.textContent;
  bar.hidden=r.phase!=='downloading';if(Number.isFinite(r.percent)){bar.value=r.percent;bar.setAttribute('aria-label','Update download '+r.percent+' percent');}
 }catch{}}
 async function install(local=false){if(installing||checking)return;installing=true;controls();poll=setInterval(pollProgress,600);
  try{const r=await(local?api.installZip():api.installOnline());status.textContent=r?.message||(r?.cancelled?'Update cancelled. Nothing changed.':'No installation was started.');
   if(r?.started){status.textContent=r.message;return;}
  }catch(e){status.textContent='Update not installed: '+e.message;}
  finally{clearInterval(poll);poll=null;bar.hidden=true;installing=false;controls();}
 }
 button.addEventListener('click',()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)void refresh();});
 $('jigUpdateClose').addEventListener('click',()=>{panel.hidden=true;button.setAttribute('aria-expanded','false');button.focus();});
 $('acoDesktopShortcut').addEventListener('click',async()=>{
  const btn=$('acoDesktopShortcut');btn.disabled=true;
  try{const result=await api.desktopShortcut();if(!result.cancelled)status.textContent=result.message;}
  catch(error){status.textContent='Desktop shortcut not changed: '+error.message;}
  finally{btn.disabled=false;}
 });
 check.addEventListener('click',()=>void refresh());online.addEventListener('click',()=>void install());offline.addEventListener('click',()=>void install(true));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden)$('jigUpdateClose').click();});
 // Read-only startup check; installing always requires the user's button and native confirmation.
 setTimeout(()=>void api.check().then(r=>{if(r.status==='available'){button.title='Update '+r.latest+' is available';button.dataset.updateAvailable='true';}}).catch(()=>{}),7000);
})();
