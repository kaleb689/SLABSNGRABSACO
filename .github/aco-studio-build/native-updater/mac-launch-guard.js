'use strict';
// The canonical owner app uses the same encrypted userData namespace in every
// release. One lock across app copies prevents extra running Dock instances.
// This does not delete old Dock pins or mutate user settings/vaults.
function guardOwnerInstance({app,BrowserWindow,platform=process.platform}={}){
 if(platform!=='darwin')return true;
 if(!app?.requestSingleInstanceLock?.({application:'ACO Studio Owner'})){
  app.exit(0);
  return false;
 }
 app.on('second-instance',()=>{
  // Never reveal a hidden owner workspace before its Admin sign-in. Focus only
  // an already-visible authenticated window or the visible login/splash UI.
  const windows=BrowserWindow.getAllWindows();
  const visible=windows.find(win=>!win.isDestroyed()&&win.isVisible());
  if(visible){
   if(visible.isMinimized())visible.restore();
   visible.show();visible.focus();
  }else{
   app.focus({steal:false});
  }
 });
 return true;
}
module.exports={guardOwnerInstance};
