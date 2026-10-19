// Passkey controls for the full Admin dashboard (including an iPad-installed PWA).
// Registration uses the existing authenticated WebAuthn endpoints; keys never
// leave the authenticator and no biometric images are sent to this site.
(() => {
  "use strict";
  const byId=id=>document.getElementById(id);
  const decode64=value=>Uint8Array.from(atob(String(value).replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"=")),c=>c.charCodeAt(0));
  const encode64=value=>btoa(String.fromCharCode(...new Uint8Array(value))).replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
  const setup=byId("adminPasskeySetup");
  const login=byId("adminPasskeyLogin");
  const setupStatus=byId("adminPasskeySetupStatus");
  const loginStatus=byId("adminPasskeyLoginStatus");
  if(!setup&&!login)return;
  const desktopAco=/Electron/i.test(navigator.userAgent||"")||new URLSearchParams(location.search).get("acoDesktop")==="1";
  if(desktopAco){
    if(login)login.hidden=true;
    if(setup)setup.hidden=true;
    if(loginStatus)loginStatus.textContent="ACO Studio uses native macOS Touch ID after one full Admin password + authenticator sign-in on this Mac.";
    if(setupStatus)setupStatus.textContent="Desktop Touch ID enrollment is managed by ACO Studio.";
    return;
  }

  function assertSupported(){
    if(!window.isSecureContext||!window.PublicKeyCredential||!navigator.credentials?.create||!navigator.credentials?.get)
      throw new Error("This browser cannot use passkeys here. Open the secure SLABSNGRABSACO Admin page in iPad Safari and enable Face ID or Touch ID in device Settings.");
  }
  const errorText=err=>{
    if(err?.name==="NotAllowedError")return "Passkey access was cancelled, timed out, or biometrics are not configured. Check iPad Settings → Face ID & Passcode or Touch ID & Passcode, then try again.";
    if(err?.name==="InvalidStateError")return "This passkey is already registered. Sign out and use the biometric sign-in button.";
    if(err?.name==="SecurityError")return "Passkeys require the same secure website address for registration and sign-in.";
    return err?.message||"Passkey request failed.";
  };
  async function send(path,body){
    const response=await fetch(path,{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||"Passkey operation failed.");
    return result;
  }
  async function register(){
    assertSupported();
    const opts=await send("/api/admin/passkeys/register/options",{});
    const pk=opts.publicKey;
    pk.challenge=decode64(pk.challenge);
    pk.user.id=decode64(pk.user.id);
    pk.excludeCredentials=(pk.excludeCredentials||[]).map(c=>({...c,id:decode64(c.id)}));
    // Prefer the iPad's local Face ID / Touch ID authenticator, never an
    // unrelated cross-device credential if the user requested biometrics.
    pk.authenticatorSelection={...(pk.authenticatorSelection||{}),authenticatorAttachment:"platform"};
    const credential=await navigator.credentials.create({publicKey:pk});
    if(!credential)throw new Error("Passkey registration was cancelled.");
    await send("/api/admin/passkeys/register/verify",{
      requestId:opts.requestId,
      credential:{id:credential.id,type:credential.type,
        response:{clientDataJSON:encode64(credential.response.clientDataJSON),
          attestationObject:encode64(credential.response.attestationObject)}}
    });
  }
  async function signIn(){
    assertSupported();
    const opts=await send("/api/admin/passkeys/login/options",{});
    const pk=opts.publicKey;
    pk.challenge=decode64(pk.challenge);
    pk.allowCredentials=(pk.allowCredentials||[]).map(c=>({...c,id:decode64(c.id)}));
    const credential=await navigator.credentials.get({publicKey:pk});
    if(!credential)throw new Error("Passkey sign-in was cancelled.");
    await send("/api/admin/passkeys/login/verify",{
      requestId:opts.requestId,
      credential:{id:credential.id,type:credential.type,
        response:{authenticatorData:encode64(credential.response.authenticatorData),
          clientDataJSON:encode64(credential.response.clientDataJSON),
          signature:encode64(credential.response.signature)}}
    });
  }
  setup?.addEventListener("click",async()=>{
    setup.disabled=true;
    if(setupStatus)setupStatus.textContent="Opening your iPad passkey setup…";
    try{
      await register();
      if(setupStatus)setupStatus.textContent="Face ID / Touch ID sign-in enabled on this iPad. Sign out to try it.";
    }catch(err){if(setupStatus)setupStatus.textContent=errorText(err);}
    finally{setup.disabled=false;}
  });
  login?.addEventListener("click",async()=>{
    login.disabled=true;
    if(loginStatus)loginStatus.textContent="Opening Face ID / Touch ID…";
    try{
      await signIn();
      location.reload();
    }catch(err){if(loginStatus)loginStatus.textContent=errorText(err);}
    finally{login.disabled=false;}
  });
})();
