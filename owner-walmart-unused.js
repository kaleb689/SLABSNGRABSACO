/**
 * Keep unassigned Walmart logins exclusively in the owner's recoverable pool.
 * This function never modifies the managed inventory, customer assignments,
 * credentials or restore holds. Caller must authorize owner/admin access.
 */
export function ownerWalmartUnused({managed,free,rented,holds,duplicates,linked,decrypt}){
 const assignedIds=new Set([...free,...rented].filter(linked).map(a=>String(a.managedAccountId||a.freeMembershipId||a.rentedMembershipId||'')).filter(Boolean));
 const heldIds=new Set(holds||[]),duplicateIds=new Set(duplicates||[]);
 const seen=new Set(),accounts=[],counts={total:0,assigned:0,held:0,duplicate:0,needsRepair:0,invalid:0,available:0};
 for(const account of managed||[]){
  const id=String(account?.id||'');
  if(!id){counts.invalid++;continue;}
  let credentials;
  try{credentials=decrypt(account);}catch{counts.invalid++;continue;}
  const wm=credentials?.walmart||{};
  const email=String(wm.username||'').trim().toLowerCase();
  if(!email)continue;
  counts.total++;
  if(assignedIds.has(id)){counts.assigned++;continue;}
  if(heldIds.has(id)){counts.held++;continue;}
  if(duplicateIds.has(id)||seen.has(email)){counts.duplicate++;continue;}
  if(account.needsRepair===true||String(account.repairStatus||'').toLowerCase()==='needs_repair'){counts.needsRepair++;continue;}
  if(!/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(email)){counts.invalid++;continue;}
  seen.add(email);
  accounts.push({accountId:id,email,password:typeof wm.password==='string'?wm.password:''});
 }
 counts.available=accounts.length;
 return {accounts,counts};
}
