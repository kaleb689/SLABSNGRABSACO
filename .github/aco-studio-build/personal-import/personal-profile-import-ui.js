/* Personal Jigs has its own file picker and immutable destination. */
(()=>{'use strict';
 const d=document,api=window.desktopAPI?.personalProfileImport,$=id=>d.getElementById(id);
 if(!api||!$('studioJigBanks'))return;
 const bar=d.createElement('div');bar.className='personalImportBar';
 bar.innerHTML='<div><strong>Personal profile imports</strong><small>Personal only. Never added to customer or shared pools.</small></div><button type="button" class="btn primary" id="importPersonalProfiles">Import Personal Profiles</button>';
 $('studioJigBanks').querySelector('.jigBanksScopes').after(bar);
 const modal=d.createElement('div');modal.className='profileReviewModal';modal.id='personalProfileImportModal';modal.hidden=true;
 modal.innerHTML=`<div class="profileReviewBox personalImportBox" role="dialog" aria-modal="true" aria-labelledby="personalImportTitle">
 <div class="profileReviewHead"><div><div class="eyebrow">DESTINATION LOCKED: PERSONAL ONLY</div><h2 id="personalImportTitle">Import Personal Profiles</h2><p>Your customer pools, saved addresses and card pools will not be changed.</p></div><button type="button" class="btn plain slim" id="personalImportClose" aria-label="Close Personal import">X</button></div>
 <div class="personalImportOptions"><label>Retailer<select id="personalImportRetailer"><option value="target">Target</option><option value="walmart">Walmart</option><option value="pokemoncenter">Pokemon Center</option><option value="costco">Costco</option><option value="sams">Sam's Club</option></select></label><button type="button" class="btn secondary" id="personalImportChoose">Choose profile files</button></div>
 <p class="tiny">CSV, TSV, PSV, JSON, JSONL, NDJSON or TXT. Up to 500 profiles per batch. Your original files are not edited.</p>
 <div class="personalImportStatus" id="personalImportStatus" role="status" aria-live="polite">Choose files to preview. Nothing is saved until you confirm.</div>
 <div id="personalImportPreview" hidden><div class="personalImportTotals" id="personalImportTotals"></div><details id="personalImportFiles"><summary>Selected files and profile preview</summary><div id="personalImportFileList"></div><div id="personalImportSamples"></div></details>
 <div id="personalImportConflictsWrap" hidden><details><summary id="personalImportConflictTitle">Duplicate email warnings</summary><div id="personalImportConflicts"></div></details><label class="personalImportCheck"><input type="checkbox" id="personalImportSkip"> Skip the flagged profiles. Do not merge, move or delete any existing account.</label></div>
 <div id="personalImportPartialWrap" hidden><p id="personalImportPartialReason"></p><label class="personalImportCheck"><input type="checkbox" id="personalImportPartial"> I understand the website check is incomplete. Continue with the checked local banks only.</label></div>
 <label class="personalImportCheck personalImportConfirm"><input type="checkbox" id="personalImportConfirm"> These are my personal profiles. Save them to Personal only.</label></div>
 <div class="profileReviewFooter"><small>PIN / Touch ID protected. No customer destination is available here.</small><button type="button" class="btn primary" id="personalImportSave" disabled>Import to Personal only</button></div></div>`;
 d.body.append(modal);let preview=null,busy=false,epoch=0;
 const note=(text,error=false)=>{$('personalImportStatus').textContent=text;$('personalImportStatus').classList.toggle('profileBankError',error);};
 function controls(){
  for(const id of ['personalImportChoose','personalImportRetailer','personalImportClose'])$(id).disabled=busy;
  $('personalImportSave').disabled=busy||!preview||!preview.ready||!$('personalImportConfirm').checked||
   (preview.skipped>0&&!$('personalImportSkip').checked)||(!preview.websiteComplete&&!$('personalImportPartial').checked);
  $('personalImportSave').textContent=busy?'Please wait...':preview?'Import '+preview.ready+' to Personal only':'Import to Personal only';
 }
 function clear(){preview=null;$('personalImportPreview').hidden=true;
  for(const id of ['personalImportFileList','personalImportSamples','personalImportConflicts','personalImportTotals'])$(id).replaceChildren();
  for(const id of ['personalImportConfirm','personalImportSkip','personalImportPartial'])$(id).checked=false;
  for(const node of modal.querySelectorAll('details'))node.open=false;controls();
 }
 function showPreview(value){clear();preview=value;$('personalImportPreview').hidden=false;
  $('personalImportTotals').textContent=value.total+' profiles found | '+value.ready+' ready | '+value.skipped+' flagged | PERSONAL ONLY';
  for(const file of value.files){const p=d.createElement('p');p.textContent=file.name+' - '+file.count+' profiles';$('personalImportFileList').append(p);}
  for(const row of value.sample){const p=d.createElement('p');p.textContent=row.label+' - '+row.email;$('personalImportSamples').append(p);}
  $('personalImportConflictsWrap').hidden=value.skipped===0;
  $('personalImportConflictTitle').textContent=value.skipped+' profile(s) flagged - review before continuing';
  for(const row of value.conflicts){const p=d.createElement('p');p.textContent=row.email+' - '+row.reason;$('personalImportConflicts').append(p);}
  $('personalImportPartialWrap').hidden=value.websiteComplete;
  $('personalImportPartialReason').textContent='Website duplicate check incomplete: '+value.websiteReason;
  note('Preview only. No profile, address or card bank has been changed.');controls();
 }
 async function close(force=false){if(busy&&!force)return;epoch++;modal.hidden=true;clear();await api.cancel().catch(()=>{});$('importPersonalProfiles').focus({preventScroll:true});}
 $('importPersonalProfiles').addEventListener('click',async()=>{
  if(busy)return;
  try{if(!await window.JigPersonalGuard.ensureUnlocked())return;clear();modal.hidden=false;note('Choose files to preview. Nothing is saved until you confirm.');$('personalImportRetailer').focus();}
  catch(error){$('jigBanksStatus').textContent=error.message;}
 });
 $('personalImportChoose').addEventListener('click',async()=>{
  if(busy)return;busy=true;const ticket=++epoch;clear();note('Reading selected files and checking duplicate emails...');
  try{const result=await api.choose($('personalImportRetailer').value);if(ticket!==epoch)return;
   if(result.cancelled)note('File selection cancelled. Nothing was imported.');else showPreview(result);
  }catch(error){if(ticket===epoch)note(error.message,true);}finally{busy=false;controls();}
 });
 $('personalImportRetailer').addEventListener('change',async()=>{epoch++;clear();await api.cancel().catch(()=>{});note('Retailer changed. Choose files again to create a fresh preview.');});
 for(const id of ['personalImportConfirm','personalImportSkip','personalImportPartial'])$(id).addEventListener('change',controls);
 $('personalImportSave').addEventListener('click',async()=>{
  if(busy||$('personalImportSave').disabled)return;busy=true;controls();let result;
  try{result=await api.confirm({token:preview.token,confirmPersonalOnly:$('personalImportConfirm').checked,
    skipDuplicates:$('personalImportSkip').checked,acknowledgePartialScan:$('personalImportPartial').checked});
   if(result.reviewRequired){showPreview(result.preview);note('Banks changed during review. Check the updated preview and confirm again.');return;}
   if(!result.saved)throw Error('Import was not saved.');
   if(!result.locked)await window.JigStudioLocalImport.loadPersonalImport(result.entries);
   modal.hidden=true;clear();
   $('jigBanksStatus').textContent=result.added+' profiles saved to PERSONAL ONLY. '+result.skipped+' flagged profiles skipped. Customer pools, addresses and card pools were not changed.';
   if(result.locked)$('jigBanksStatus').textContent+=' Personal locked after saving; unlock it to view them.';
   else await window.ACOProfileBank?.openPersonal?.(result.retailer);
  }catch(error){
   if(result?.saved){clear();note('Profiles were saved to Personal, but the workspace could not load them: '+error.message+'. Open your Personal profile vault; do not import again.',true);modal.hidden=false;}
   else note(error.message,true);
  }finally{busy=false;controls();}
 });
 $('personalImportClose').addEventListener('click',()=>void close());
 modal.addEventListener('click',e=>{if(e.target===modal)void close();});
 modal.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();void close();}
  if(e.key==='Tab'){const nodes=[...modal.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),summary')].filter(n=>n.getClientRects().length);
   const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&d.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&d.activeElement===last){e.preventDefault();first.focus();}}
 });
 d.addEventListener('jigstudio:personal-locked',()=>void close(true));
})();
