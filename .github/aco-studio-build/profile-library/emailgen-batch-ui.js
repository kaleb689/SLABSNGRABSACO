
 // Batch manager runs inside the owner-only encrypted Email Gen closure.
 // It never creates Cloudflare rules, changes customers, or moves an alias
 // without a reviewed, explicit retailer-pool confirmation.
 const emailBatchState={key:'',selected:new Set(),page:0,query:'',filter:'all',pending:null};
 const EMAIL_BATCH_PAGE_SIZE=80;
 const batchElement=id=>$e(id);
 const batchVerified=row=>row?.status==='live'&&Boolean(row.forwardingTestedAt)&&row.forwardingTestTarget===row.target;
 function batchCreationMs(row){
  const stamp=row?.batchCreatedAt||row?.createdAt||row?.created_at||row?.created||row?.createdOn||row?.timestamp;
  if(stamp===null||stamp===undefined||stamp==='')return 0;
  if(typeof stamp==='number')return stamp>0&&stamp<1e12?stamp*1000:stamp;
  const n=Date.parse(String(stamp));
  return Number.isFinite(n)&&n>0?n:0;
 }
 function batchLocalDate(ms){
  if(!Number.isFinite(ms)||ms<=0)return 'undated';
  const d=new Date(ms);
  return String(d.getFullYear())+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
 }
 function emailBatchGroups(){
  const entries=records.map((row,index)=>({row,index,time:batchCreationMs(row)})).filter(e=>e.row?.randomGenerated===true&&typeof e.row.alias==='string');
  const legacy=entries.filter(e=>!e.row.batchId).sort((a,b)=>a.time-b.time||a.index-b.index);
  const legacyKeys=new Map();
  let sequence=0,previousTime=0,previousDay='',previousKey='';
  for(const e of legacy){
   const day=batchLocalDate(e.time);
   if(day==='undated'){legacyKeys.set(e.index,'legacy:undated');continue;}
   // Old versions did not save a batch ID. Adjacent creations within two
   // minutes are grouped conservatively; original records are never edited.
   if(day!==previousDay||!previousTime||e.time-previousTime>120000){
    sequence++;previousKey='legacy:'+day+':'+sequence;
   }
   legacyKeys.set(e.index,previousKey);
   previousTime=e.time;previousDay=day;
  }
  const grouped=new Map();
  for(const e of entries){
   const key=e.row.batchId?'batch:'+e.row.batchId:legacyKeys.get(e.index);
   if(!key)continue;
   let group=grouped.get(key);
   if(!group){
    group={key,rows:[],time:e.time||0,day:batchLocalDate(e.time),name:'',number:0};
    grouped.set(key,group);
   }
   group.rows.push(e.row);
   if(e.time&&(group.time===0||e.time<group.time)){group.time=e.time;group.day=batchLocalDate(e.time);}
  }
  const groups=[...grouped.values()].sort((a,b)=>a.time-b.time||a.key.localeCompare(b.key));
  const ordinals=new Map();
  for(const g of groups){
   const number=(ordinals.get(g.day)||0)+1;
   ordinals.set(g.day,number);g.number=number;
   const label=g.day==='undated'?'Undated':g.day.slice(5).replace(/^0/,'').replace('-0','-');
   g.name=label+' Batch '+number+' ('+g.rows.length+')';
  }
  return groups.reverse();
 }
 function emailBatchCurrentGroup(){return emailBatchGroups().find(g=>g.key===emailBatchState.key)||null;}
 function emailBatchSelectedRows(group){
  if(!group)return [];
  const allowed=emailBatchState.selected;
  return group.rows.filter(r=>allowed.has(String(r.alias).toLowerCase()));
 }
 function emailBatchResetPreview(){
  emailBatchState.pending=null;
  const panel=batchElement('emailBatchPoolConfirmArea');
  if(panel)panel.hidden=true;
 }
 function emailBatchStatus(message){const status=batchElement('emailBatchActionStatus');if(status)status.textContent=message;}
 function emailBatchFormattedEmail(row){
  return String(row.alias||'').toLowerCase();
 }
 function refreshEmailBatchUI(){
  const count=batchElement('emailBankTotalCount'),picker=batchElement('emailBatchSelect');
  if(!count||!picker)return;
  const rows=unlocked?records:[];
  const groups=unlocked?emailBatchGroups():[];
  const live=rows.filter(r=>r.status==='live').length,verified=rows.filter(batchVerified).length;
  count.textContent=String(rows.length);
  batchElement('emailBankLiveCount').textContent=String(live);
  batchElement('emailBankVerifiedCount').textContent=String(verified);
  batchElement('emailBankPendingCount').textContent=String(rows.length-verified);
  if(!unlocked){emailBatchState.selected.clear();emailBatchState.key='';emailBatchResetPreview();}
  const validKeys=new Set(groups.map(g=>g.key));
  if(!validKeys.has(emailBatchState.key)){
   emailBatchState.key=groups[0]?.key||'';
   emailBatchState.selected.clear();emailBatchState.page=0;emailBatchResetPreview();
  }
  const signature=groups.map(g=>g.key+':'+g.rows.length).join('|');
  if(picker.dataset.signature!==signature){
   picker.replaceChildren();
   for(const g of groups){
    const option=document.createElement('option');option.value=g.key;option.textContent=g.name;picker.appendChild(option);
   }
   if(!groups.length){
    const option=document.createElement('option');option.value='';option.textContent=unlocked?'No generated batches':'Unlock Email Bank';picker.appendChild(option);
   }
   picker.dataset.signature=signature;
  }
  picker.value=emailBatchState.key;
  const group=groups.find(g=>g.key===emailBatchState.key);
  const meta=batchElement('emailBatchMeta'),list=batchElement('emailBatchRows');
  list.replaceChildren();
  if(!group){
   meta.textContent=unlocked?'No generated emails yet. Manual aliases remain in the table below.':'Unlock your encrypted Email Bank to view batches.';
   batchElement('emailBatchPage').textContent='0 of 0';
   batchElement('emailBatchSelectedCount').textContent='0 selected.';
   for(const id of ['emailBatchSelectVerified','emailBatchSelectAll','emailBatchExport','emailBatchPoolReview','emailBatchPrev','emailBatchNext']){
    batchElement(id).disabled=true;
   }
   return;
  }
  const verifiedInBatch=group.rows.filter(batchVerified).length;
  const assigned=group.rows.filter(r=>Boolean(r.poolTarget)).length;
  const imported=group.rows.filter(r=>Boolean(r.poolImportedAt)).length;
  meta.textContent=group.name+' • '+verifiedInBatch+' tested working • '+(group.rows.length-verifiedInBatch)+' not verified • '+assigned+' assigned • '+imported+' imported to profiles.';
  const query=emailBatchState.query.trim().toLowerCase();
  const filtered=group.rows.filter(r=>
   (!query||emailBatchFormattedEmail(r).includes(query))&&
   (emailBatchState.filter==='all'||
    (emailBatchState.filter==='verified'&&batchVerified(r))||
    (emailBatchState.filter==='unverified'&&!batchVerified(r))||
    (emailBatchState.filter==='unassigned'&&!r.poolTarget)));
  const maxPage=Math.max(0,Math.ceil(filtered.length/EMAIL_BATCH_PAGE_SIZE)-1);
  emailBatchState.page=Math.min(emailBatchState.page,maxPage);
  const start=emailBatchState.page*EMAIL_BATCH_PAGE_SIZE;
  for(const row of filtered.slice(start,start+EMAIL_BATCH_PAGE_SIZE)){
   const alias=emailBatchFormattedEmail(row);
   const wrap=document.createElement('label');
   wrap.style.cssText='display:flex;align-items:center;gap:7px;padding:5px 3px;border-bottom:1px solid #24384b;cursor:pointer;min-width:0';
   const checkbox=document.createElement('input');
   checkbox.type='checkbox';checkbox.value=alias;checkbox.checked=emailBatchState.selected.has(alias);checkbox.setAttribute('data-batch-alias',alias);
   checkbox.style.flex='0 0 auto';
   const detail=document.createElement('span');detail.style.cssText='min-width:0;overflow-wrap:anywhere;font-size:11px;flex:1';
   const name=document.createElement('strong');name.textContent=alias;name.style.display='block';
   const status=document.createElement('span');status.className='tiny';
   status.textContent=batchVerified(row)?'Delivery verified':row.status==='live'?'Routing live — not tested':'Not verified';
   if(row.poolTarget)status.textContent+=' · '+(RANDOM_RETAILERS[row.poolTarget]||row.poolTarget)+(row.poolImportedAt?' pool imported':' assigned');
   detail.append(name,status);wrap.append(checkbox,detail);list.appendChild(wrap);
  }
  if(!filtered.length){const note=document.createElement('p');note.className='tiny';note.textContent='No emails match this batch search/filter.';list.appendChild(note);}
  batchElement('emailBatchPage').textContent=(filtered.length?start+1:0)+'–'+Math.min(filtered.length,start+EMAIL_BATCH_PAGE_SIZE)+' of '+filtered.length;
  batchElement('emailBatchPrev').disabled=emailBatchState.page===0;
  batchElement('emailBatchNext').disabled=emailBatchState.page>=maxPage;
  const countSelected=emailBatchSelectedRows(group).length,selectedVerified=emailBatchSelectedRows(group).filter(batchVerified).length;
  batchElement('emailBatchSelectedCount').textContent=countSelected+' selected in this batch ('+selectedVerified+' delivery verified). Export can include drafts; retailer import requires every selected email to be verified and unassigned.';
  batchElement('emailBatchSelectVerified').disabled=!verifiedInBatch;
  batchElement('emailBatchSelectAll').disabled=group.rows.length===0;
  batchElement('emailBatchExport').disabled=countSelected===0;
  batchElement('emailBatchPoolReview').disabled=countSelected===0;
 }
 function emailBatchExportSelected(){
  requireOwner();if(!unlocked)throw Error('Unlock your Email Bank first.');
  const group=emailBatchCurrentGroup(),chosen=emailBatchSelectedRows(group);
  if(!group||!chosen.length)throw Error('Select emails from a created batch first.');
  const format=batchElement('emailBatchExportFormat').value;
  let filename,bytes,contentType='text/plain;charset=utf-8';
  if(format==='emails'){
   bytes=chosen.map(r=>emailBatchFormattedEmail(r)).join('\r\n')+'\r\n';
   filename='email-addresses.txt';
  }else if(['basic','shikari','shikari-txt'].includes(format)){
   const mode=format==='basic'?'basic':'shikari';
   bytes=buildEmailGenExportCsv(chosen,mode).csv;
   filename=format==='basic'?'email-gen.csv':format==='shikari'?'shikari.csv':'shikari.txt';
   if(format!=='shikari-txt')contentType='text/csv;charset=utf-8';
  }else throw Error('Choose a supported batch export format.');
  const safeLabel=(group.day==='undated'?'undated':group.day)+'-batch-'+group.number+'-'+chosen.length+'-';
  const blob=new Blob([bytes],{type:contentType});
  const url=URL.createObjectURL(blob);
  try{
   const link=document.createElement('a');
   link.href=url;link.download=safeLabel+filename;link.hidden=true;document.body.appendChild(link);
   try{link.click();}finally{link.remove();}
  }finally{setTimeout(()=>URL.revokeObjectURL(url),15000);}
  const notVerified=chosen.filter(r=>!batchVerified(r)).length;
  emailBatchStatus('Exported '+chosen.length+' email(s) from '+group.name+'. '+(notVerified?notVerified+' are not delivery verified and must not be treated as working.':'All selected emails have successful delivery tests.')+' Nothing was assigned or published.');
 }
 function emailBatchReviewPool(){
  requireOwner();if(!unlocked)throw Error('Unlock your Email Bank first.');
  const group=emailBatchCurrentGroup(),chosen=emailBatchSelectedRows(group);
  const retailer=batchElement('emailBatchRetailer').value;
  emailBatchResetPreview();
  if(!group||!chosen.length)throw Error('Select emails from a batch first.');
  if(!RANDOM_RETAILERS[retailer])throw Error('Choose the retailer Profiles unused pool.');
  if(chosen.some(r=>!batchVerified(r)))throw Error('This selection contains unverified emails. Click Select all verified, or deselect unverified rows. No pool was changed.');
  if(chosen.some(r=>Boolean(r.poolTarget)||Boolean(r.poolImportedAt)))throw Error('Some selected emails are already assigned or imported. Select only unassigned verified emails. No pool was changed.');
  emailBatchState.pending={batchKey:group.key,retailer,aliases:chosen.map(r=>emailBatchFormattedEmail(r)).sort()};
  const sample=chosen.slice(0,3).map(emailBatchFormattedEmail).join(', ');
  batchElement('emailBatchPoolSummary').textContent='Review: add exactly '+chosen.length+' delivery-verified email(s) from '+group.name+' to your Personal '+RANDOM_RETAILERS[retailer]+' Unused pool. '+sample+(chosen.length>3?', ...':'')+'. Nothing has been moved yet. Confirm to import these exact addresses.';
  batchElement('emailBatchPoolConfirmArea').hidden=false;
  emailBatchStatus('Preview ready. Check retailer and count, then explicitly confirm. No pool has been modified.');
 }
 async function emailBatchConfirmPool(){
  if(randomGenBusy)throw Error('Another Email Gen operation is already running.');
  requireOwner();if(!unlocked)throw Error('Unlock your Email Bank first.');
  const plan=emailBatchState.pending,group=emailBatchCurrentGroup();
  if(!plan||!group||plan.batchKey!==group.key)throw Error('Batch changed. Review the import again.');
  const current=emailBatchSelectedRows(group),aliases=current.map(r=>emailBatchFormattedEmail(r)).sort();
  if(plan.retailer!==batchElement('emailBatchRetailer').value||JSON.stringify(aliases)!==JSON.stringify(plan.aliases))
   throw Error('Selection or retailer changed. Review the import again.');
  if(!current.length||current.some(r=>!batchVerified(r)||r.poolTarget||r.poolImportedAt))
   throw Error('Some email statuses changed. Review the verified selection again.');
  if(!window.JigPersonalGuard?.ensureUnlocked||!await window.JigPersonalGuard.ensureUnlocked())
   throw Error('Unlock your Personal profile vault before importing verified emails.');
  const importer=window.desktopAPI?.profileWorkshop?.importEmails;
  if(typeof importer!=='function')throw Error('Personal profile email pool importer is unavailable.');
  randomGenBusy=true;
  const button=batchElement('emailBatchPoolConfirm');button.disabled=true;
  try{
   emailBatchStatus('Importing '+aliases.length+' verified email(s) into Personal '+RANDOM_RETAILERS[plan.retailer]+' Unused...');
   const result=await importer({scope:'personal',customerId:null,retailer:plan.retailer,emails:aliases});
   const added=Number(result?.added||0),skipped=Number(result?.skipped||0),invalid=Number(result?.invalid||0);
   if(invalid||added+skipped!==aliases.length)throw Error('The Personal profile pool did not confirm the full selection. Check the pool before retrying.');
   const time=new Date().toISOString(),old=current.map(row=>({row,poolTarget:row.poolTarget||null,poolImportedAt:row.poolImportedAt||null}));
   for(const row of current){row.poolTarget=plan.retailer;row.poolImportedAt=time;}
   if(!await store()){
    for(const previous of old){previous.row.poolTarget=previous.poolTarget;previous.row.poolImportedAt=previous.poolImportedAt;}
    throw Error('The retailer import was accepted, but the encrypted Email Bank did not confirm its save. Check the retailer pool before retrying; existing items will be skipped.');
   }
   emailBatchResetPreview();emailBatchState.selected.clear();
   emailBatchStatus('Added '+added+' verified email(s) to Personal '+RANDOM_RETAILERS[plan.retailer]+' Unused; '+skipped+' already present. No unverified emails or other batches were added.');
   document.dispatchEvent(new CustomEvent('jigstudio:bank-context-updated'));
   refreshEmailBatchUI();
  }finally{randomGenBusy=false;button.disabled=false;}
 }
 function setupEmailBatchUI(){
  const picker=batchElement('emailBatchSelect');
  if(!picker)throw Error('Email Bank batch manager is missing from the right panel.');
  if(picker.dataset.bound==='1')return;
  picker.dataset.bound='1';
  picker.addEventListener('change',value=>{
   emailBatchState.key=picker.value;emailBatchState.selected.clear();emailBatchState.page=0;emailBatchResetPreview();refreshEmailBatchUI();
  });
  batchElement('emailBatchSearch').addEventListener('input',()=>{
   emailBatchState.query=batchElement('emailBatchSearch').value;emailBatchState.page=0;refreshEmailBatchUI();
  });
  batchElement('emailBatchFilter').addEventListener('change',()=>{
   emailBatchState.filter=batchElement('emailBatchFilter').value;emailBatchState.page=0;refreshEmailBatchUI();
  });
  batchElement('emailBatchRows').addEventListener('change',event=>{
   const box=event.target;
   if(!box?.matches?.('input[data-batch-alias]'))return;
   emailBatchResetPreview();
   if(box.checked)emailBatchState.selected.add(box.value);else emailBatchState.selected.delete(box.value);
   refreshEmailBatchUI();
  });
  const selectButton=(id,getRows)=>batchElement(id).addEventListener('click',()=>{
   const group=emailBatchCurrentGroup();if(!group)return;
   emailBatchState.selected=new Set(getRows(group).map(emailBatchFormattedEmail));
   emailBatchResetPreview();refreshEmailBatchUI();
  });
  selectButton('emailBatchSelectVerified',g=>g.rows.filter(batchVerified));
  selectButton('emailBatchSelectAll',g=>g.rows);
  batchElement('emailBatchClear').addEventListener('click',()=>{
   emailBatchState.selected.clear();emailBatchResetPreview();refreshEmailBatchUI();
  });
  for(const [id,delta] of [['emailBatchPrev',-1],['emailBatchNext',1]]){
   batchElement(id).addEventListener('click',()=>{emailBatchState.page=Math.max(0,emailBatchState.page+delta);refreshEmailBatchUI();});
  }
  batchElement('emailBatchExport').addEventListener('click',()=>{
   try{emailBatchExportSelected();}catch(error){emailBatchStatus(String(error?.message||error));}
  });
  batchElement('emailBatchRetailer').addEventListener('change',()=>{emailBatchResetPreview();refreshEmailBatchUI();});
  batchElement('emailBatchPoolReview').addEventListener('click',()=>{
   try{emailBatchReviewPool();}catch(error){emailBatchStatus(String(error?.message||error));}
  });
  batchElement('emailBatchPoolConfirm').addEventListener('click',async()=>{
   try{await emailBatchConfirmPool();}catch(error){emailBatchResetPreview();emailBatchStatus(String(error?.message||error));}
  });
  batchElement('emailBatchPoolCancel').addEventListener('click',()=>{
   emailBatchResetPreview();emailBatchStatus('Cancelled. No email pool was changed.');
  });
  refreshEmailBatchUI();
 }
