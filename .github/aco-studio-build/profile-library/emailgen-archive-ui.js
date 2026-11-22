// Owner-only archive index in the existing Email Gen page.
// The read-only D1 listing is not a claim that Gmail IMAP delivered or
// an order exists. Verified Discord Success remains the order source.
function setupCloudflareArchive(){
 const refresh=mailUIElement('sngArchiveRefresh');
 const aliasField=mailUIElement('sngArchiveAlias');
 const status=mailUIElement('sngArchiveStatus');
 const results=mailUIElement('sngArchiveResults');
 if(!refresh||!aliasField||!status||!results)return;
 const addCell=(row,value)=>{
  const cell=document.createElement('td');
  cell.style.cssText='padding:7px;border-bottom:1px solid #355067;word-break:break-word';
  cell.textContent=String(value);
  row.append(cell);
 };
 refresh.addEventListener('click',async()=>{
  refresh.disabled=true;
  status.textContent='Reading Cloudflare receipt index securely...';
  results.replaceChildren();
  try{
   requireOwner();
   const alias=String(aliasField.value||'').trim().toLowerCase();
   const apiFunction=api()?.inboundArchiveRecent;
   if(typeof apiFunction!=='function')throw Error('Update ACO Studio to a build that includes Cloudflare archive access.');
   const result=await apiFunction({alias,limit:50});
   if(result?.provider!=='cloudflare-d1'||!Array.isArray(result.messages))throw Error('Unexpected Cloudflare archive response.');
   const table=document.createElement('table');
   table.style.cssText='width:100%;border-collapse:collapse;font-size:12px';
   const head=document.createElement('tr');
   for(const label of ['Received','Original address','Type','Size','Expiry'])addCell(head,label);
   table.append(head);
   for(const item of result.messages){
    const row=document.createElement('tr');
    addCell(row,Number.isFinite(item.receivedAt)?new Date(item.receivedAt).toLocaleString():'Unknown');
    addCell(row,item.alias||'');
    addCell(row,item.kind==='verification'?'Verification':'Order/shipping/other');
    addCell(row,Number.isFinite(item.sizeBytes)?item.sizeBytes+' bytes':'—');
    addCell(row,Number.isFinite(item.expiresAt)?new Date(item.expiresAt).toLocaleString():'Unknown');
    table.append(row);
   }
   results.append(table);
   status.textContent=result.messages.length+' archived messages indexed. This view does not read Gmail or prove Shikari/Valor IMAP access. Discord Success is still required for verified order totals.';
  }catch(error){
   status.textContent='Cloudflare archive unavailable: '+String(error?.message||error);
  }finally{refresh.disabled=false;}
 });
}
