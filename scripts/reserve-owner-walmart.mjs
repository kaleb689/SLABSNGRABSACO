import fs from 'node:fs';
const file='server.js';
let s=fs.readFileSync(file,'utf8');
function replaceOnce(before,after){
 const parts=s.split(before);
 if(parts.length!==2)throw Error('Walmart owner-only patch anchor missing or ambiguous: '+before.slice(0,90));
 s=parts.join(after);
}
if(s.includes('OWNER_WALMART_UNUSED_POLICY_V1')){console.log('Already patched');process.exit(0);}
replaceOnce('import {registerStudioAssignmentActions} from "./server-studio-assignment-actions.js";',
 'import {registerStudioAssignmentActions} from "./server-studio-assignment-actions.js";\nimport {ownerWalmartUnused} from "./owner-walmart-unused.js";');
replaceOnce('  if (!normalizedRetailer) {\n    return [];\n  }\n\n  const [\n    managedAccounts,',
 '  if (!normalizedRetailer) {\n    return [];\n  }\n  // OWNER_WALMART_UNUSED_POLICY_V1: no Walmart inventory is customer-allocatable.\n  if (normalizedRetailer === "walmart") return [];\n\n  const [\n    managedAccounts,');
replaceOnce('  return availability;\n}\n\n\nasync function getAvailableManagedAccountsForRetailer',
 '  availability.walmart.available=0; // Owner Personal Unused only.\n  return availability;\n}\n\n\nasync function getAvailableManagedAccountsForRetailer');
const route=String.raw\`
/* Owner-only Walmart inventory. Credentials remain encrypted in existing
   staff-managed records until explicitly imported into owner Personal vault.
   Never alter any active assignment, restore hold or card/profile records. */
app.post("/api/admin/owner-walmart-unused/export",requireAdmin,async(req,res)=>{
 try{
  if(req.body?.confirmed!==true)return res.status(400).json({error:"Confirm owner Walmart Unused transfer."});
  const [managed,free,rented,holds]=await Promise.all([
   getManagedAccounts(),getFreeAssignments(),getRentalAssignments(),getRestoreHolds()
  ]);
  const linked=assignment=>managedAssignmentIsLinked(assignment);
  const inUseIds=new Set([...free,...rented].filter(linked)
   .map(item=>String(item.managedAccountId||item.freeMembershipId||item.rentedMembershipId||"")));
  const duplicateIds=managedDuplicateCredentialState(managed,inUseIds).duplicateIds;
  const result=ownerWalmartUnused({
   managed,free,rented,holds:heldManagedAccountIdsFromHolds(holds),duplicates:duplicateIds,linked,
   decrypt:account=>account.credentials?normalizeRetailerCredentials(decryptJson(account.credentials)):emptyRetailerCredentials()
  });
  if(result.accounts.length>20000)return res.status(409).json({error:"Owner inventory exceeds import limit."});
  res.set("Cache-Control","no-store, private");res.set("Pragma","no-cache");
  return res.json({ok:true,scope:"personal",retailer:"walmart",ownerOnly:true,
   accounts:result.accounts,counts:result.counts,source:"staff-managed-walmart"});
 }catch(error){
  console.error("Owner Walmart unused inventory error:",error?.message);
  return res.status(503).json({error:"Unable to read owner Walmart inventory. No data was changed."});
 }
});

\`;
replaceOnce('/* ADMIN POOL PROFILE SEARCH: never transmit passwords, cards or security codes. */',
 route+'/* ADMIN POOL PROFILE SEARCH: never transmit passwords, cards or security codes. */');
replaceOnce('          status, assignedTo: owner,',
 '          status:retailer==="walmart"&&status==="available"?"owner_unused":status, assignedTo: owner,');
fs.writeFileSync(file,s);
console.log('Walmart customer allocation locked; owner transfer endpoint inserted; server bytes',s.length);
