'use strict';
// Pure parser shared by the ACO Studio renderer and its regression tests.
// No credentials leave the selected, owner-authorized encrypted local vault.
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.ACOAccountLoginParser=Object.freeze(api);
})(typeof window!=='undefined'?window:this,function(){
 const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
 function parse(raw){
  if(typeof raw!=='string'||raw.length>2000000)throw Error('Paste fewer than 2 MB of account logins.');
  let lines=raw.replace(/^\uFEFF/,'').split(/\r?\n/).map((value,i)=>({value:value.trim(),line:i+1})).filter(x=>x.value);
  if(lines.length&&/^(?:email|account email|login email)\s*[,;\t|]\s*(?:password|pass)$/i.test(lines[0].value))lines=lines.slice(1);
  if(!lines.length||lines.length>500)throw Error('Paste 1-500 retailer account logins per batch.');
  const seen=new Set(),rows=[];
  for(const entry of lines){
   // Use only the FIRST delimiter. Punctuation inside a password is retained.
   const match=/^([^\s@,:;|\t]+@[^\s@,:;|\t]+\.[^\s@,:;|\t]+)\s*(:{1,3}|;|,|\t|\|)\s*(.+)$/.exec(entry.value);
   const email=match?.[1]?.toLowerCase()||'',password=match?.[3]||'';
   if(!EMAIL.test(email)||email.length>200||!password||password.length>500||
      /[\x00-\x1f\x7f]/.test(password)){
    throw Error('Invalid account on line '+entry.line+'. Use email:password, email:::password or email; password.');
   }
   if(seen.has(email))throw Error('Repeated email on line '+entry.line+'. Keep one account per retailer import.');
   seen.add(email);
   rows.push({email,password});
  }
  return rows;
 }
 return {parse};
});
