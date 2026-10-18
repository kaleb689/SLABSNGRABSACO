(()=>{'use strict';
const security=window.desktopAPI?.ownerSecurity;
if(!security?.touchId)return;
let prompted=false;
async function promptTouchId(){
 if(prompted)return;prompted=true;
 const notice=document.getElementById('siteNotice');
 try{
  const result=await security.touchId();
  if(result?.verified===true&&result?.session===true){
   if(notice){notice.textContent='Touch ID unlocked the live Admin session.';notice.dataset.error='false';}
   document.documentElement.dataset.ownerTouchId='verified';
   document.dispatchEvent(new CustomEvent('aco:admin-session-ready'));
   return;
  }
  if(result?.verified===true&&result?.needsEnrollment===true){
   if(notice){notice.textContent=result?.reason||'Sign in once with the Admin password and authenticator to enable Touch ID on this Mac.';notice.dataset.error='true';}
   document.documentElement.dataset.ownerTouchId='needs-enrollment';
   return;
  }
  if(result?.available===false){
   if(notice){notice.textContent='Touch ID is unavailable on this Mac. Use the existing owner sign-in controls.';notice.dataset.error='true';}
   document.documentElement.dataset.ownerTouchId='unavailable';
   return;
  }
  if(notice){notice.textContent=result?.reason||'Touch ID was not completed. Use the existing owner sign-in controls.';notice.dataset.error='true';}
  document.documentElement.dataset.ownerTouchId='failed';
 }catch(error){
  if(notice){notice.textContent=String(error?.message||error||'Unable to open Touch ID.');notice.dataset.error='true';}
  document.documentElement.dataset.ownerTouchId='failed';
 }
}
window.addEventListener('focus',()=>{if(document.documentElement.dataset.ownerTouchId==='needs-enrollment')prompted=false;},{passive:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',promptTouchId,{once:true});
else void promptTouchId();
})();
