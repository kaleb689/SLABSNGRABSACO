/*
 * First-time account setup required by Cloudflare's Queue consumers.
 * This creates an account-level workers.dev namespace only when absent.
 * It NEVER attaches a Worker or turns on a public workers.dev route.
 */
const token=process.env.CLOUDFLARE_API_TOKEN;
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!token || !/^[a-f0-9]{32}$/i.test(account||''))throw Error('Cloudflare deployment secrets not configured');
const endpoint='https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/subdomain';
async function request(method,body){
  const response=await fetch(endpoint,{
    method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  let data;
  try{data=await response.json();}catch{throw Error('Invalid Cloudflare Workers subdomain API response');}
  return {status:response.status,data};
}
const existing=await request('GET');
if(existing.status===200 && existing.data?.success && existing.data?.result?.subdomain){
  console.log('Account-level workers.dev namespace already exists; preserving it unchanged.');
}else if(existing.status===404 || (existing.status===200 && existing.data?.success && !existing.data?.result?.subdomain)){
  const label='slabsngrabsaco-'+account.slice(0,8);
  if(!/^[a-z0-9-]{1,63}$/.test(label))throw Error('Invalid proposed workers.dev label');
  const created=await request('PUT',{subdomain:label});
  if(!created.data?.success || !created.data?.result?.subdomain)
    throw Error('Could not register the account-level workers.dev namespace: HTTP '+created.status+
      '; Cloudflare error codes: '+(created.data?.errors||[]).map(x=>x.code).join(','));
  console.log('Registered account-level workers.dev namespace for Queue consumer setup. No public Worker route enabled.');
}else{
  throw Error('Cannot determine whether workers.dev namespace already exists; refusing to replace it (HTTP '+existing.status+
    '; codes '+(existing.data?.errors||[]).map(x=>x.code).join(',')+').');
}
