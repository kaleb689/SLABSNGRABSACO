(()=>{'use strict';const d=document,$=id=>d.getElementById(id),api=window.desktopAPI?.profileLibrary;if(!api)return;
 const nav=d.querySelector('.appTabs');if(!nav)return;
 const personal=$('personalJigsTab'),customer=nav.querySelector('[data-tab="jig"]'),settings=nav.querySelector('[data-quick="settings"]'),notifications=nav.querySelector('[data-quick="notifications"]'),email=nav.querySelector('[data-tab="email"]'),admin=nav.querySelector('[data-tab="admin"]');
 function separator(label){const line=d.createElement('hr'),title=d.createElement('div');line.className='profileNavLine';title.className='profileNavLabel';title.textContent=label;nav.append(line,title);}
 // Preserve existing controls and handlers while grouping the sidebar explicitly.
 for(const node of [admin])if(node)nav.append(node);
 const customerProfiles=d.createElement('button');customerProfiles.type='button';customerProfiles.className='tabButton profileNavChild';customerProfiles.innerHTML='<span class="navIcon">▤</span><span>Profiles</span>';customer?.after(customerProfiles);
 separator('PERSONAL');if(personal)nav.append(personal);const personalProfiles=customerProfiles.cloneNode(true);nav.append(personalProfiles);if(email)nav.append(email);
 separator('SETTINGS');if(settings)nav.append(settings);if(notifications)nav.append(notifications);
 const main=d.createElement('main');main.id='profileLibraryPage';main.className='shell main profileLibrary';main.hidden=true;
 main.innerHTML='<header><div><div class="eyebrow" data-owner-title></div><h1>Profiles</h1><p>Completed profiles ready to export, grouped by owner and retailer.</p></div><div class="buttons"><button type="button" class="btn secondary" data-import>Import</button><button type="button" class="btn primary" data-export>Export selected</button></div></header><div class="profileLibraryControls"><label data-customer-label>Customer<select data-customer></select></label><label>Retailer<select data-retailer><option value="target">Target · Shikari CSV</option><option value="walmart">Walmart · Valor JSON</option><option value="pokemoncenter">Pokémon Center · Valor JSON</option><option value="costco">Costco · Valor JSON</option><option value="sams">Sam’s · Valor JSON</option></select></label><label>Search<input type="search" data-search placeholder="Name, email or card"></label><button type="button" class="btn secondary" data-rules>Retailer jig rules</button><button type="button" class="btn secondary" data-sync>Sync linked profiles</button></div><div class="profileLibraryTabs"><button type="button" class="btn secondary" data-stage="completed" aria-pressed="true">Completed Profiles</button><button type="button" class="btn secondary" data-stage="in-progress">In Progress</button><button type="button" class="btn plain" data-all>Select all visible</button><button type="button" class="btn plain" data-clear>Clear selection</button></div><p class="profileLibrarySummary" data-status role="status"></p><div class="profileLibraryLayout"><aside class="profileLibraryGroups" data-groups></aside><section class="profileLibraryCards" data-cards></section></div><input type="file" data-file hidden accept=".csv,.json,.txt,.tsv">';
 $('sitePage').before(main);const q=s=>main.querySelector('[data-'+s+']');let scope='personal',customerId=null,rows=[],stage='completed',group='all',epoch=0,busy=false,selected=new Set(),syncing=false,syncQueued=false;
 const retailName={target:'Target',walmart:'Walmart',pokemoncenter:'Pokémon Center',costco:'Costco',sams:'Sam’s'};
 const request=()=>({scope,customerId:scope==='aco'?customerId:null});
 const note=s=>q('status').textContent=s;
 // Customer website/app information is displayed from the authoritative live
 // vault, not copied to Personal or silently treated as local-only profile data.
 const websiteVault=d.createElement('details');websiteVault.className='profileLibraryWebVault';
 websiteVault.hidden=true;websiteVault.style.cssText='margin:18px 0;border:1px solid #456779;border-radius:14px;padding:15px';
 websiteVault.innerHTML='<summary style="cursor:pointer;font-weight:700">Live Website & App · Saved customer data</summary><p data-web-status role="status">Open to load this customer’s current saved addresses and payment methods.</p><div data-web-records></div>';
 main.append(websiteVault);
 let websiteLoad=0;
 const webStatus=s=>websiteVault.querySelector('[data-web-status]').textContent=s;
 function webField(form,name,label,value,inputType='text'){
  const el=d.createElement('label');el.textContent=label;const input=d.createElement('input');input.name=name;input.type=inputType;input.value=value??'';el.append(input);form.append(el);return input;
 }
 async function editWebsiteAddress(address){
  const win=dialog('Edit live customer shipping address'),form=d.createElement('form');
  const keys=[['label','Address label'],['firstName','First name'],['lastName','Last name'],['address','Street address'],['address2','Apt / unit'],['city','City'],['state','State'],['zip','Postal code'],['country','Country']];
  win.body.append(form);
  for(const [key,label]of keys)webField(form,key,label,address[key]);
  const submit=d.createElement('button');submit.type='submit';submit.className='btn primary';submit.textContent='Save to website & app';form.append(submit);
  const id=customerId,revision=address.revision;
  form.onsubmit=async event=>{
   event.preventDefault();submit.disabled=true;
   try{
    const values=Object.fromEntries(new FormData(form));
    const saved=await api.saveWebsiteAddress({scope:'aco',customerId:id,addressId:address.id,expectedRevision:revision,address:values,confirmed:true});
    if(!win.valid())return;
    if(!saved.saved)throw Error('The live website did not confirm this save.');
    win.wrap.remove();webStatus('Shipping address saved on the website and app.');await loadWebsiteVault();
    // The linked customer profile snapshot can use this saved address.
    void syncCustomer(id);
   }catch(error){win.status().textContent=String(error.message||error);submit.disabled=false;}
  };
 }
 async function editWebsiteCard(card){
  const win=dialog('Edit live customer payment method'),form=d.createElement('form');
  win.body.append(form);
  webField(form,'cardLabel','Card label',card.cardLabel);
  webField(form,'cardholder','Cardholder',card.cardholder);
  webField(form,'acoCardNumber','Replace card number (optional; existing number stays saved)','');
  webField(form,'expMonth','Expiration month',card.expMonth);
  webField(form,'expYear','Expiration year',card.expYear);
  const info=d.createElement('p');info.textContent='Existing '+card.maskedNumber+' remains stored securely unless a new number is entered. Security codes are never displayed or updated here.';form.append(info);
  const submit=d.createElement('button');submit.type='submit';submit.className='btn primary';submit.textContent='Save to website & app';form.append(submit);
  const id=customerId,revision=card.revision;
  form.onsubmit=async event=>{
   event.preventDefault();submit.disabled=true;
   try{
    const values=Object.fromEntries(new FormData(form));
    const saved=await api.saveWebsitePayment({scope:'aco',customerId:id,paymentId:card.id,expectedRevision:revision,payment:values,confirmed:true});
    values.acoCardNumber='';
    if(!win.valid())return;
    if(!saved.saved)throw Error('The website did not confirm this payment edit.');
    win.wrap.remove();webStatus('Payment method saved on the website and app.');await loadWebsiteVault();void syncCustomer(id);
   }catch(error){win.status().textContent=String(error.message||error);submit.disabled=false;}
  };
 }
 async function loadWebsiteVault(){
  if(!websiteVault.open||scope!=='aco'||!customerId)return;
  const id=customerId,stamp=++websiteLoad,container=websiteVault.querySelector('[data-web-records]');
  webStatus('Loading the live customer information from the website…');
  try{
   const snapshot=await api.websiteSnapshot({scope:'aco',customerId:id});
   if(stamp!==websiteLoad||id!==customerId||scope!=='aco'||!websiteVault.open)return;
   container.replaceChildren();
   const heading=d.createElement('p');heading.textContent=(snapshot.customer?.firstName||'')+' '+(snapshot.customer?.lastName||'')+' · '+(snapshot.customer?.email||'');container.append(heading);
   for(const [title,list,kind] of [['Saved shipping addresses',snapshot.addresses||[],'address'],['Saved payment methods',snapshot.paymentMethods||[],'payment']]){
    const section=d.createElement('section');section.style.cssText='margin:12px 0';
    const h=d.createElement('h3');h.textContent=title+' ('+list.length+')';section.append(h);
    if(!list.length){const empty=d.createElement('p');empty.textContent='Nothing saved yet.';section.append(empty);}
    for(const item of list){
     const row=d.createElement('div');row.style.cssText='display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;border-top:1px solid #456779;padding:12px 0';
     const label=d.createElement('span');label.textContent=kind==='address'?[item.label,item.firstName+' '+item.lastName,item.address,item.address2,item.city,item.state,item.zip].filter(Boolean).join(' · '):[item.cardLabel,item.cardholder,item.maskedNumber,item.expMonth+'/'+item.expYear].filter(Boolean).join(' · ');
     const edit=d.createElement('button');edit.type='button';edit.className='btn secondary slim';edit.textContent='Edit live '+(kind==='address'?'address':'card');
     edit.onclick=()=>void (kind==='address'?editWebsiteAddress(item):editWebsiteCard(item));
     row.append(label,edit);section.append(row);
    }
    container.append(section);
   }
   webStatus('Live website/app data loaded. Editing a record writes to its original customer account, not a duplicate local bank.');
  }catch(error){if(stamp===websiteLoad)webStatus('Website data unavailable: '+String(error.message||error));}
 }
 websiteVault.addEventListener('toggle',()=>{if(websiteVault.open)void loadWebsiteVault();});

 function hiddenPage(){return main.hidden;}
 function customerList(){const list=window.JigWebsiteCustomers?.list?.()||[],old=customerId;q('customer').replaceChildren(new Option('Select customer',''));for(const c of list)q('customer').append(new Option(c.name||c.email,c.id));if(list.some(c=>c.id===old))q('customer').value=old;}
 const customerName=()=>scope==='personal'?'Personal':(window.JigWebsiteCustomers?.list?.().find(x=>x.id===customerId)?.name||customerId||'Customer');
 function visible(){const term=q('search').value.trim().toLowerCase();return rows.filter(x=>x.retailer===q('retailer').value&&x.stage===stage&&(group==='all'||(x.group||x.retailer)===group)&&[x.email,x.label,...Object.values(x.data||{}).filter(x=>typeof x==='string')].join(' ').toLowerCase().includes(term));}
 function text(tag,value){const el=d.createElement(tag);el.textContent=value;return el;}
 function cardFields(data){if(Object.hasOwn(data,'cc_number'))return {number:data.cc_number,holder:data.cc_name||[data.first_name,data.last_name].filter(Boolean).join(' '),expiration:data.cc_exp_month+'/'+data.cc_exp_year,code:data.custom_security_code||'',shipping:[data.shipping_street,data.shipping_street_2,data.shipping_city,data.shipping_zip_code].filter(Boolean).join(', ')};const c=data.card||{},s=data.shipping||{};return {number:c.number,holder:c.holder,expiration:c.expiration,code:c.custom_security_code||'',shipping:[s.addressLine1,s.addressLine2,s.city,s.zipCode].filter(Boolean).join(', ')};}
 function draw(){const matching=visible();q('cards').replaceChildren();q('groups').replaceChildren();const eligible=rows.filter(x=>x.retailer===q('retailer').value&&x.stage===stage),groups=['all',...new Set(eligible.map(x=>x.group||x.retailer))];for(const value of groups){const b=d.createElement('button');b.type='button';b.textContent=(value==='all'?'All profiles':value)+' ('+(value==='all'?eligible.length:eligible.filter(x=>(x.group||x.retailer)===value).length)+')';b.setAttribute('aria-pressed',String(group===value));b.onclick=()=>{group=value;draw();};q('groups').append(b);}for(const b of main.querySelectorAll('[data-stage]'))b.setAttribute('aria-pressed',String(b.dataset.stage===stage));
 for(const row of matching.slice(0,200)){const box=d.createElement('article');box.className='profileLibraryCard';const label=d.createElement('label'),check=d.createElement('input');check.type='checkbox';check.checked=selected.has(row.id);check.onchange=()=>check.checked?selected.add(row.id):selected.delete(row.id);label.append(check,text('strong',row.label||row.email));box.append(label);const payment=cardFields(row.data),card=d.createElement('div');card.className='profilePaymentCard';card.append(text('strong',row.email),text('span',payment.holder||'Cardholder missing'),text('span',payment.number||'Card number missing'),text('span',payment.expiration||'Expiration missing'));box.append(card,text('small',payment.shipping||'Address missing'));if(row.missing.length){const s=text('small','Needs: '+row.missing.join(', '));s.className='profileLibraryMissing';box.append(s);}if(row.duplicates.length||row.needsReview){const s=text('small',row.needsReview?'Linked customer information changed — review local edits':'Duplicate '+row.duplicates.join(', '));s.className='profileLibraryConflict';box.append(s);}const actions=d.createElement('div');actions.className='buttons';for(const [title,action]of [['View / Edit','edit'],['Repair duplicates','repair'],['Jig profile','jig']]){const b=d.createElement('button');b.type='button';b.className='btn slim secondary';b.textContent=title;b.onclick=()=>action==='edit'?edit(row):action==='repair'?repair(row):openJig(row);actions.append(b);}box.append(actions);q('cards').append(box);}if(!matching.length)q('cards').append(text('p',scope==='aco'&&!customerId?'Select a customer to open their profiles.':'No '+(stage==='completed'?'completed':'in progress')+' profiles for this group.'));q('export').disabled=busy||stage!=='completed';
 }
 async function refresh(){const ticket=++epoch,owner=request();if(scope==='aco'&&!customerId){rows=[];draw();return;}try{if(scope==='personal'&&!await window.JigPersonalGuard.ensureUnlocked())return;const result=await api.list(owner);if(ticket!==epoch||main.hidden)return;rows=result.profiles;selected=new Set([...selected].filter(id=>rows.some(x=>x.id===id)));draw();note(customerName()+' · '+visible().length+' profiles · '+retailName[q('retailer').value]);}catch(e){if(ticket===epoch){rows=[];draw();note(e.message);}}}
 function close(){epoch++;rows=[];selected.clear();main.hidden=true;d.querySelectorAll('.profileLibraryModal').forEach(x=>x.remove());void api.cancel();}
 async function open(next){if(next==='personal'&&!await window.JigPersonalGuard.ensureUnlocked())return;close();scope=next;customerId=next==='aco'?(window.ACOProfileBank?.context?.().customerId||null):null;customerList();q('customer-label').hidden=scope==='personal';q('owner-title').textContent=scope==='personal'?'PERSONAL VAULT':'CUSTOMER VAULTS';q('sync').hidden=scope==='personal';websiteVault.hidden=scope==='personal';websiteVault.open=false;websiteLoad++;for(const id of ['jigPage','sitePage','adminPage','emailPage'])if($(id))$(id).hidden=true;main.hidden=false;for(const b of nav.querySelectorAll('button'))b.classList.remove('on');(scope==='personal'?personalProfiles:customerProfiles).classList.add('on');d.body.dataset.mode='profiles';d.querySelector('.headerTitle strong').textContent=scope==='personal'?'Personal Profiles':'Customer Profiles';await window.desktopAPI.site?.hide?.();await refresh();}
 customerProfiles.onclick=()=>void open('aco');personalProfiles.onclick=()=>void open('personal');for(const b of nav.querySelectorAll('button'))if(b!==customerProfiles&&b!==personalProfiles)b.addEventListener('click',()=>{if(!main.hidden)close();});
 function dialog(title){const wrap=d.createElement('div');wrap.className='profileLibraryModal';const body=d.createElement('div');body.className='profileLibraryDialog';const head=d.createElement('header'),close=d.createElement('button');close.type='button';close.className='btn plain';close.textContent='X';head.append(text('h2',title),close);body.append(head);wrap.append(body);d.body.append(wrap);const owner=request(),at=epoch;close.onclick=()=>wrap.remove();wrap.addEventListener('keydown',e=>{if(e.key==='Escape')wrap.remove();});return {wrap,body,owner,valid:()=>at===epoch&&!main.hidden&&wrap.isConnected,status:()=>{let el=body.querySelector('[role=status]');if(!el){el=text('p','');el.setAttribute('role','status');body.append(el);}return el;}};}
 function field(form,key,label,value,type='text'){const l=text('label',label),i=d.createElement('input');i.name=key;i.type=type;i.value=value??'';l.append(i);form.append(l);return i;}
 function formValues(data){const shipping=data.shipping||{},billing=data.billing||{},sh=Object.hasOwn(data,'cc_number');const result={label:data.profile_name||data.name||'',email:data.email||'',password:data.password||'',first:data.first_name||data.firstName||shipping.firstName||'',last:data.last_name||data.lastName||shipping.lastName||'',phone:data.phone_num||data.phoneNumber||''};for(const role of ['shipping','billing']){const source=data[role]||{};for(const [a,b]of Object.entries({first:'first_name',last:'last_name',address1:'street',address2:'street_2',city:'city',state:'state',zip:'zip_code',country:'country',phone:'phone'})){const valor={first:'firstName',last:'lastName',address1:'addressLine1',address2:'addressLine2',city:'city',state:'state',zip:'zipCode',country:'countryCode',phone:'phoneNumber'};result[role+'.'+a]=sh?data[role+'_'+b]||result[a]||'':source[valor[a]]||result[a]||'';}}return result;}
 async function edit(row){const win=dialog(customerName()+' · Edit Profile'),form=d.createElement('form'),tabs=d.createElement('div'),profile=d.createElement('section'),payment=d.createElement('section');tabs.className='profileLibraryTabs';payment.hidden=true;for(const [name,part]of [['Profile',profile],['Payment',payment]]){const b=text('button',name);b.type='button';b.className='btn secondary';b.onclick=()=>{profile.hidden=part!==profile;payment.hidden=part!==payment;};tabs.append(b);}win.body.append(tabs,form);profile.className=payment.className='workshopForm';form.append(profile,payment);const v=formValues(row.data);for(const key of ['label','email','first','last','phone',...['shipping','billing'].flatMap(r=>['first','last','phone','address1','address2','city','state','zip','country'].map(k=>r+'.'+k))])field(profile,key,key.replaceAll('.',' '),v[key],key==='email'?'email':'text');field(profile,'group','Profile group',row.group);const pay=cardFields(row.data),ex=pay.expiration.split('/');field(payment,'cardholder','Cardholder',pay.holder);field(payment,'number','Card number',pay.number);field(payment,'month','Expiration month',ex[0]);field(payment,'year','Expiration year',ex[1]?.length===2?'20'+ex[1]:ex[1]);field(payment,'customSecurityCode','Security / reference code',pay.code);const b=text('button','Save profile');b.type='submit';b.className='btn primary';form.append(b);form.onsubmit=async e=>{e.preventDefault();b.disabled=true;try{const values=Object.fromEntries(new FormData(form)),fields={...v};for(const k of Object.keys(v))if(Object.hasOwn(values,k))fields[k]=values[k];const previousCard={number:String(pay.number||'').replace(/\D/g,''),cardholder:String(pay.holder||''),month:String(ex[0]||'').padStart(2,'0'),year:String(ex[1]?.length===2?'20'+ex[1]:ex[1]||''),customSecurityCode:String(pay.code||'')};
 const proposedCard={number:String(values.number||'').replace(/\D/g,''),cardholder:String(values.cardholder||''),month:String(values.month||'').padStart(2,'0'),year:String(values.year||''),customSecurityCode:String(values.customSecurityCode||'')};
 const changedCard=Object.keys(previousCard).some(k=>proposedCard[k]!==previousCard[k]);
 const saveResult=await api.edit({...win.owner,profileId:row.id,revision:row.revision,fields,group:values.group,...(changedCard?{card:proposedCard}:{})});if(!win.valid())return;win.wrap.remove();await refresh();note(saveResult?.remoteSaved?'Saved on the live website and in ACO Studio.':'Saved to this encrypted local vault only (not yet linked to website).');}catch(e){win.status().textContent=e.message;b.disabled=false;}};}
 async function repair(row){const win=dialog('Repair profile · '+row.email),form=d.createElement('form');win.body.append(form);form.innerHTML='<label class="check"><input type="checkbox" name="name"> Generate a new unused random name</label><label class="check"><input type="checkbox" name="email"> Replace email from this retailer’s unused bank</label><label class="check"><input type="checkbox" name="card"> Replace card from this vault’s unused cards</label><div data-card-choices></div><button type="submit" class="btn primary">Save replacements</button>';const assets=await window.desktopAPI.profileWorkshop.assets(win.owner);if(!win.valid())return;for(const card of assets.cards.filter(x=>x.unused)){const label=text('label',card.label+' · ending '+card.last4),c=d.createElement('input');c.type='checkbox';c.value=card.id;c.checked=true;label.prepend(c);form.querySelector('[data-card-choices]').append(label);}form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('[type=submit]');b.disabled=true;try{await api.repair({...win.owner,profileId:row.id,revision:row.revision,repairs:Object.fromEntries(['name','email','card'].map(k=>[k,form.elements[k].checked])),cardIds:[...form.querySelectorAll('[data-card-choices] input:checked')].map(x=>x.value)});if(!win.valid())return;win.wrap.remove();await refresh();}catch(e){win.status().textContent=e.message;b.disabled=false;}};}
 function openJig(row){const owner=request();close();(owner.scope==='personal'?personal:customer)?.click();setTimeout(()=>void window.ACOProfileWorkshop.openSaved({...owner,profileId:row.id}),0);}
 q('customer').onchange=()=>{epoch++;websiteLoad++;websiteVault.open=false;websiteVault.querySelector('[data-web-records]').replaceChildren();customerId=q('customer').value||null;rows=[];selected.clear();group='all';void refresh();};q('retailer').onchange=()=>{selected.clear();group='all';draw();};q('search').oninput=draw;for(const b of main.querySelectorAll('[data-stage]'))b.onclick=()=>{stage=b.dataset.stage;group='all';selected.clear();draw();};q('all').onclick=()=>{for(const r of visible())selected.add(r.id);draw();};q('clear').onclick=()=>{selected.clear();draw();};
 q('export').onclick=async()=>{try{const result=await api.exportFile({...request(),retailer:q('retailer').value,profileIds:visible().filter(x=>selected.has(x.id)).map(x=>x.id),customerName:customerName()});if(result.saved)note('Exported '+result.count+' profiles: '+result.name);}catch(e){note(e.message);}};
 q('import').onclick=()=>{if(scope==='aco'&&!customerId){note('Choose a customer first.');return;}q('file').value='';q('file').click();};
 q('file').onchange=async()=>{const file=q('file').files[0];if(!file)return;const owner=request(),at=epoch,retailer=q('retailer').value;try{if(file.size>26*1024*1024)throw Error('Choose a file smaller than 26 MB.');const preview=await api.importPreview({...owner,retailer,fileName:file.name,text:await file.text()});if(at!==epoch||main.hidden)return;const win=dialog('Review profile import'),form=d.createElement('form');win.body.append(text('p',preview.count+' profiles · '+preview.profiles.filter(x=>x.duplicates.length).length+' rows with duplicate email, name or card.'),form);for(const row of preview.profiles.filter(x=>x.duplicates.length).slice(0,80))form.append(text('p',row.email+' · Duplicate '+row.duplicates.join(', ')));form.insertAdjacentHTML('beforeend','<label class="check"><input name="name" type="checkbox" checked> Generate new names for duplicates</label><label class="check"><input name="email" type="checkbox" checked> Replace duplicate emails from this retailer’s bank</label><label class="check"><input name="card" type="checkbox" checked> Replace duplicate cards from this vault</label><label class="check"><input name="allowShared" type="checkbox"> Keep shared names/cards when their repair option is off</label><label class="check"><input name="alreadyJigged" type="checkbox" checked> Imported profiles have already been jigged / formatted</label>');field(form,'group','Group',retailName[retailer]);const choices=d.createElement('div');form.append(choices);const assets=await window.desktopAPI.profileWorkshop.assets(owner);if(!win.valid())return;for(const card of assets.cards.filter(x=>x.unused)){const label=text('label',card.label+' · ending '+card.last4),c=d.createElement('input');c.type='checkbox';c.checked=true;c.value=card.id;label.prepend(c);choices.append(label);}const b=text('button','Import reviewed profiles');b.type='submit';b.className='btn primary';form.append(b);form.onsubmit=async e=>{e.preventDefault();b.disabled=true;try{const result=await api.importCommit({token:preview.token,confirmed:true,group:form.elements.group.value,alreadyJigged:form.elements.alreadyJigged.checked,repairs:Object.fromEntries(['name','email','card','allowShared'].map(k=>[k,form.elements[k].checked])),cardIds:[...choices.querySelectorAll('input:checked')].map(x=>x.value)});if(!win.valid())return;win.wrap.remove();await refresh();note('Imported '+result.imported+' profiles into '+customerName()+' / '+retailName[retailer]);}catch(e){win.status().textContent=e.message;b.disabled=false;}};}catch(e){note(e.message);}};
 let syncChain=Promise.resolve();function syncCustomer(id,manual=false){const run=async()=>{try{const r=await api.syncCustomer({scope:'aco',customerId:id});if(!main.hidden&&scope==='aco'&&customerId===id){await refresh();if(manual)note('Linked profiles: '+r.created+' created, '+r.updated+' updated, '+r.needsReview+' need review.');}}catch(e){if(manual)note(e.message);}};const task=syncChain.catch(()=>{}).then(run);syncChain=task.catch(()=>{});return task;}
 q('rules').onclick=async()=>{try{const win=dialog(retailName[q('retailer').value]+' jig rules'),r=q('retailer').value,settings=await api.rules({...win.owner,retailer:r});if(!win.valid())return;const choices=d.createElement('div');for(const option of settings.options){const label=text('label',option.label),c=d.createElement('input');label.className='check';c.type='checkbox';c.value=option.id;c.checked=settings.selected.includes(option.id);label.prepend(c);choices.append(label);}const save=text('button','Save rules for this vault and retailer');save.type='button';save.className='btn primary';save.onclick=async()=>{try{await api.saveRules({...win.owner,retailer:r,rules:[...choices.querySelectorAll('input:checked')].map(x=>x.value)});win.wrap.remove();note('Saved retailer jig rules for '+customerName()+'.');}catch(e){win.status().textContent=e.message;}};win.body.append(choices,save);}catch(e){note(e.message);}};
 q('sync').onclick=()=>customerId?void syncCustomer(customerId,true):note('Select a customer first.');
 const queuedCustomers=new Set();let autoRunning=false;async function autoSync(){for(const c of window.JigWebsiteCustomers?.list?.()||[])if(c.id&&c.paid)queuedCustomers.add(c.id);if(autoRunning)return;autoRunning=true;try{while(queuedCustomers.size){const id=queuedCustomers.values().next().value;queuedCustomers.delete(id);await syncCustomer(id);}}finally{autoRunning=false;}}
 d.addEventListener('aco-studio:edit-profile',async event=>{
  const detail=event.detail||{};
  if(!['aco','personal'].includes(detail.scope)||!detail.profileId)return;
  if(detail.scope==='aco'&&!detail.customerId)return;
  try{
   await open(detail.scope);
   if(main.hidden)return;
   if(detail.scope==='aco'){customerId=detail.customerId;q('customer').value=customerId;}
   await refresh();
   const match=rows.find(r=>r.id===detail.profileId);
   if(!match){note('This specific profile is no longer present. Choose a customer and refresh.');return;}
   q('retailer').value=match.retailer;stage=match.stage;group='all';draw();
   await edit(match);
  }catch(error){note('Unable to open this profile: '+String(error?.message||error));}
 });
 d.addEventListener('jigstudio:customers-updated',()=>{if(!main.hidden&&scope==='aco'&&websiteVault.open&&!d.querySelector('.profileLibraryModal'))void loadWebsiteVault();if(window.JigWebsiteCustomers?.connected?.()===false){queuedCustomers.clear();if(scope==='aco')close();return;}if(scope==='aco'&&!main.hidden)customerList();void autoSync();});d.addEventListener('jigstudio:personal-locked',()=>{if(scope==='personal')close();});d.addEventListener('jigstudio:bank-context-updated',()=>{if(!main.hidden)void refresh();});
})();
