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
 function reconnectStatusMessage(reason){
  const messages={
   NO_SAVED_LOGIN:'No saved Cloudflare login was found on this Mac. Reconnect cannot retrieve a passphrase that was never saved. Use your original Email Bank passphrase in the manual Verify form; your bank was not changed.',
   KEYCHAIN_UNAVAILABLE:'macOS Keychain encryption is not available for this app session. Unlock your Mac Keychain and restart ACO Studio. The saved login and Email Bank remain unchanged.',
   KEYCHAIN_DECRYPT_FAILED:'The saved login exists but this Mac Keychain cannot decrypt it. Do not choose Forget this Mac. Recover Keychain access or enter your original Email Bank passphrase manually. Your encrypted bank was not changed.',
   CLOUDFLARE_TOKEN_REJECTED:'The saved Cloudflare API token was rejected or lacks required permissions. Enter a valid scoped Cloudflare token in the manual Verify form with your ORIGINAL Email Bank passphrase. Nothing was erased.',
   CLOUDFLARE_UNREACHABLE:'Cloudflare could not be reached. Check internet access and retry. Your saved login and bank remain unchanged.',
   CLOUDFLARE_AUTH_FAILED:'Cloudflare could not authorize the saved account/zone/token. Verify the saved domain and token permissions using the manual owner form. Your bank remains unchanged.',
   BANK_PASSPHRASE_MISMATCH:'Cloudflare accepted the saved login, but the saved Email Bank passphrase cannot decrypt the active bank. This may be an older bank or an incorrect saved passphrase. Recover your ORIGINAL Email Bank passphrase or its matching encrypted backup. No bank data was changed.',
   NEW_BANK_SETUP_PENDING:'A separate NEW empty Email Bank setup is pending. The old encrypted bank was archived. Complete or review that setup before attempting automatic saved-login restoration.'
  };
  return messages[reason]||'Saved Cloudflare reconnect was unsuccessful. Your encrypted bank and credentials remain unchanged.';
 }
 async function restoreRememberedOwner(){
  const note=$e('rememberedCloudflareStatus');
  if(unlocked){note.textContent='Email Gen is already unlocked.';return;}
  if(rememberedLoginBusy){note.textContent='Cloudflare reconnect is already in progress.';return;}
  if(localStorage.getItem(NEW_SETUP_PENDING)){note.textContent=reconnectStatusMessage('NEW_BANK_SETUP_PENDING');return;}
  if(typeof api()?.restoreRemembered!=='function'){note.textContent='This installation does not expose saved Cloudflare reconnect. Check the ACO Studio version and restart.';return;}
  rememberedLoginBusy=true;
  note.textContent='Checking this Mac Keychain and verifying saved Cloudflare owner access…';
  try{
   const result=await api().restoreRemembered();
   if(!result?.restored){
    note.textContent=reconnectStatusMessage(result?.reason||(!result?.stored?'NO_SAVED_LOGIN':'CLOUDFLARE_AUTH_FAILED'));
    return;
   }
   try{await unlockBank(result.passphrase);}
   catch(error){
    await api().lock().catch(()=>{});
    note.textContent=reconnectStatusMessage('BANK_PASSPHRASE_MISMATCH');
    return;
   }
   $e('gateAccount').value='';$e('gateZone').value='';$e('gateToken').value='';$e('gatePassphrase').value='';
   $e('emailDomain').value=OWNER_DOMAIN;$e('emailDomainPreview').textContent='@'+OWNER_DOMAIN;
   $e('emailTarget').value=records.find(r=>r.target)?.target||'';
   $e('emailGate').hidden=true;$e('emailPrivate').hidden=false;
   alertMessage('cfStatus','Cloudflare owner access and encrypted Email Bank restored from this Mac Keychain.',true);
   render();
  }catch(error){
   // Never expose tokens or passphrases in error messages or console logs.
   note.textContent='Saved-login recovery failed in the app. Your original encrypted Email Bank was not changed. Verify your Keychain access or use manual owner verification.';
  }finally{rememberedLoginBusy=false;}
 }
