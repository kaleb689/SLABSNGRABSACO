import crypto from 'node:crypto';
import {managedWriteConflict} from './managed-customer-write-policy.js';
export function registerStudioAssignmentActions({app,requireAdmin,serialize,getCustomerAccounts,getAssignments,saveAssignments,findAssignment,activeMembershipForCustomer,clearAssignment,normalizeDuration,broadcastLiveDataChange=()=>{}}){
 app.post('/api/admin/aco-studio/assignments/:type/:id/reassign',requireAdmin,serialize,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   const {type,id}=req.params,body=req.body||{};
   if(!['free','rented'].includes(type)||body.confirmed!==true||!body.expectedCustomerAccountId||!Object.hasOwn(body,'expectedUpdatedAt'))return res.status(400).json({error:'Confirm the exact customer assignment and its current version.'});
   const rows=await getAssignments(type),current=findAssignment(type,rows,id);
   if(!current)return res.status(404).json({error:'This account is no longer linked.'});
   const refused=managedWriteConflict(current,body);if(refused)return res.status(refused.status).json({error:refused.error});
   if(type==='rented'&&current.stripeSubscriptionId)return res.status(409).json({error:'This rental has an active billing subscription. Manage its subscription before reassigning the account; no change was made.'});
   const targetId=String(body.targetCustomerId||''),target=(await getCustomerAccounts()).find(x=>String(x.id)===targetId),durationType=normalizeDuration(body.durationType);
   if(!target||targetId===String(current.customerAccountId)||!durationType)return res.status(400).json({error:'Choose a different authorized customer and a supported duration.'});
   const membership=await activeMembershipForCustomer(targetId);
   if(!membership)return res.status(403).json({error:'The receiving customer needs an active membership.'});
   const now=new Date().toISOString(),managedAccountId=String(current.managedAccountId||current.freeMembershipId||current.rentedMembershipId||id),retailer=current.assignmentRetailer||current.rentalRetailer;
   const next={id:crypto.randomUUID(),managedAccountId,customerAccountId:targetId,paidSubmissionId:membership.id,active:true,durationType,activationStatus:'awaiting_activation',activationRequestedAt:now,startsAt:null,expiresAt:null,createdAt:now,updatedAt:now,reassignedFromAssignmentId:current.id};
   if(type==='free'){next.freeMembershipId=managedAccountId;next.assignmentRetailer=retailer;}else{next.rentedMembershipId=managedAccountId;next.rentalRetailer=retailer;}
   const previousCustomerAccountId=current.customerAccountId;
   clearAssignment(current,{reason:'reassigned',nowIso:now});
   current.previousCustomerAccountId=previousCustomerAccountId;current.reassignedToCustomerAccountId=targetId;current.replacedByAssignmentId=next.id;
   rows.push(next);await saveAssignments(type,rows);broadcastLiveDataChange('managed-account-reassigned');
   return res.json({ok:true,saved:true,managedAccountId,customerAccountId:targetId,assignmentId:next.id});
  }catch{return res.status(503).json({error:'Unable to reassign this account. Reopen the current assignment before retrying.'});}
 });
}
