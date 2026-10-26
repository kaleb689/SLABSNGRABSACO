 // Owner-initiated, NON-DESTRUCTIVE fresh Email Bank setup.
 // The active encrypted ciphertext must be byte-for-byte archived and verified
 // BEFORE its pointer is removed. This does not decrypt, reset a passphrase,
 // delete remote forwarding rules, or alter any other application data.
 // The desktop shell does not support native prompt dialogs: use an inline, explicit
 // typed confirmation and second checkbox instead of browser-native dialogs.
 const NEW_SETUP_PENDING='sng.sarl.emailgen.bank.new-setup-pending.v1';
 function setupNewEmailBankReset(){
  const gate=$e('emailGate');if(!gate)return;
  const button=document.createElement('button');
  button.type='button';button.id='startNewEmailBank';button.className='btn secondary';
  button.textContent='Use Email Gen with a New Bank (archive old bank)';
  const feedback=document.createElement('p');
  feedback.id='startNewEmailBankStatus';feedback.className='tiny';
  feedback.setAttribute('role','status');

  const review=document.createElement('section');
  review.id='newEmailBankConfirmPanel';review.className='panel section';
  review.hidden=true;
  const title=document.createElement('h3');
  title.textContent='Review before creating a separate empty bank';
  const warning=document.createElement('p');
  warning.textContent='This does NOT recover, unlock or repair your existing Email Bank. Its original encrypted contents remain in a verified local archive and still require the ORIGINAL passphrase to decrypt. The new bank starts EMPTY; your existing Cloudflare routing, profile banks, cards and addresses stay unchanged.';
  const label=document.createElement('label');
  label.textContent='To confirm, type START NEW BANK: ';
  const typed=document.createElement('input');
  typed.id='confirmStartNewBankPhrase';typed.type='text';
  typed.autocomplete='off';typed.spellcheck=false;
  typed.placeholder='START NEW BANK';
  label.append(typed);
  const checkLabel=document.createElement('label');checkLabel.className='check';
  const check=document.createElement('input');check.id='confirmStartNewBankArchive';check.type='checkbox';
  const checkText=document.createElement('span');
  checkText.textContent='I understand the old bank cannot be opened without its original passphrase and I want an EMPTY new bank.';
  checkLabel.append(check,checkText);
  const controls=document.createElement('div');controls.className='buttons';
  const cancel=document.createElement('button');
  cancel.id='cancelStartNewEmailBank';cancel.type='button';cancel.className='btn secondary';
  cancel.textContent='Cancel — keep existing bank';
  const commit=document.createElement('button');
  commit.id='confirmStartNewEmailBank';commit.type='button';commit.className='btn primary';
  commit.textContent='Archive existing bank and start empty';
  controls.append(cancel,commit);
  review.append(title,warning,label,checkLabel,controls);
  gate.append(button,feedback,review);

  const update=()=>{
   let current=null,pending=null;
   try{current=localStorage.getItem(KEY);pending=localStorage.getItem(NEW_SETUP_PENDING);}
   catch{feedback.textContent='Local storage unavailable; existing Email Bank was not changed.';button.disabled=true;review.hidden=true;return;}
   button.disabled=!!pending||!current;
   if(pending){
    feedback.textContent='Fresh Email Gen setup is ready. Use the Cloudflare Account ID, Zone ID and a VALID scoped API token above, choose a NEW passphrase (12+ characters), then click Verify owner & unlock Email Gen. The old encrypted bank remains archived; you do not need its passphrase for the NEW bank.';
    review.hidden=true;
   }else if(!current){
    feedback.textContent='No active encrypted Email Bank found. Use your Cloudflare Account ID, Zone ID, scoped API token, and a NEW passphrase (12+ characters) in the form above, then click Verify owner & unlock Email Gen. You do not need to reconnect saved credentials.';
    review.hidden=true;
   }
  };
  button.onclick=()=>{
   if(unlocked){feedback.textContent='Lock Email Gen before starting a separate empty bank.';return;}
   update();
   if(button.disabled)return;
   typed.value='';check.checked=false;review.hidden=false;
   feedback.textContent='Your existing bank has NOT changed. Review the warning and confirm both fields only if you want a NEW, EMPTY bank.';
  };
  cancel.onclick=()=>{typed.value='';check.checked=false;review.hidden=true;
   feedback.textContent='Cancelled. Existing encrypted Email Bank was not changed.';};
  commit.onclick=()=>{
   if(unlocked){feedback.textContent='Lock Email Gen before starting a separate empty bank.';return;}
   if(review.hidden||typed.value.trim()!=='START NEW BANK'||check.checked!==true){
    feedback.textContent='No changes made. Type START NEW BANK and check the confirmation box to create a separate EMPTY bank.';
    return;
   }
   commit.disabled=true;
   try{
    const current=localStorage.getItem(KEY);
    if(!current)throw Error('No active encrypted bank found. Use the normal setup form instead.');
    if(localStorage.getItem(NEW_SETUP_PENDING))throw Error('New setup already pending. Enter your NEW passphrase on the unlock form.');
    const bytes=crypto.getRandomValues(new Uint8Array(8));
    const unique=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    const archive=KEY+'.archive.'+Date.now()+'.'+unique;
    if(localStorage.getItem(archive)!==null)throw Error('Archive collision; nothing was changed.');
    localStorage.setItem(archive,current);
    if(localStorage.getItem(archive)!==current)
     throw Error('Encrypted archive verification failed. Original bank remains active.');
    localStorage.setItem(NEW_SETUP_PENDING,archive);
    if(localStorage.getItem(NEW_SETUP_PENDING)!==archive)
     throw Error('Pending setup marker could not be verified. Original bank remains active.');
    // Never delete or overwrite archived ciphertext. Retire ONLY the active
    // pointer after an exact, verified encrypted copy exists.
    try{
     if(localStorage.getItem(KEY)!==current)throw Error('Original Email Bank changed; review again.');
     localStorage.removeItem(KEY);
    }catch(error){
     if(localStorage.getItem(KEY)===current)
      try{localStorage.removeItem(NEW_SETUP_PENDING);}catch{}
     throw error;
    }
    if(localStorage.getItem(KEY)!==null)
     throw Error('Old active bank could not be deactivated. Its encrypted archive remains preserved.');
    typed.value='';check.checked=false;review.hidden=true;
    feedback.textContent='New Email Gen setup READY: enter your Cloudflare Account ID, Zone ID, valid API token and a NEW bank passphrase (12+ characters) in the form above, then click Verify owner & unlock Email Gen. This creates a new EMPTY bank without reconnecting. Your older encrypted aliases remain archived and need the original passphrase for recovery.';
    button.disabled=true;
    // Never clear a user-supplied Cloudflare API token or change remote rules.
    const passphrase=$e('gatePassphrase');if(passphrase){passphrase.value='';passphrase.focus?.();}
   }catch(error){
    feedback.textContent='New bank setup was NOT completed: '+String(error?.message||error)+'. Existing ciphertext has not been intentionally overwritten or deleted. Any verified archive remains preserved.';
    update();
   }finally{commit.disabled=false;}
  };
  update();
 }
