/* Jig Studio 4.2 | Vice Edition shell. Visual feedback only; never writes customer data. */
(()=>{
 'use strict';
 const d=document;
 if(!d.documentElement.classList.contains('desktop-native'))return;
 d.documentElement.classList.add('vice-edition');
 const title=d.querySelector('.headerTitle strong');
 const label=d.querySelector('.sidebar-brand small');
 const modeTitle={site:'Admin · Desktop',admin:'Full Website Admin',jig:'Jigging',email:'Email Bank'};
 if(label)label.textContent='VICE EDITION  /  PRIVATE OWNER';
 const current=()=>d.querySelector('.appTabs .tabButton.on')?.dataset.tab||'site';
 const refreshTitle=()=>{
  const name=modeTitle[current()]||'ACO Studio';
  d.title=name+'  |  SLABSNGRABSACO ACO Studio';
  if(title)title.textContent=name;
 };
 d.querySelectorAll('.appTabs .tabButton').forEach(button=>button.addEventListener('click',refreshTitle));
 refreshTitle();
 // Header status reflects real connection; no fake online indicator.
 const headerRight=d.querySelector('.headerRight');
 const status=d.getElementById('siteConnection');
 if(headerRight&&status){
  const pill=d.createElement('span');pill.className='viceSyncPill';pill.id='viceSyncPill';pill.setAttribute('aria-live','polite');
  const dot=d.createElement('span');dot.className='viceSyncDot';dot.setAttribute('aria-hidden','true');
  const text=d.createElement('span');text.textContent='SITE OFFLINE';pill.append(dot,text);
  headerRight.prepend(pill);
  const update=()=>{
   const ready=status.classList.contains('ready');
   pill.classList.toggle('ready',ready);
   text.textContent=ready?'SITE CONNECTED':'SITE OFFLINE';
  };
  new MutationObserver(update).observe(status,{attributes:true,attributeFilter:['class']});
  update();
 }
})();
