import crypto from 'node:crypto';
export function savedDataRevision(kind,item,secret=process.env.SUBMISSION_ENCRYPTION_KEY){
 if(!secret)throw Error('Encrypted customer storage is not configured.');
 const value={...item};delete value.revision;
 return crypto.createHmac('sha256',secret).update(kind+'\0'+JSON.stringify(value)).digest('hex');
}
export function savedDataPrecondition(req,res,kind,item){
 const revision=req.body?.expectedRevision||req.get?.('If-Match');
 if(!revision){res.status(428).json({error:'Reopen the latest saved record before editing or deleting it.'});return false;}
 if(revision!==savedDataRevision(kind,item)){res.status(409).json({error:'This record changed on another device. Your changes were not saved. Reopen it and review the latest values.'});return false;}
 return true;
}
