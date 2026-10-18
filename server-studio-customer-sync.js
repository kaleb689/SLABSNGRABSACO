'use strict';
/**
 * Authenticated ACO Studio bridge for the very same customer saved-address
 * and card vault used by the customer website and mobile app. This does not
 * create a second database or permit access to the owner's Personal vault.
 * Read responses never include payment PAN, password or verification codes.
 */
import crypto from 'node:crypto';
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x||{},k);
export function registerStudioCustomerRoutes({
 app,requireAdmin,getCustomerAccounts,saveCustomerAccounts,getCustomerVault,
 saveCustomerVault,customerSavedAddresses,sanitizeShippingAddress,
 validShippingAddress,sanitizeSavedPaymentMethod,validSavedPaymentMethod,
 syncCustomerMissingNotification=async()=>{},broadcastLiveDataChange=()=>{},revisionSecret
}){
 if(!revisionSecret)throw Error('Studio sync requires the existing encrypted vault secret.');
 const fingerprint=(kind,item)=>crypto.createHmac('sha256',revisionSecret).update(kind+'\0'+JSON.stringify(item)).digest('hex');
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
 const paymentPublic=c=>({id:c.id,cardLabel:c.cardLabel,cardholder:c.cardholder,maskedNumber:'•••• '+String(c.acoCardNumber||'').replace(/\D/g,'').slice(-4),last4:String(c.acoCardNumber||'').replace(/\D/g,'').slice(-4),expMonth:c.expMonth,expYear:c.expYear,revision:fingerprint('payment',c)});
 app.get('/api/admin/aco-studio/customers/:id/saved-data',requireAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   const a=await select(req);if(!a)return res.status(404).json({error:'Customer does not exist.'});
   const vault=await getCustomerVault(a.account.id);
   return res.json({ok:true,customer:{id:a.account.id,email:a.account.email,firstName:a.account.firstName||'',lastName:a.account.lastName||'',updatedAt:a.account.updatedAt||null},
    addresses:customerSavedAddresses(a.account).map(addressPublic),paymentMethods:(vault.paymentMethods||[]).map(paymentPublic)});
  }catch(e){console.error('Studio customer snapshot:',e?.message);return res.status(503).json({error:'Unable to load saved customer data.'});}
 });
 app.put('/api/admin/aco-studio/customers/:id/shipping-addresses/:addressId',requireAdmin,async(req,res)=>{
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
 app.put('/api/admin/aco-studio/customers/:id/payment-methods/:paymentId',requireAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   const a=await select(req);if(!a)return res.status(404).json({error:'Customer does not exist.'});
   const vault=await getCustomerVault(a.account.id),items=Array.isArray(vault.paymentMethods)?vault.paymentMethods:[];
   const index=items.findIndex(x=>String(x.id)===id(req.params.paymentId));
   if(index<0)return res.status(404).json({error:'This saved payment card no longer exists. Reload first.'});
   const refused=conflict(req,res,items[index],'payment');if(refused)return refused;
   const input=req.body?.payment||{};
   // Only explicit card identity and expiration fields are accepted here.
   // The server validator preserves the original PAN if number is omitted.
   // Never accept or echo a CVV/security code from this desktop bridge.
   const next=sanitizeSavedPaymentMethod({cardLabel:input.cardLabel,cardholder:input.cardholder,
    acoCardNumber:input.acoCardNumber,expMonth:input.expMonth,expYear:input.expYear},items[index]);
   if(!validSavedPaymentMethod(next))return res.status(400).json({error:'Enter a valid cardholder, number (if changing it), month and year.'});
   items[index]=next;vault.paymentMethods=items;
   await saveCustomerVault(a.account.id,vault);
   a.account.updatedAt=new Date().toISOString();await saveCustomerAccounts(a.accounts);broadcastLiveDataChange('customer-payment-updated');await saved(a.account.id);
   return res.json({ok:true,saved:true,paymentMethod:paymentPublic(next),message:'Saved in the live customer website and app payment vault.'});
  }catch(e){console.error('Studio payment save:',e?.message);return res.status(503).json({error:'Unable to save this website payment method.'});}
 });
 return {addressPublic,paymentPublic};
}

