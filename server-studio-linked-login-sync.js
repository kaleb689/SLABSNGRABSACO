// Explicit, owner-confirmed updates of an EXACT customer-linked retailer login.
// Never infer a linkage from names, addresses, credit cards or import row order.
export function registerStudioLinkedLoginSync({
 app,requireAdmin,serialize,getManagedAccounts,saveManagedAccounts,getAssignments,
 normalizeRetailerCredentials,encryptJson,decryptJson,managedAssignmentIsLinked,
 broadcastLiveDataChange=()=>{}
}){
 app.post('/api/admin/aco-studio/linked-retailer-login/:type/:id',requireAdmin,serialize,async(req,res)=>{
  res.set('Cache-Control','no-store, private');
  const body=req.body||{},type=req.params.type,id=String(req.params.id||'');
  const retailer=String(body.retailer||''),customerId=String(body.expectedCustomerAccountId||'');
  const oldEmail=String(body.expectedEmail||'').trim().toLowerCase();
  const newEmail=String(body.newEmail||'').trim().toLowerCase();
  if(!['free','rented'].includes(type)||!['target','walmart','pokemoncenter'].includes(retailer)||
     !id||!customerId||body.confirmed!==true||
     typeof body.expectedUpdatedAt!=='string'||!body.expectedUpdatedAt||
     !/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(oldEmail)||
     !/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(newEmail))
   return res.status(400).json({error:'Confirm the exact retailer, customer assignment, old email and new email.'});
  // Change of credentials is not permitted to silently reassign the account.
  if(body.newPassword!==undefined&&(typeof body.newPassword!=='string'||body.newPassword.length>512))
   return res.status(400).json({error:'Invalid retailer password.'});
  try{
   const [free,rented,accounts]=await Promise.all([getAssignments('free'),getAssignments('rented'),getManagedAccounts()]);
   const assigned=[...free.map(x=>({...x,assignmentType:'free'})),...rented.map(x=>({...x,assignmentType:'rented'}))];
   const current=assigned.find(x=>x.assignmentType===type&&String(x.managedAccountId||x.freeMembershipId||x.rentedMembershipId||'')===id&&managedAssignmentIsLinked(x));
   if(!current||String(current.customerAccountId||'')!==customerId||
      String(current.updatedAt||'')!==body.expectedUpdatedAt)
    return res.status(409).json({error:'Customer assignment changed or no longer belongs to this customer. Refresh the linked profile.'});
   const assignedRetailer=String(current.assignmentRetailer||current.rentalRetailer||'');
   if(assignedRetailer&&assignedRetailer!==retailer)
    return res.status(409).json({error:'The selected assignment belongs to a different retailer.'});
   const index=accounts.findIndex(x=>String(x.id)===id);
   if(index<0)return res.status(404).json({error:'The exact managed retailer account does not exist.'});
   const account=accounts[index];
   const credentials=normalizeRetailerCredentials(account.credentials?decryptJson(account.credentials):{});
   if(String(credentials[retailer]?.username||'').trim().toLowerCase()!==oldEmail)
    return res.status(409).json({error:'The linked retailer email has changed. Reopen the current website profile.'});
   for(const other of accounts){
    if(String(other.id)===id)continue;
    const data=normalizeRetailerCredentials(other.credentials?decryptJson(other.credentials):{});
    const match=Object.entries(data).some(([key,v])=>key===retailer&&String(v?.username||'').trim().toLowerCase()===newEmail);
    if(match)return res.status(409).json({error:'The replacement email is already used by another managed retailer account.'});
   }
   // Enforce distinct website customer vaults even if a login appears in a
   // different retailer on another customer. Same customer's Target/PKC reuse is allowed.
   const linkedIds=new Map();
   for(const assignment of assigned)if(managedAssignmentIsLinked(assignment)){
    const key=String(assignment.managedAccountId||assignment.freeMembershipId||assignment.rentedMembershipId||'');
    if(key&&String(assignment.customerAccountId)!==customerId)linkedIds.set(key,true);
   }
   for(const other of accounts){
    if(!linkedIds.has(String(other.id)))continue;
    const data=normalizeRetailerCredentials(other.credentials?decryptJson(other.credentials):{});
    if(Object.values(data).some(v=>String(v?.username||'').trim().toLowerCase()===newEmail))
     return res.status(409).json({error:'Email is linked to a different customer; import must skip it.'});
   }
   const pass=body.newPassword!==undefined?body.newPassword:credentials[retailer]?.password||'';
   credentials[retailer]={...credentials[retailer],username:newEmail,password:pass};
   account.credentials=encryptJson(credentials);
   account.updatedAt=new Date().toISOString();
   await saveManagedAccounts(accounts);
   broadcastLiveDataChange('linked-retailer-login-corrected');
   return res.json({ok:true,saved:true,retailer,managedAccountId:id,customerAccountId:customerId,oldEmail,newEmail,linked:true});
  }catch(error){
   console.error('Exact linked retailer email update failed:',error?.message);
   return res.status(503).json({error:'Could not update the linked retailer login. Reopen and review the website assignment.'});
  }
 });
}
