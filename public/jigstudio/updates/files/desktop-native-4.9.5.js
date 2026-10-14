/* Desktop-first app shell. Presentation only: existing account data and event handlers remain authoritative. */
(()=>{
 'use strict';
 const $=id=>document.getElementById(id);
 const d=document;
 const icons={
  customers:'<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="10" r="2"/><path d="M5.5 16c.8-2.4 6.2-2.4 7 0M15 9h3M15 13h3"/>',
  jig:'<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4z"/><path d="m14 17 2 2 4-5"/>',
  email:'<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m3.5 6 8 7 9-7"/>',
  update:'<path d="M20 7v-4l-4 4h4M4 17v4l4-4H4"/><path d="M5 10a7 7 0 0 1 12-4M19 14a7 7 0 0 1-12 4"/>',
  shield:'<path d="m12 2 8 3v6c0 5-3.5 8.4-8 11-4.5-2.6-8-6-8-11V5z"/><path d="m8.8 11.7 2.2 2.2 4.5-4.5"/>',
  arrow:'<path d="m5 12 14 0m-6-6 6 6-6 6"/>',
  check:'<path d="m5 12 4 4 10-10"/>'
 };
 const svg=k=>'<svg class="desktop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+icons[k]+'</svg>';
 const frame=d.querySelector('.desktop-frame');if(!frame)return;
 d.documentElement.classList.add('desktop-native');
 const modeNames={site:'Customers',jig:'Profile Studio',email:'Email Gen'};
 const tabIcons={site:'customers',jig:'jig',email:'email'};
 // The full-size logo is supplied with both installers. No remote image request.
 const emblem=d.querySelector('.sidebar-emblem');
 if(emblem){const img=d.createElement('img');img.src='./JigStudio.png';img.alt='';img.width=48;img.height=48;emblem.replaceChildren(img);}
 for(const tab of d.querySelectorAll('.appTabs .tabButton')){
  const icon=tab.querySelector('.navIcon');if(icon)icon.innerHTML=svg(tabIcons[tab.dataset.tab]||'jig');
  const chevron=tab.querySelector('b');if(chevron)chevron.textContent='';
 }
 const info=d.querySelector('.sidebar-rule');
 if(info){
  const label=d.createElement('div');label.className='sidebar-section-label secondary-navigation-label';label.textContent='QUICK ACTIONS';
  const quick=d.createElement('div');quick.className='sidebar-quick';
  const start=d.createElement('button');start.type='button';start.id='desktopQuickImport';start.innerHTML=svg('jig')+'<span>Import profiles</span>';
  const back=d.createElement('button');back.type='button';back.id='desktopQuickCustomers';back.innerHTML=svg('customers')+'<span>Customer directory</span>';
  quick.append(start,back);info.after(label,quick);
  start.addEventListener('click',()=>{d.querySelector('.tabButton[data-tab="jig"]')?.click();activateStage('import');});
  back.addEventListener('click',()=>{d.querySelector('.tabButton[data-tab="site"]')?.click();$('siteBack')?.click();});
 }
 const nativeStatus=d.createElement('div');nativeStatus.className='sidebar-native-status';
 nativeStatus.innerHTML='<span class="native-status-dot" aria-hidden="true"></span><div><strong id="nativeSiteStatus">Website disconnected</strong><small>Owner-only workspace</small></div>';
 d.querySelector('.sidebar-bottom')?.before(nativeStatus);
 const conn=$('siteConnection');
 const updateConn=()=>{
  const live=Boolean(conn?.classList.contains('ready'));
  nativeStatus.classList.toggle('connected',live);
  const line=$('nativeSiteStatus');if(line)line.textContent=live?'Website connected':'Website disconnected';
 };
 if(conn)new MutationObserver(updateConn).observe(conn,{attributes:true,attributeFilter:['class']});updateConn();
 const toolbar=d.querySelector('.desktop-content .top');
 if(toolbar){
  const title=toolbar.querySelector('.headerTitle strong'),crumb=toolbar.querySelector('.headerCrumb');
  const badge=toolbar.querySelector('.lozenge');if(badge)badge.innerHTML=svg('shield')+' PRIVATE WORKSPACE';
  const update=toolbar.querySelector('#jigUpdateButton');if(update)update.innerHTML=svg('update')+' Updates';
  const version=toolbar.querySelector('.version');
  if(version){
   // Always display the installed Electron package version, not the old skin version.
   // Keep an honest fallback in the browser preview and on IPC failures.
   const getInfo=window.desktopAPI?.updates?.info;
   version.textContent=typeof getInfo==='function'?'Checking version...':'Browser preview';
   if(typeof getInfo==='function'){
    Promise.resolve().then(()=>getInfo()).then(info=>{
     const installed=String(info?.version||'');
     if(!/^\d+\.\d+\.\d+$/.test(installed))throw Error('Invalid installed version');
     version.textContent='v'+installed;
     version.title='Installed Jig Studio version '+installed;
    }).catch(()=>{version.textContent='Version unavailable';});
   }
  }
  function updateTitle(mode){
   if(title)title.textContent=modeNames[mode]||'Jig Studio';
   if(crumb)crumb.innerHTML='<span>SLABSNGRABSACO</span> / DESKTOP APP';
   d.body.dataset.mode=mode;
  }
  for(const tab of d.querySelectorAll('.appTabs .tabButton'))tab.addEventListener('click',()=>updateTitle(tab.dataset.tab));
  updateTitle(d.querySelector('.appTabs .tabButton.on')?.dataset.tab||'site');
 }
 const nativeRun=Boolean(window.desktopAPI?.chooseLocalFiles);
 const notice=$('runtimeNotice');
 if(notice){notice.textContent=nativeRun?'LOCAL WORKSPACE READY • Files stay on this device':'BROWSER PREVIEW • Install Jig Studio and launch it from Applications or your Windows desktop shortcut.';notice.classList.toggle('desktop-browser-notice',!nativeRun);}
 if(!nativeRun){const demo=d.createElement('div');demo.className='desktop-not-installed';demo.setAttribute('role','status');demo.innerHTML=svg('shield')+' <span>This is a browser preview. For the installed app, open <strong>SLABSNGRABSACO Jig Studio</strong> from your Applications folder or desktop shortcut—not <code>index.html</code>.</span>';notice?.after(demo);}
 // Profile Studio uses true workspace screens, rather than a long webpage with every section at once.
 const studio=$('jigPage');if(!studio)return;
 const group=(stage,title,description)=>{
  const shell=d.createElement('section');shell.className='native-studio-stage';shell.id='studioStage-'+stage;shell.dataset.stage=stage;
  const head=d.createElement('header');head.className='native-stage-header';
  const copy=d.createElement('div');copy.innerHTML='<span class="native-stage-kicker">PROFILE STUDIO / '+(stage==='import'?'01':stage==='settings'?'02':'03')+'</span><h2>'+title+'</h2><p>'+description+'</p>';
  head.append(copy);shell.append(head);return shell;
 };
 const steps=[
  {id:'import',label:'Import',title:'Bring in your profiles',desc:'Select an existing website customer or load Shikari, Valor, CSV, or JSON files from your computer.'},
  {id:'settings',label:'Jig settings',title:'Choose your profile variations',desc:'Adjust names, address formatting, and combinations. Your imported profiles remain intact until export.'},
  {id:'review',label:'Review & export',title:'Review and save your profiles',desc:'Check the changes, assign locally entered test-card references if needed, and export the chosen file format.'}
 ];
 const nav=d.createElement('nav');nav.className='native-stage-nav';nav.setAttribute('aria-label','Profile Studio steps');nav.setAttribute('role','tablist');
 const pages={};
 for(let i=0;i<steps.length;i++){
  const s=steps[i];pages[s.id]=group(s.id,s.title,s.desc);
  const button=d.createElement('button');button.type='button';button.className='native-step';button.id='stepButton-'+s.id;button.dataset.stage=s.id;
  button.setAttribute('role','tab');button.setAttribute('aria-controls','studioStage-'+s.id);button.setAttribute('aria-selected',String(i===0));
  button.innerHTML='<span class="native-step-number">'+(i+1)+'</span><span class="native-step-label">'+s.label+'</span>';
  button.addEventListener('click',()=>activateStage(s.id));nav.append(button);
 }
 const originalHero=studio.querySelector(':scope > .eyebrow');studio.insertBefore(nav,originalHero);
 for(const page of Object.values(pages))studio.append(page);
 const transfer=(id,stage)=>{const el=$(id);if(el)pages[stage].append(el);};
 transfer('studioWebsiteImport','import');
 for(const sel of ['.uploadShell','.remoteBox','#fileBar','.stats']){const item=studio.querySelector(':scope > '+sel);if(item)pages.import.append(item);}
 transfer('rowPicker','settings');
 const workspace=studio.querySelector(':scope > .workspace');
 if(workspace){
  const left=workspace.querySelector('.leftpane'),right=workspace.querySelector('.rightpane');
  if(left)pages.settings.append(left);if(right)pages.review.append(right);workspace.remove();
 }
 // No programmatic export or customer save happens when changing between screens.
 const addFooter=(page,kind,buttonLabel,next)=>{
  const row=d.createElement('div');row.className='native-step-footer';
  const note=d.createElement('small');note.textContent=kind;
  const button=d.createElement('button');button.type='button';button.className='btn primary native-next';button.innerHTML=buttonLabel+' '+svg('arrow');
  button.addEventListener('click',()=>activateStage(next));row.append(note,button);page.append(row);
 };
 addFooter(pages.import,'Nothing is changed until you review and export.','Continue to jig settings','settings');
 addFooter(pages.settings,'Tip: each checked category shows an example before applying.','Review profiles','review');
 const reviewFooter=d.createElement('div');reviewFooter.className='native-step-footer';
 reviewFooter.innerHTML='<small>Exports stay on this device. Your website account records are not changed by local export.</small>';
 const backButton=d.createElement('button');backButton.type='button';backButton.className='btn secondary';backButton.textContent='← Back to jig settings';backButton.addEventListener('click',()=>activateStage('settings'));
 reviewFooter.append(backButton);pages.review.append(reviewFooter);
 // Activate stage without resetting input values, selected files, or live data.
 let currentStage='import';
 function activateStage(id){
  if(!pages[id])return;
  currentStage=id;
  for(const [key,element] of Object.entries(pages)){
   const active=key===id;element.hidden=!active;
   const btn=$('stepButton-'+key);if(btn){btn.setAttribute('aria-selected',String(active));btn.tabIndex=active?0:-1;}
  }
  const pane=d.querySelector('.desktop-content');if(pane)pane.scrollTo({top:0,behavior:'instant'});
 }
 nav.addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  const ids=steps.map(s=>s.id);const index=ids.indexOf(currentStage);
  const next=e.key==='Home'?0:e.key==='End'?ids.length-1:e.key==='ArrowRight'?Math.min(ids.length-1,index+1):Math.max(0,index-1);
  activateStage(ids[next]);$('stepButton-'+ids[next])?.focus();e.preventDefault();
 });
 activateStage('import');
 d.addEventListener('jigstudio:profiles-imported',()=>activateStage('settings'));
 d.addEventListener('jigstudio:open-import',()=>activateStage('import'));
 // Existing website import includes a successful data-load handler. Offer a single click to go to setup.
 const importStatus=$('studioImportStatus');
 if(importStatus){const indicator=d.createElement('button');indicator.type='button';indicator.id='studioGoJigSettings';indicator.className='btn secondary native-continue';indicator.textContent='Open jig settings →';indicator.addEventListener('click',()=>activateStage('settings'));importStatus.after(indicator);}
 // Keyboard navigation in an installed desktop window; ignore editable focus.
 d.addEventListener('keydown',event=>{
  if(!(event.metaKey||event.ctrlKey)||event.altKey||event.shiftKey||!/^[123]$/.test(event.key))return;
  const target=event.target;if(target?.closest?.('input,textarea,select,[contenteditable="true"]'))return;
  const main=['site','jig','email'][Number(event.key)-1];d.querySelector('.appTabs .tabButton[data-tab="'+main+'"]')?.click();event.preventDefault();
 });
 document.addEventListener('jigstudio:navigate-stage',event=>{
  const stage=event.detail?.stage;if(['import','settings','review'].includes(stage)){
   document.querySelector('.tabButton[data-tab="jig"]')?.click();activateStage(stage);
  }
 });
})();
