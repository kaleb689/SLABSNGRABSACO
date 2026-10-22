"use strict";
const crypto=require("node:crypto");
const RETAILERS=new Set(["target","walmart","pokemoncenter","costco","sams"]);
const BANKS=new Set(["working","live"]);
const currentBank=row=>row?.bank==="live"?"live":"working";
function validateSelection(state,input){
 if(!state||!Array.isArray(state.sources))throw Error("Profile vault unavailable.");
 if(!RETAILERS.has(input?.retailer)||!BANKS.has(input?.fromBank))throw Error("Choose an exact retailer and source profile bank.");
 const ids=input?.fileIds;
 if(!Array.isArray(ids)||ids.length<1||ids.length>500||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=="string"))throw Error("Select 1-500 distinct profile files.");
 const found=ids.map(id=>state.sources.find(row=>row.id===id));
 if(found.some(row=>!row||row.retailer!==input.retailer||currentBank(row)!==input.fromBank))
  throw Error("Selected files changed banks or no longer belong to this retailer. Refresh the selection.");
 return {ids,found};
}
function appendImport(state,files,{retailer,bank,now=()=>new Date().toISOString(),uuid=crypto.randomUUID}={}){
 if(!RETAILERS.has(retailer)||!BANKS.has(bank)||!Array.isArray(files)||!files.length||files.length>100)throw Error("Invalid import batch.");
 const batchId=uuid(),at=now();
 state.importHistory||=[];
 for(const file of files){file.batchId=batchId;file.importedAt=at;}
 state.sources.push(...files);
 state.importHistory.push({id:batchId,at,retailer,bank,sourceIds:files.map(f=>f.id),filenames:files.map(f=>f.file.filename),fileCount:files.length,profileCount:files.reduce((n,f)=>n+f.file.rows.length,0),removedAt:null});
 return {batchId,imported:files.length,profiles:files.reduce((n,f)=>n+f.file.rows.length,0)};
}
function history(state){
 const sources=new Set((state.sources||[]).map(x=>x.id));
 return (state.importHistory||[]).map(batch=>({
  id:batch.id,at:batch.at,retailer:batch.retailer,bank:batch.bank,filenames:batch.filenames,
  fileCount:batch.fileCount,profileCount:batch.profileCount,removedAt:batch.removedAt||null,
  remainingFiles:(batch.sourceIds||[]).filter(id=>sources.has(id)).length
 })).reverse();
}
function moveSelected(state,input){
 if(input?.confirmed!==true||!BANKS.has(input?.toBank))throw Error("Confirm the destination profile bank.");
 const {found}=validateSelection(state,input);
 if(input.toBank===input.fromBank)throw Error("Choose the other profile bank.");
 for(const row of found)row.bank=input.toBank;
 return {saved:true,moved:found.length,bank:input.toBank};
}
function deleteSelected(state,input){
 if(input?.confirmed!==true)throw Error("Confirm deletion of the selected local profile files.");
 const {ids}=validateSelection(state,input),set=new Set(ids);
 state.sources=state.sources.filter(x=>!set.has(x.id));
 return {deleted:ids.length};
}
function deleteImport(state,{batchId,confirmed}={}){
 if(confirmed!==true||typeof batchId!=="string")throw Error("Confirm the exact import batch to remove.");
 const batch=(state.importHistory||[]).find(row=>row.id===batchId);
 if(!batch||batch.removedAt)throw Error("Import batch is missing or already removed.");
 const ids=new Set(batch.sourceIds||[]);
 // Only this batch's exact saved file IDs; legacy/manual files are untouched.
 const found=state.sources.filter(row=>ids.has(row.id)&&row.batchId===batchId);
 state.sources=state.sources.filter(row=>!ids.has(row.id)||row.batchId!==batchId);
 batch.removedAt=new Date().toISOString();
 return {removed:found.length,batchId};
}
module.exports={appendImport,history,moveSelected,deleteSelected,deleteImport};
