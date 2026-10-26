 // Owner-only automatic Cloudflare reauthorization. The remembered secret is
 // macOS Keychain-encrypted in the Electron main process, never localStorage.
 let rememberedLoginBusy=false;
 function setupRememberedOwnerControls(){
  const gate=$e('emailGate');
  if(!gate)return;
  const outer=document.createElement('div');outer.className='buttons';outer.style.marginTop='12px';
  const retry=document.createElement('button');retry.type='button';retry.className='btn secondary';
  retry.textContent='Reconnect saved Cloudflare login';retry.id='reconnectSavedCloudflare';
  const forget=document.createElement('button');forget.type='button';forget.className='btn secondary';
  forget.textContent='Forget this Mac';forget.id='forgetSavedCloudflare';
  const note=document.createElement('p');note.id='rememberedCloudflareStatus';note.setAttribute('role','status');note.className='tiny';
  gate.append(outer,note);outer.append(retry,forget);
  retry.onclick=()=>void restoreRememberedOwner();
  forget.onclick=async()=>{
   if(!window.confirm('Forget the saved Cloudflare token and Email Bank passphrase on this Mac? Your existing encrypted Email Bank and profiles will NOT be deleted.'))return;
   try{
    await api().forgetRemembered();
    await logout();
    note.textContent='Only saved login credentials were removed from this Mac. Your encrypted Email Bank remains saved.';
   }catch(error){note.textContent='Unable to forget saved login: '+String(error?.message||error);}
  };
 }
 async function restoreRememberedOwner(){
  if(unlocked||rememberedLoginBusy||typeof api()?.restoreRemembered!=='function')return;
  rememberedLoginBusy=true;
  try{
   const result=await api().restoreRemembered();
   if(!result?.stored)return;
   if(!result.restored){
    $e('rememberedCloudflareStatus').textContent='Your owner credentials are still securely saved on this Mac. Cloudflare is unreachable or requires renewed authorization. Click Reconnect saved Cloudflare login to retry without re-entering anything.';
    return;
   }
   try{await unlockBank(result.passphrase);}
   catch(error){
    await api().lock().catch(()=>{});
    throw Error('The saved Email Bank passphrase could not unlock this bank. Your stored credentials and bank remain unchanged.');
   }
   $e('gateAccount').value='';$e('gateZone').value='';$e('gateToken').value='';$e('gatePassphrase').value='';
   $e('emailDomain').value=OWNER_DOMAIN;$e('emailDomainPreview').textContent='@'+OWNER_DOMAIN;
   $e('emailTarget').value=records.find(r=>r.target)?.target||'';
   $e('emailGate').hidden=true;$e('emailPrivate').hidden=false;
   alertMessage('cfStatus','Cloudflare owner access and encrypted Email Bank restored automatically from this Mac Keychain.',true);
   render();
  }catch(error){
   $e('rememberedCloudflareStatus').textContent=String(error?.message||error)+'. No existing bank data was deleted.';
  }finally{rememberedLoginBusy=false;}
 }
