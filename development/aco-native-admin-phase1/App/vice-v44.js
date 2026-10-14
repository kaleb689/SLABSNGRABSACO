/* Miami Vice 4.4 real desktop controls and navigation; actual data comes from authenticated website. */
(()=>{'use strict';
 const d=document,api=window.desktopAPI;
 if(!d.documentElement.classList.contains('desktop-native'))return;
 d.documentElement.classList.add('vice-v44');
 const title=d.querySelector('.sidebar-brand strong');
 if(title)title.textContent='ACO STUDIO';
 const status=d.querySelector('.sidebar-brand small');if(status)status.textContent='VICE EDITION / PRIVATE OWNER';
 const buttonBar=d.querySelector('.headerRight');
 if(buttonBar&&api?.windowControls){
  const container=d.createElement('div');container.className='viceWindowActions';container.setAttribute('role','group');container.setAttribute('aria-label','Window controls');
  for(const [type,text,description] of [['minimize','—','Minimize window'],['maximize','□','Maximize or restore window'],['close','×','Close ACO Studio']]){
   const b=d.createElement('button');b.type='button';b.className='viceWindowControl '+type;
   b.setAttribute('aria-label',description);b.setAttribute('title',description);b.textContent=text;
   b.addEventListener('click',async()=>{try{await api.windowControls[type]();}catch(error){d.getElementById('runtimeNotice').textContent=error.message||'Window action unavailable.';}});
   container.append(b);
  }
  buttonBar.append(container);
 }
 // Extend the current working sidebar; every new menu item invokes an existing real action.
 const nav=d.querySelector('.appTabs');
 if(nav){
  const items=[
   ['retailers','▣','Retailer Accounts',()=>{d.querySelector('.tabButton[data-tab="site"]')?.click();d.getElementById('siteBack')?.click();d.getElementById('siteSearch')?.focus();}],
   ['import','↓','Import Data',()=>d.dispatchEvent(new CustomEvent('jigstudio:navigate-stage',{detail:{stage:'import'}}))],
   ['settings','⚙','Jig Settings',()=>d.dispatchEvent(new CustomEvent('jigstudio:navigate-stage',{detail:{stage:'settings'}}))],
   ['notifications','♧','Notifications',()=>{d.querySelector('.tabButton[data-tab="site"]')?.click();d.getElementById('siteNotifications')?.click();}],
  ];
  const siteTab=nav.querySelector('[data-tab="site"]'),jigTab=nav.querySelector('[data-tab="jig"]');
  if(siteTab)siteTab.querySelector('span:nth-child(2)').textContent='Admin · Desktop';
  for(const [key,icon,label,action] of items){
   const b=d.createElement('button');b.type='button';b.className='tabButton viceSideQuick';b.dataset.quick=key;
   b.innerHTML='<span class="viceSideIcon">'+icon+'</span><span>'+label+'</span>';
   b.addEventListener('click',action);
   if(key==='retailers')siteTab?.after(b);
   else if(key==='import')jigTab?.after(b);
   else nav.append(b);
  }
  const emailTab=nav.querySelector('[data-tab="email"]');if(emailTab){emailTab.querySelector('span:nth-child(2)').textContent='Email Gen';}
 }
 const tiles=d.getElementById('viceFeatureGrid');if(tiles)tiles.addEventListener('click',e=>{
  const b=e.target.closest('[data-vice-action]');if(!b)return;
  const action=b.dataset.viceAction;
  if(action==='studio')d.querySelector('.tabButton[data-tab="jig"]')?.click();
  else d.dispatchEvent(new CustomEvent('jigstudio:navigate-stage',{detail:{stage:action}}));
 });
 const runtime=d.getElementById('runtimeNotice');
 if(runtime)runtime.textContent=(api?.windowControls?'● LOCAL WORKSPACE READY  •  Files stay on this device':'BROWSER PREVIEW  •  Launch the installed Jig Studio application');
 d.title='SLABSNGRABSACO ACO Studio  |  Vice Edition';
})();
