import { mergeManagedCard, serializeManagedWrites } from './managed-customer-write-policy.js';
'use strict';
/**
 * Authenticated ACO Studio bridge for the very same customer saved-address
 * and card vault used by the customer website and mobile app. This does not
 * create a second database or permit access to the owner's Personal vault.
 * Read responses never include payment PAN, password or verification codes.
 */
import crypto from 'node:crypto';
import {savedDataRevision} from './saved-data-revisions.js';
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x||{},k);
export function registerStudioCustomerRoutes({
 app,requireAdmin,getCustomerAccounts,saveCustomerAccounts,getCustomerVault,
 saveCustomerVault,customerSavedAddresses,sanitizeShippingAddress,
 validShippingAddress,sanitizeSavedPaymentMethod,validSavedPaymentMethod,
 getAllCustomerSavedDetails,customerPaymentActions,
 syncCustomerMissingNotification=async()=>{},broadcastLiveDataChange=()=>{},revisionSecret,serializeCustomerSavedWrites
}){
 const serialize = serializeCustomerSavedWrites||serializeManagedWrites();
 const fingerprint=(kind,item)=>savedDataRevision(kind,item,revisionSecret);
 const id=v=>String(v||'').trim().slice(0,150);
 const select=async req=>{
  const accounts=await getCustomerAccounts(),index=accounts.findIndex(x=>String(x.id)===id(req.params.id));
  if(index<0)return null;
  return {accounts,index,account:accounts[index]};
 };
 const conflict=(req,res,item,kind)=>{
  if(typeof req.body?.expectedRevision!=='string'||!req.body.expectedRevision)return res.status(428).json({error:'Reopen this customer record before editing; a current version is required.'});
  if(req.body.expectedRevision!==fingerprint(kind,item))return res.status(409).json({error:'This customer record changed on the website or app. Reload the latest information; nothing was overwritten.'});
  return null;
 };
 const saved=async accountId=>{try{await syncCustomerMissingNotification(accountId);}catch(e){console.error('Studio sync: saved, but follow-up notification failed:',e?.message);}};
 const addressPublic=a=>({id:a.id,label:a.label,firstName:a.firstName,lastName:a.lastName,address:a.address,address2:a.address2,city:a.city,state:a.state,zip:a.zip,country:a.country,revision:fingerprint('address',a)});
 const paymentPublic=c=>({id:c.id,source:c.source||'saved',cardLabel:c.cardLabel,cardholder:c.cardholder,maskedNumber:'•••• '+String(c.acoCardNumber||c.cardNumber||'').replace(/\D/g,'').slice(-4),last4:String(c.acoCardNumber||c.cardNumber||'').replace(/\D/g,'').slice(-4),expMonth:c.expMonth,expYear:c.expYear,revision:c.revision||fingerprint('payment',c)});
 app.get('/api/admin/aco-studio/customers/:id/saved-data',requireAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   const a=await select(req);if(!a)return res.status(404).json({error:'Customer does not exist.'});
   const details=typeof getAllCustomerSavedDetails==='function'
     ? await getAllCustomerSavedDetails(a.account) : null;
   const vault=details ? null : await getCustomerVault(a.account.id);
   return res.json({ok:true,customer:{id:a.account.id,email:a.account.email,firstName:a.account.firstName||'',lastName:a.account.lastName||'',updatedAt:a.account.updatedAt||null},
    addresses:customerSavedAddresses(a.account).map(addressPublic),
    paymentMethods:(details?.paymentMethods || vault?.paymentMethods || []).map(paymentPublic)});
  }catch(e){console.error('Studio customer snapshot:',e?.message);return res.status(503).json({error:'Unable to load saved customer data.'});}
 });
 app.put('/api/admin/aco-studio/customers/:id/shipping-addresses/:addressId',requireAdmin,serialize,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   const a=await select(req);if(!a)return res.status(404).json({error:'Customer does not exist.'});
   const items=customerSavedAddresses(a.account),index=items.findIndex(x=>String(x.id)===id(req.params.addressId));
   if(index<0)return res.status(404).json({error:'This saved address no longer exists. Reload first.'});
   const refused=conflict(req,res,items[index],'address');if(refused)return refused;
   const next=sanitizeShippingAddress(req.body?.address||{},items[index].id);
   if(!validShippingAddress(next))return res.status(400).json({error:'Complete the shipping name, street, city, state, postal code and country.'});
   items[index]=next;a.account.shippingAddresses=items;a.account.updatedAt=new Date().toISOString();
   await saveCustomerAccounts(a.accounts);broadcastLiveDataChange('customer-shipping-updated');await saved(a.account.id);
   return res.json({ok:true,saved:true,address:addressPublic(next),message:'Saved in the live customer website and app address vault.'});
  }catch(e){console.error('Studio address save:',e?.message);return res.status(503).json({error:'Unable to save this website address.'});}
 });
 app.put('/api/admin/aco-studio/customers/:id/payment-methods/:paymentId',requireAdmin,serialize,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   const a=await select(req);if(!a)return res.status(404).json({error:'Customer does not exist.'});
   if (customerPaymentActions) {
    const input=req.body?.payment||{};
    const result=await customerPaymentActions.update({
     accountId:a.account.id,id:req.params.paymentId,
     expectedRevision:req.body?.expectedRevision,
     body:{cardLabel:input.cardLabel,cardholder:input.cardholder,
      acoCardNumber:input.acoCardNumber,expMonth:input.expMonth,expYear:input.expYear}
    });
    broadcastLiveDataChange('customer-payment-updated');
    await saved(a.account.id);
    const latest=await getAllCustomerSavedDetails(a.account);
    const updated=(latest.paymentMethods||[]).find(x=>String(x.id)===id(req.params.paymentId));
    return res.json({...result,saved:true,paymentMethod:updated?paymentPublic(updated):null});
   }
   const vault=await getCustomerVault(a.account.id),items=Array.isArray(vault.paymentMethods)?vault.paymentMethods:[];
   const index=items.findIndex(x=>String(x.id)===id(req.params.paymentId));
   if(index<0)return res.status(404).json({error:'This saved payment card no longer exists. Reload first.'});
   const refused=conflict(req,res,items[index],'payment');if(refused)return refused;
   const input=req.body?.payment||{};
   // Only explicit card identity and expiration fields are accepted here.
   // The server validator preserves the original PAN if number is omitted.
   // Never accept or echo a CVV/security code from this desktop bridge.
   const next=mergeManagedCard(sanitizeSavedPaymentMethod({cardLabel:input.cardLabel,cardholder:input.cardholder,
    acoCardNumber:input.acoCardNumber,expMonth:input.expMonth,expYear:input.expYear},items[index]));
   if(!validSavedPaymentMethod(next))return res.status(400).json({error:'Enter a valid cardholder, number (if changing it), month and year.'});
   items[index]=next;vault.paymentMethods=items;
   await saveCustomerVault(a.account.id,vault);
   a.account.updatedAt=new Date().toISOString();await saveCustomerAccounts(a.accounts);broadcastLiveDataChange('customer-payment-updated');await saved(a.account.id);
   return res.json({ok:true,saved:true,paymentMethod:paymentPublic(next),message:'Saved in the live customer website and app payment vault.'});
  }catch(e){if(e?.status>=400&&e.status<500)return res.status(e.status).json({error:e.message});
   console.error('Studio payment save:',e?.message);return res.status(503).json({error:'Unable to save this website payment method.'});}
 });
 for(const kind of ['address','payment']){
  const segment=kind==='address'?'shipping-addresses':'payment-methods';
  app.post('/api/admin/aco-studio/customers/:id/'+segment,requireAdmin,serialize,async(req,res)=>{
   res.set('Cache-Control','no-store');
   try{
    if(req.body?.confirmed!==true)return res.status(400).json({error:'Confirm creation in this customer account.'});
    const a=await select(req);if(!a)return res.status(404).json({error:'Customer does not exist.'});
    const vault=kind==='payment'?await getCustomerVault(a.account.id):null;
    const items=kind==='address'?customerSavedAddresses(a.account):vault.paymentMethods||[];
    if(items.length>=20)return res.status(400).json({error:'This customer bank already contains 20 records.'});
    const input=req.body[kind]||{},next=kind==='address'?sanitizeShippingAddress(input):mergeManagedCard(sanitizeSavedPaymentMethod(input));
    if(!(kind==='address'?validShippingAddress(next):validSavedPaymentMethod(next)))return res.status(400).json({error:'Complete all required fields.'});
    items.push(next);
    if(kind==='address'){a.account.shippingAddresses=items;await saveCustomerAccounts(a.accounts);}
    else {
     vault.paymentMethods=items;
     const key=JSON.stringify({number:String(next.acoCardNumber||'').replace(/\D/g,''),expMonth:next.expMonth,expYear:next.expYear,cardholder:String(next.cardholder||'').toUpperCase()});
     vault.hiddenPaymentKeys=(vault.hiddenPaymentKeys||[]).filter(x=>x!==key);
     await saveCustomerVault(a.account.id,vault);
    }
    broadcastLiveDataChange('customer-'+kind+'-created');await saved(a.account.id);
    return res.json({ok:true,saved:true,[kind==='address'?'address':'paymentMethod']:kind==='address'?addressPublic(next):paymentPublic(next)});
   }catch{return res.status(503).json({error:'Unable to create the customer record.'});}
  });
  app.delete('/api/admin/aco-studio/customers/:id/'+segment+'/:recordId',requireAdmin,serialize,async(req,res)=>{
   res.set('Cache-Control','no-store');
   try{
    if(req.body?.confirmed!==true)return res.status(400).json({error:'Confirm deletion of this exact record.'});
    const a=await select(req);if(!a)return res.status(404).json({error:'Customer does not exist.'});
    if (kind==='payment' && customerPaymentActions) {
     const result=await customerPaymentActions.remove({
      accountId:a.account.id,id:req.params.recordId,
      expectedRevision:req.body?.expectedRevision
     });
     broadcastLiveDataChange('customer-payment-deleted');
     await saved(a.account.id);
     return res.json({...result,saved:true,deletedId:id(req.params.recordId)});
    }
    const vault=kind==='payment'?await getCustomerVault(a.account.id):null;
    const items=kind==='address'?customerSavedAddresses(a.account):vault.paymentMethods||[];
    const at=items.findIndex(x=>String(x.id)===id(req.params.recordId));if(at<0)return res.status(404).json({error:'The selected record no longer exists.'});
    const refused=conflict(req,res,items[at],kind);if(refused)return refused;
    items.splice(at,1);
    if(kind==='address'){a.account.shippingAddresses=items;await saveCustomerAccounts(a.accounts);}else{vault.paymentMethods=items;await saveCustomerVault(a.account.id,vault);}
    broadcastLiveDataChange('customer-'+kind+'-deleted');await saved(a.account.id);
    return res.json({ok:true,saved:true,deletedId:id(req.params.recordId)});
   }catch(e){if(e?.status>=400&&e.status<500)return res.status(e.status).json({error:e.message});
    return res.status(503).json({error:'Unable to delete the selected customer record.'});}
  });
 }
 return {addressPublic,paymentPublic};
}

