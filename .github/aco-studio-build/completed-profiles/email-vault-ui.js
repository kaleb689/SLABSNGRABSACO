/* Retailer email imports and profile creation, always for one explicit vault. */
(()=>{'use strict';
 const d=document,api=window.desktopAPI?.profileWorkshop;if(!api?.generate)return;
 const retail={target:'Target',walmart:'Walmart',pokemoncenter:'Pokémon Center',costco:'Costco',sams:"Sam’s Club"};
 const modal=d.createElement('div');modal.className='workshopModal';modal.hidden=true;
 modal.innerHTML=`<div class="workshopBox" role="dialog" aria-modal="true" aria-labelledby="emailVaultTitle"><div class="workshopHead"><div><h2 id="emailVaultTitle">Create Profiles from Pools</h2><p data-selected-count role="status" aria-live="polite"></p></div><button type="button" class="btn plain" data-close>X</button></div>
 <div class="workshopForm"><label>Vault<select data-owner></select></label><label>Retailer<select data-retailer>${Object.entries(retail).map(([id,label])=>`<option value="${id}">${label}</option>`).join('')}</select></label></div>
 <p data-destination></p><p data-counts></p><p data-selection-review role="status">Select specific unused accounts below, or choose a count for the oldest available accounts.</p><details><summary>Email pool — unused / used</summary><div data-email-list></div></details><details><summary>Import more emails (optional)</summary><p>Paste plain email addresses or email:password login pairs, one per line. TXT, CSV and JSON email imports are also supported. Login pairs are reviewed and saved as available retailer accounts; repeated emails are checked before import.</p><textarea data-emails rows="5" aria-label="Emails to import" style="width:100%"></textarea><input data-file type="file" accept=".txt,.csv,.json" aria-label="Import email file"><button data-import class="btn secondary" type="button">Import into selected vault</button></details>
 <details data-login-details open><summary>Paste retailer account logins</summary><p>Paste accounts as email:password, email:::password, email; password, email,password, or tab-separated login pairs. Password punctuation is preserved. Choose the vault and retailer above, then review and confirm. Existing account entries are never overwritten.</p><textarea data-login-pairs rows="7" spellcheck="false" autocomplete="off" aria-label="Retailer account logins" style="width:100%"></textarea><button type="button" data-login-import class="btn secondary">Review and save pasted logins</button></details><details open><summary>Bulk create from saved pools — no import required</summary><div class="workshopForm"><label>Number of profiles<input data-count type="number" min="1" max="500" value="1"></label><label>Format<select data-format><option value="shikari">Shikari CSV</option><option value="valor">Valor JSON</option></select></label></div><p>Reuse saved addresses and assign unused cards to free retailer accounts or unused emails already in this vault.</p><p data-capacity role="status" aria-live="polite"></p><details open><summary>Saved addresses</summary><div data-addresses></div></details><details open><summary>Unused saved cards</summary><div data-cards></div></details><label class="workshopCheck" hidden><input data-reuse type="checkbox" disabled> Card reuse within a retailer is prohibited; Hard Cards are available once per retailer.</label><label class="workshopCheck"><input data-names type="checkbox" checked> Randomize names; shipping and billing names match</label><button data-generate class="btn primary" type="button">Create profiles in selected vault</button></details><p data-status role="status" aria-live="polite"></p></div>`;
 d.body.append(modal);const $=s=>modal.querySelector('[data-'+s+']');let epoch=0,busy=false,availableAccounts=0,selectedAccountIds=new Set(),availableEmailRows=[];
 const scope=()=>{if(!$('owner').value)throw Error('Select a customer vault.');return $('owner').value==='personal'?{scope:'personal',customerId:null}:{scope:'aco',customerId:$('owner').value.slice(4)};};
 const request=()=>({...scope(),retailer:$('retailer').value});
 const note=s=>{$('status').textContent=s;};
 function pending(on){busy=on;for(const x of modal.querySelectorAll('button,input,select,textarea'))x.disabled=on;if(!on)capacity();}
 function capacity(){const selected=kind=>$(kind).querySelectorAll('input:checked').length,addresses=selected('addresses'),cards=selected('cards'),chosen=selectedAccountIds.size;
   const max=addresses&&cards?Math.min(500,availableAccounts,cards,chosen||500):0;
   $('count').readOnly=false;
   const n=Number($('count').value);$('count').max=String(max);
   $('selected-count').textContent=chosen+' account(s) selected · '+(Number.isInteger(n)&&n>0?n:0)+' requested';
   $('capacity').textContent=addresses+' saved addresses | '+cards+' eligible saved cards | '+availableAccounts+' unused accounts | '+(chosen?chosen+' explicitly selected account(s)':'No individual accounts selected — the first '+n+' eligible accounts will be used')+' | Can create '+max+' profiles.';
   $('selection-review').textContent=chosen?chosen+' account(s) selected. Creating '+(Number.isInteger(n)&&n>0?n:0)+' from this selection, in the order shown below. Selected emails: '+availableEmailRows.filter(x=>selectedAccountIds.has(x.id)).map(x=>x.email).join(', ').slice(0,1200):'Choose specific unused accounts using the checkboxes below, or leave all unchecked to use the first available accounts.';
   $('generate').disabled=busy||!Number.isInteger(n)||n<1||n>max;
  }
 async function unlock(p){if(p.scope==='personal'&&!await window.JigPersonalGuard?.ensureUnlocked?.())throw Error('Unlock your private vault first.');}
 function rows(kind,items){$(kind).replaceChildren();for(const item of items){const l=d.createElement('label'),c=d.createElement('input'),t=d.createElement('span');l.className='workshopCheck';c.type='checkbox';c.value=item.id;c.checked=true;c.addEventListener('change',capacity);t.textContent=kind==='cards'?[item.label,item.number||('ending '+item.last4),item.expMonth+'/'+item.expYear].join(' | '):[item.label,item.address1,item.address2,item.city,item.zip].filter(Boolean).join(' | ');l.append(c,t);$(kind).append(l);}if(!items.length)$(kind).textContent='No saved '+kind+' available. Add them using Cards & Addresses Vault for this owner.';}
 async function refresh(){if(!$('owner').value){$('addresses').replaceChildren();$('cards').replaceChildren();$('email-list').replaceChildren();$('counts').textContent='';availableAccounts=0;capacity();$('destination').textContent='Select a customer vault.';note('Choose a customer before importing or creating profiles.');return;}const ticket=++epoch,p=request();$('addresses').replaceChildren();$('cards').replaceChildren();$('email-list').replaceChildren();$('counts').textContent='';$('destination').textContent='Destination: '+$('owner').selectedOptions[0].textContent+' / '+retail[p.retailer];pending(true);
  try{await unlock(p);const [emails,assets]=await Promise.all([api.emails(p),api.assets(p)]);if(ticket!==epoch||modal.hidden)return;
   availableAccounts=emails.availableForCreation??emails.emails.filter(x=>x.status==='available').length;
   const unused=emails.emails.filter(x=>x.status==='available'&&x.source!=='account').length;
   const coverage=emails.targetLiveReconciliation;
   $('counts').textContent=assets.addresses.length+' saved addresses | '+assets.cards.filter(x=>x.unused).length+' unused cards | '+(emails.freeAccounts||0)+' free retailer accounts | '+unused+' unused '+retail[p.retailer]+' emails'+
    (p.retailer==='pokemoncenter'&&coverage?.targetLiveProfiles?
     ' | Target Live: '+coverage.targetLiveProfiles+' profiles ('+coverage.targetUniqueEmails+' unique emails) | Already have PKC profiles: '+coverage.alreadyPkcProfiles+' | Target emails accounted for in PKC profiles/pools: '+coverage.pkcCoverage+'/'+coverage.targetUniqueEmails+
     (coverage.added?' | Recovered '+coverage.added+' missing PKC pool emails':''):'');

   availableEmailRows=emails.emails.filter(x=>x.status==='available');
    selectedAccountIds=new Set([...selectedAccountIds].filter(id=>availableEmailRows.some(x=>x.id===id)));
    $('email-list').replaceChildren();
    for(const email of emails.emails){
     const line=d.createElement('label');line.className='workshopCheck';
     if(email.status==='available'){
      const box=d.createElement('input');box.type='checkbox';box.value=email.id;box.checked=selectedAccountIds.has(email.id);
      box.addEventListener('change',()=>{if(box.checked)selectedAccountIds.add(email.id);else selectedAccountIds.delete(email.id);if(selectedAccountIds.size)$('count').value=String(selectedAccountIds.size);capacity();});
      line.append(box);
     }
     const label=d.createElement('span');label.textContent=email.email+' | '+(email.status==='available'?'Unused '+(email.source==='account'?'retailer account':'email bank'):'Already used');
     line.append(label);$('email-list').append(line);
    }
    rows('addresses',assets.addresses);rows('cards',assets.cards.filter(x=>x.unused));capacity();note(p.retailer==='pokemoncenter'&&coverage?.targetLiveProfiles?'PKC count separates already used PKC profiles from unused PKC emails. '+coverage.pkcCoverage+' of '+coverage.targetUniqueEmails+' unique Target Live emails are accounted for; '+coverage.added+' missing pool entries repaired. Target profiles remain unchanged.':'Profiles use emails, cards and addresses from the displayed vault only.');
  }catch(e){if(ticket===epoch)note(e.message);}finally{if(ticket===epoch)pending(false);}
 }
 function values(text,name='emails.txt'){
  if(text.length>2000000)throw Error('Import a file smaller than 2 MB.');
  if(/\.json$/i.test(name)){const v=JSON.parse(text),a=Array.isArray(v)?v:Array.isArray(v.emails)?v.emails:Object.values(v);return a.map(x=>typeof x==='string'?x:x?.email||'');}
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.trim());
  // CSV parsing includes quoted columns; an email header selects the column.
  const parse=line=>{const out=[];let value='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){value+='"';i++;}else q=!q;}else if(!q&&/[,;\t]/.test(c)){out.push(value.trim());value='';}else value+=c;}out.push(value.trim());return out;};
  const head=lines.length?parse(lines[0]):[],col=head.findIndex(x=>/^(email|account.?email|login.?email)$/i.test(x));
  return lines.slice(col<0?0:1).map(l=>parse(l)[Math.max(col,0)]);
 }
 $('file').addEventListener('change',async()=>{const file=$('file').files[0];if(!file)return;const ticket=epoch;try{if(file.size>2000000)throw Error('Import a file smaller than 2 MB.');const text=await file.text();if(ticket!==epoch||modal.hidden)return;if(/\.(?:txt|csv|tsv)$/i.test(file.name)&&text.split(/\r?\n/).some(line=>/^[^\s@,;:|]+@[^\s@,;:|]+\.[^\s@,;:|]+\s*(?::|;|,|\t|\|)/.test(line))){
     $('login-pairs').value=text;$('emails').value='';$('login-details').open=true;note('Account login pairs ready. Choose the retailer and review before saving.');
    }else{$('emails').value=values(text,file.name).join('\n');note('File ready. Review the destination and click Import.');}}catch(e){note(e.message);}});
 for(const key of ['owner','retailer'])$(key).addEventListener('change',()=>{selectedAccountIds.clear();availableEmailRows=[];$('login-pairs').value='';$('emails').value='';$('file').value='';$('format').value=$('retailer').value==='target'?'shikari':'valor';void refresh();});
 $('import').addEventListener('click',async()=>{if(busy)return;if(!$('owner').value){note('Select a customer vault.');return;}const raw=$('emails').value,lines=raw.replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.trim());
  const accountLine=/^[^\s@,;:|]+@[^\s@,;:|]+\.[^\s@,;:|]+\s*(?::|;|,|\t|\|)/;
  if(lines.some(line=>accountLine.test(line.trim()))){
   $('login-pairs').value=raw;$('emails').value='';$('login-details').open=true;$('login-import').click();return;
  }
  const p=request(),ticket=epoch;pending(true);try{await unlock(p);const r=await api.importEmails({...p,emails:values($('emails').value)});if(ticket!==epoch)return;$('emails').value='';$('file').value='';await refresh();note('Imported '+r.added+' emails. Skipped '+r.skipped+' duplicates/already used; '+r.invalid+' invalid entries.');}catch(e){note(e.message);}finally{pending(false);}});
 $('login-import').addEventListener('click',async()=>{
  if(busy)return;
  if(!$('owner').value){note('Select a vault and retailer first.');return;}
  const p=request(),raw=$('login-pairs').value;
  if(!raw.trim()){note('Paste one or more account logins.');return;}
  if(raw.length>2_000_000){note('Import smaller batches (under 2 MB).');return;}
  let rows;
  try { rows=window.ACOAccountLoginParser?.parse(raw);if(!rows)throw Error('Account paste parser unavailable.'); }
  catch(error){note(error.message);return;}
  const lib=window.desktopAPI?.profileLibrary;
  if(!lib?.importPreview||!lib?.importCommit){note('Profile import service unavailable.');return;}
  const ticket=epoch;pending(true);
  try{
   await unlock(p);
   const plan=await lib.importPreview({...p,fileName:'pasted-logins.json',text:JSON.stringify(rows)});
   if(ticket!==epoch||modal.hidden)return;
   const duplicates=plan.profiles.filter(x=>(x.duplicates||[]).includes('email')).length;
   if(duplicates)throw Error(duplicates+' email(s) already exist in this retailer bank. Review duplicates first.');
   const review=rows.slice(0,12).map(x=>x.email+' · password provided').join('\n');
   if(!confirm('Review '+rows.length+' pasted account(s)\\nDestination: '+$('owner').selectedOptions[0].textContent+' / '+retail[p.retailer]+'\\n\\n'+review+(rows.length>12?'\\n...and '+(rows.length-12)+' more':'')+'\\n\\nConfirm import?'))return;
   const result=await lib.importCommit({token:plan.token,confirmed:true,asAvailable:true,alreadyJigged:false,repairs:{allowShared:true}});
   $('login-pairs').value='';await refresh();
   note('Saved '+result.imported+' retailer logins in the selected encrypted vault. Use these available accounts when creating profiles.');
  }catch(e){note(e.message||'Import failed.');}finally{pending(false);}
 });
 $('generate').addEventListener('click',async()=>{if(busy)return;if(!$('owner').value){note('Select a customer vault.');return;}const p=request(),ticket=epoch;pending(true);try{await unlock(p);const selected=kind=>[...$(kind).querySelectorAll('input:checked')].map(x=>x.value);const count=Number($('count').value);capacity();if(!Number.isInteger(count)||count<1||count>Number($('count').max))throw Error('Choose a quantity within the available pool capacity.');const exactIds=selectedAccountIds.size?availableEmailRows.filter(x=>selectedAccountIds.has(x.id)).slice(0,count).map(x=>x.id):null;
    if(exactIds&&exactIds.length!==count)throw Error('Account selection changed. Review the number to jig.');
    const addressIds=selected('addresses'),cardIds=selected('cards');
    if(!confirm('REVIEW before generating '+count+' '+retail[p.retailer]+' profile(s) in '+$('owner').selectedOptions[0].textContent+
      '\\nSelected accounts: '+(exactIds?availableEmailRows.filter(x=>exactIds.includes(x.id)).map(x=>x.email).join(', ').slice(0,2000):'First '+count+' available accounts')+
      '\\nSaved addresses: '+addressIds.length+' · distinct eligible cards: '+cardIds.length+
      '\\nThe program will apply the saved profile rules. Review the resulting profiles before exporting or moving to Live. Continue?'))return;
    const r=await api.generate({...p,count,emailIds:exactIds,format:$('format').value,addressIds,cardIds,allowCardReuse:false,randomNames:$('names').checked});if(ticket!==epoch)return;await refresh();void window.ACOProfileBank?.refresh?.();d.dispatchEvent(new CustomEvent('jigstudio:pools-generated'));note('Created '+r.created+' profiles in '+$('owner').selectedOptions[0].textContent+' / '+retail[p.retailer]+'. Open Profiles to review, jig or export.');}catch(e){note(e.message);}finally{pending(false);}});
 function close(force=false){if(busy&&!force)return;epoch++;selectedAccountIds.clear();availableEmailRows=[];modal.hidden=true;$('login-pairs').value='';$('emails').value='';$('file').value='';$('addresses').replaceChildren();$('cards').replaceChildren();$('email-list').replaceChildren();pending(false);}
 $('close').addEventListener('click',()=>close());d.addEventListener('jigstudio:personal-locked',()=>{if($('owner').value==='personal'){close(true);note('Private vault locked.');}});modal.addEventListener('keydown',e=>{if(e.key==='Escape')close();if(e.key==='Tab'){const nodes=[...modal.querySelectorAll('button,input,select,textarea,summary')].filter(x=>!x.disabled&&x.getClientRects().length),a=nodes[0],b=nodes.at(-1);if(e.shiftKey&&d.activeElement===a){e.preventDefault();b.focus();}else if(!e.shiftKey&&d.activeElement===b){e.preventDefault();a.focus();}}});
 async function open(context){if(busy)return;selectedAccountIds=new Set(Array.isArray(context?.emailIds)?context.emailIds:[]);availableEmailRows=[];$('owner').replaceChildren();const option=(value,label)=>{const o=d.createElement('option');o.value=value;o.textContent=label;$('owner').append(o);};option('personal','My private vault');for(const c of window.JigWebsiteCustomers?.list?.()||[])option('aco:'+c.id,c.name||c.id);
  const bank=window.ACOProfileBank?.context?.(),active=window.JigStudioLocalImport?.workspaceScope?.();if(active==='aco'){if(!bank?.customerId){option('','Choose customer');$('owner').value='';}else $('owner').value='aco:'+bank.customerId;}
  if(context?.scope){$('owner').value=context.scope==='personal'?'personal':'aco:'+context.customerId;}if(context?.retailer)$('retailer').value=context.retailer;if(selectedAccountIds.size)$('count').value=String(selectedAccountIds.size);$('format').value=$('retailer').value==='target'?'shikari':'valor';modal.style.zIndex='12000';modal.hidden=false;if(context?.openLogin)$('login-details').open=true;await refresh();(context?.openLogin?$('login-pairs'):$('close')).focus();}
 for(const key of ['count','reuse'])$(key).addEventListener('input',capacity);
 window.ACOPoolCreator=Object.freeze({open});
 const button=d.createElement('button');button.type='button';button.className='btn secondary';button.textContent='Email Vault / Create Profiles';button.addEventListener('click',()=>void open());d.getElementById('profileWorkshop')?.querySelector('.workshopHead .buttons')?.append(button);
})();

