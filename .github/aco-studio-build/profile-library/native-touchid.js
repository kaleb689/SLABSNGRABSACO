(()=>{'use strict';
const security=window.desktopAPI?.ownerSecurity;
if(!security?.touchId)return;
let prompted=false;
async function promptTouchId(){
 if(prompted)return;prompted=true;
 const notice=document.getElementById('siteNotice');
 try{
  const result=await security.touchId();
  if(result?.verified===true){
   if(notice){notice.textContent='Touch ID verified for this ACO Studio session.';notice.dataset.error='false';}
   document.documentElement.dataset.ownerTouchId='verified';
   return;
  }
  if(result?.available===false){
   if(notice){notice.textContent='Touch ID is unavailable on this Mac. Use the existing owner sign-in/PIN controls.';notice.dataset.error='true';}
   document.documentElement.dataset.ownerTouchId='unavailable';
   return;
  }
  if(notice){notice.textContent=result?.reason||'Touch ID was not completed. Use the existing owner sign-in/PIN controls.';notice.dataset.error='true';}
  document.documentElement.dataset.ownerTouchId='failed';
 }catch(error){
  if(notice){notice.textContent=String(error?.message||error||'Unable to open Touch ID.');notice.dataset.error='true';}
  document.documentElement.dataset.ownerTouchId='failed';
 }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',promptTouchId,{once:true});
else void promptTouchId();
})();
