 // Owner-initiated new Email Bank setup, non-destructive and local-only.
 // Existing encrypted bank ciphertext is archived under a distinct key BEFORE
 // removing its active pointer. Nothing decrypts or alters the old ciphertext.
 const NEW_SETUP_PENDING='sng.sarl.emailgen.bank.new-setup-pending.v1';
 function setupNewEmailBankReset(){
  const gate=$e('emailGate');if(!gate)return;
  const button=document.createElement('button');button.type='button';button.id='startNewEmailBank';button.className='btn secondary';
  button.textContent='Start New Email Bank (keep old bank archived)';
  const feedback=document.createElement('p');feedback.id='startNewEmailBankStatus';feedback.className='tiny';feedback.setAttribute('role','status');
  gate.append(button,feedback);
  const update=()=>{
   let current=null,pending=null;
   try{current=localStorage.getItem(KEY);pending=localStorage.getItem(NEW_SETUP_PENDING);}catch(error){feedback.textContent='Local storage unavailable; no bank was changed.';button.disabled=true;return;}
   button.disabled=!!pending||!current;
   if(pending)feedback.textContent='The previous encrypted Email Bank is archived. Enter a NEW passphrase above to create your fresh bank. Your existing Cloudflare account and token can be reused.';
   else if(!current)feedback.textContent='No existing encrypted Email Bank found. Enter a new passphrase above to create your first bank.';
  };
  button.onclick=()=>{
   if(unlocked){feedback.textContent='Please lock Email Gen before starting a separate new bank.';return;}
   try{
    const current=localStorage.getItem(KEY);
    if(!current)throw Error('No active encrypted bank found. Create your new bank through the normal unlock form.');
    if(localStorage.getItem(NEW_SETUP_PENDING))throw Error('A new setup is already pending. Enter your chosen new passphrase above.');
    if(!window.confirm('Start an EMPTY Email Bank? Existing aliases will not appear in the new bank. Your old encrypted bank will be archived locally, and your external Cloudflare routing rules will NOT be changed. Continue?'))return;
    if(window.prompt('To confirm you are creating a NEW, empty Email Bank, type START NEW BANK:')!=='START NEW BANK')return;
    const bytes=crypto.getRandomValues(new Uint8Array(8));
    const unique=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    const archive=KEY+'.archive.'+Date.now()+'.'+unique;
    // A failed or quota-limited archive MUST NOT remove the original.
    localStorage.setItem(archive,current);
    if(localStorage.getItem(archive)!==current)throw Error('Encrypted archive could not be verified. The original Email Bank was not changed.');
    localStorage.setItem(NEW_SETUP_PENDING,archive);
    if(localStorage.getItem(NEW_SETUP_PENDING)!==archive)throw Error('New setup marker was not saved. Original Email Bank was not changed.');
    localStorage.removeItem(KEY);
    if(localStorage.getItem(KEY)!==null){
     localStorage.removeItem(NEW_SETUP_PENDING);
     throw Error('Could not deactivate the old bank; the original remains unchanged.');
    }
    feedback.textContent='Encrypted previous bank safely archived. Enter a NEW Email Bank passphrase (12+ characters) above, keeping your existing Cloudflare Account ID, Zone ID and token. The archive is preserved.';
    button.disabled=true;
  }catch(error){feedback.textContent='New bank setup was not completed: '+String(error?.message||error)+'. Your archived bank, if created, remains preserved.';}
  };
  update();
 }
