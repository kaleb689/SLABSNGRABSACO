'use strict';

// Direct fixed-host network integrations for the installed desktop app.
// Tokens and OAuth secrets are never written to disk or telemetry.
const ID = /^[0-9a-f]{32}$/i;
const LOCAL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const isAddress = (v) => {
  if (typeof v !== 'string') return false;
  const a=v.toLowerCase().split('@');
  return a.length===2 && LOCAL.test(a[0]) && !a[0].includes('..') && DOMAIN.test(a[1]);
};
function validateConfig({accountId,zoneId,token,domain} = {}) {
  if (!ID.test(String(accountId||'')) || !ID.test(String(zoneId||''))) throw Error('Cloudflare Account ID and Zone ID must each have 32 hexadecimal characters.');
  if (typeof token!=='string' || token.trim().length<12) throw Error('A scoped Cloudflare API token is required.');
  const d=String(domain||'').toLowerCase().trim();
  if (!DOMAIN.test(d)) throw Error('Invalid domain.');
  return {accountId,zoneId,token:token.trim(),domain:d};
}
async function requestJson(fetchImpl,url,{method='GET',token,body}={}) {
  const res=await fetchImpl(url,{method,headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const responseText=await res.text();let data;
  try{data=JSON.parse(responseText);}catch(_){throw Error('Remote service returned an invalid response (HTTP '+res.status+').');}
  if(!res.ok || data.success===false){
    const msg=(data.errors||[]).map(e=>e.message).filter(Boolean).join('; ');
    throw Error('Remote service rejected the request (HTTP '+res.status+'): '+(msg||'Check your permissions and settings.'));
  }
  return data;
}
function cloudflare({fetchImpl=global.fetch}={}) {
  const base='https://api.cloudflare.com/client/v4';
  const call=(path,token,method,body)=>requestJson(fetchImpl,base+path,{method,token,body});
  const list=async(path,token)=>{
    let all=[];
    for(let page=1;page<=10;page++){
      // Cloudflare caps Email Routing list page sizes at 50.
      const res=await call(path+(path.includes('?')?'&':'?')+'per_page=50&page='+page,token);
      all.push(...(Array.isArray(res.result)?res.result:[]));
      if(!res.result_info || page >= (res.result_info.total_pages||1) || !(res.result||[]).length)break;
    }
    return all;
  };
  // Ownership proof: require a real API token with Zone Read permission, tied
  // to the actual Cloudflare zone and account. A local password alone is NOT
  // proof of ownership and is never used to authorize Cloudflare writes.
  const authorize=async(options)=>{
    const c=validateConfig(options);
    const raw=await call('/zones/'+c.zoneId,c.token);
    const zone=raw.result;
    if(!zone || String(zone.name||'').toLowerCase()!==c.domain ||
       String(zone.account?.id||'').toLowerCase()!==c.accountId.toLowerCase() ||
       zone.status!=='active')
      throw Error('This Cloudflare token does not prove active DNS control of the requested domain and account.');
    return {authorized:true,domain:c.domain};
  };
  const configCheck=async(options)=>{
    const c=validateConfig(options);
    const info=(await call('/zones/'+c.zoneId+'/email/routing',c.token)).result;
    if (!info || String(info.name||'').toLowerCase() !== c.domain)
      throw Error('Cloudflare zone does not match the domain you entered. No changes made.');
    if (!info.enabled || info.status!=='ready')
      throw Error('Email Routing is not ready for '+c.domain+'. Check its MX records and Email Routing setup in Cloudflare; this app will not change DNS.');
    return c;
  };
  const snapshot=async(options)=>{
    const c=await configCheck(options);
    const [rawDest,rawRules]=await Promise.all([
      list('/accounts/'+c.accountId+'/email/routing/addresses',c.token),
      list('/zones/'+c.zoneId+'/email/routing/rules',c.token)
    ]);
    const destinations=rawDest.map(r=>({email:String(r.email||'').toLowerCase(),verified:!!r.verified}));
    // Include disabled and non-forwarding literal rules. They still reserve
    // their aliases, so recreating one would be dangerous or ambiguous.
    const rules=rawRules.flatMap(r=>{
      const match=r.matchers?.find(m=>m.type==='literal'&&m.field==='to');
      if(!match?.value)return [];
      const action=r.actions?.find(a=>['forward','drop','worker'].includes(a.type));
      return [{id:r.id,alias:String(match.value).toLowerCase(),
        target:action?.type==='forward'?String(action.value?.[0]||'').toLowerCase():'',
        name:r.name||'',enabled:r.enabled!==false,kind:action?.type||'unknown'}];
    });
    return {domain:c.domain,status:'ready',ready:true,destinations,rules};
  };
  async function publish(options){
    const c=await configCheck(options);
    if(!Array.isArray(options.aliases) || options.aliases.length<1 || options.aliases.length>100)throw Error('Choose between 1 and 100 aliases per publish operation.');
    const snap=await snapshot(options),dest=new Map(snap.destinations.map(r=>[r.email,r]));
    const rules=new Map();
    for(const r of snap.rules){if(!rules.has(r.alias))rules.set(r.alias,[]);rules.get(r.alias).push(r);}
    const items=[];
    for(const {alias,target} of options.aliases){
      const a=String(alias||'').trim().toLowerCase(),t=String(target||'').trim().toLowerCase();
      if(!isAddress(a) || !isAddress(t) || !a.endsWith('@'+c.domain)) {items.push({alias:a,status:'conflict',error:'Invalid alias or destination.'});continue;}
      if(t.endsWith('@'+c.domain)){items.push({alias:a,status:'conflict',error:'Forwarding back into the same routed domain may loop.'});continue;}
      const existing=rules.get(a)||[];
      if(existing.length){
        const activeSame=existing.find(r=>r.enabled&&r.kind==='forward'&&r.target===t);
        const pausedSame=existing.find(r=>!r.enabled&&r.kind==='forward'&&r.target===t);
        items.push(activeSame?{alias:a,status:'live',remoteId:activeSame.id}:
          pausedSame&&existing.length===1?{alias:a,status:'paused',remoteId:pausedSame.id,error:'Enable the existing rule in Cloudflare.'}:
          {alias:a,status:'conflict',error:'A Cloudflare rule already uses this email address. No changes made.'});
        continue;
      }
      if(!dest.has(t)){
        try{
          const response=await call('/accounts/'+c.accountId+'/email/routing/addresses',c.token,'POST',{email:t});
          dest.set(t,{email:t,verified:!!response.result?.verified});
        }catch(err){items.push({alias:a,status:'draft',error:err.message});continue;}
      }
      if(!dest.get(t).verified){items.push({alias:a,status:'pending'});continue;}
      try {
        const created=await call('/zones/'+c.zoneId+'/email/routing/rules',c.token,'POST',{
          name:'Jig Studio: '+a,enabled:true,matchers:[{type:'literal',field:'to',value:a}],actions:[{type:'forward',value:[t]}]
        });
        const id=created.result?.id||null;
        rules.set(a,[{alias:a,target:t,id,enabled:true,kind:'forward'}]);items.push({alias:a,status:'live',remoteId:id});
      }catch(err){items.push({alias:a,status:'draft',error:err.message});}
    }
    return {items};
  }
  return {authorize,check:snapshot,publish};
}
async function lookupZip(zip,fetchImpl=global.fetch){
  if(!/^\d{5}$/.test(zip))throw Error('Provide a 5-digit US ZIP.');
  const data=await requestJson(fetchImpl,'https://api.zippopotam.us/us/'+zip);
  if (!Array.isArray(data.places))throw Error('Unexpected ZIP lookup response.');
  return data;
}
async function lookupUsps({id,secret,addresses},fetchImpl=global.fetch){
  if(typeof id!=='string'||!id.trim()||typeof secret!=='string'||!secret.trim())throw Error('USPS Client ID and Secret are required.');
  if(!Array.isArray(addresses)||addresses.length<1||addresses.length>50)throw Error('Choose between 1 and 50 addresses.');
  const tokenData=await requestJson(fetchImpl,'https://apis.usps.com/oauth2/v3/token',{
    method:'POST',body:{client_id:id,client_secret:secret,grant_type:'client_credentials'}
  });
  const auth=tokenData.access_token;
  if(!auth)throw Error('USPS credentials were not accepted.');
  const results=[];
  for(const input of addresses){
    const a=Object.fromEntries(['address1','address2','city','state','zip'].map(k=>[k,String(input?.[k]||'').trim()]));
    if(!a.address1 || !/^[A-Za-z]{2}$/.test(a.state) || !/^\d{5}(?:-\d{4})?$/.test(a.zip) || a.address1.length>120){results.push({input:a,ok:false,reason:'Invalid input'});continue;}
    const url=new URL('https://apis.usps.com/addresses/v3/address');
    url.searchParams.set('streetAddress',a.address1);
    if(a.address2)url.searchParams.set('secondaryAddress',a.address2);
    if(a.city)url.searchParams.set('city',a.city);
    url.searchParams.set('state',a.state.toUpperCase());
    url.searchParams.set('ZIPCode',a.zip.slice(0,5));
    try {
      const data=await requestJson(fetchImpl,url.toString(),{token:auth});
      const zip4=String(data.address?.ZIPPlus4||'');
      if (/^\d{4}$/.test(zip4) && data.additionalInfo?.DPVConfirmation!=='N')results.push({input:a,ok:true,zip4});
      else results.push({input:a,ok:false,reason:'USPS did not verify a ZIP+4.'});
    }catch(err){results.push({input:a,ok:false,reason:err.message});}
  }
  return {results};
}

// Accept common full state names from customer shipping templates without
// rewriting the imported/exported state field. The outgoing API uses USPS codes.
const US_STATE_CODES = Object.freeze(Object.fromEntries([
 ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
 ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],
 ['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],
 ['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],
 ['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],
 ['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],
 ['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],
 ['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],
 ['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],
 ['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],
 ['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],
 ['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],
 ['WI','Wisconsin'],['WY','Wyoming']
].flatMap(([code,name])=>[[code.toLowerCase(),code],[name.toLowerCase(),code]])));
// Smarty's authenticated US Street Address API. Session-only key pair:
// do not persist or log credentials, raw customer addresses, or responses.
// Single HTTPS origin; never accept caller-supplied endpoints.
async function lookupSmarty({authId,authToken,addresses}={},fetchImpl=global.fetch){
  if(typeof authId!=='string'||!authId.trim()||authId.length>180||/[\r\n]/.test(authId)||
     typeof authToken!=='string'||!authToken.trim()||authToken.length>300||/[\r\n]/.test(authToken))
    throw Error('Enter your Smarty US Street API Auth ID and Auth Token.');
  if(!Array.isArray(addresses)||addresses.length<1||addresses.length>50)
    throw Error('Choose between 1 and 50 distinct saved mailing addresses.');
  if(typeof fetchImpl!=='function')throw Error('Network connection is unavailable.');
  const checked=addresses.map(input=>{
    const a=Object.fromEntries(['address1','address2','city','state','zip'].map(k=>[k,String(input?.[k]||'').trim()]));
    if(!a.address1||a.address1.length>120||a.address2.length>100||a.city.length>100||
       !US_STATE_CODES[a.state.toLowerCase()]||!/^[0-9]{5}(?:-[0-9]{4})?$/.test(a.zip))
      throw Error('Selected profiles must have a complete street, valid state and five-digit ZIP.');
    return a;
  });
  // A secret key pair is accepted in a Basic Authorization header. The credentials
  // never appear in the URL, public GitHub repository, disk cache, or logs.
  const auth='Basic '+Buffer.from(authId.trim()+':'+authToken.trim(),'utf8').toString('base64');
  const body=checked.map((a,i)=>({input_id:String(i),street:a.address1,secondary:a.address2,
    city:a.city,state:US_STATE_CODES[a.state.toLowerCase()],zipcode:a.zip.slice(0,5),candidates:1,match:'strict'}));
  const response=await fetchImpl('https://us-street.api.smarty.com/street-address',{
    method:'POST',redirect:'error',headers:{accept:'application/json','content-type':'application/json; charset=utf-8',authorization:auth},
    body:JSON.stringify(body),signal:AbortSignal.timeout(30000)
  });
  if(!response.ok){
    if(response.status===401||response.status===403)throw Error('Smarty denied the API request. Check your Auth ID, Auth Token, and subscription.');
    if(response.status===402||response.status===429)throw Error('Smarty API quota or rate limit reached.');
    throw Error('Smarty address verification unavailable (HTTP '+response.status+').');
  }
  let records;
  try{records=await response.json();}catch(_){throw Error('Smarty returned an unreadable response.');}
  if(!Array.isArray(records)||records.length>250)throw Error('Smarty returned an unexpected address response.');
  const hits=new Map(),ambiguous=new Set();
  for(const r of records){
    if(!r||typeof r!=='object')continue;
    const idx=Number(r.input_index??r.input_id);
    if(!Number.isSafeInteger(idx)||idx<0||idx>=checked.length)continue;
    if(hits.has(idx)){ambiguous.add(idx);continue;}
    hits.set(idx,r);
  }
  const results=checked.map((input,i)=>{
    const r=hits.get(i);
    if(!r||ambiguous.has(i))return {input,ok:false,reason:'No single verified address match.'};
    const plus4=String(r.components?.plus4_code||'');
    const zip5=String(r.components?.zipcode||'');
    const dpv=String(r.analysis?.dpv_match_code||'');
    // Only a full, delivery-point-confirmed match qualifies. A root address
    // without a confirmed apartment (DPV S/D) must never supply a unit ZIP+4.
    if(dpv!=='Y'||!/^[0-9]{4}$/.test(plus4))
      return {input,ok:false,reason:'USPS delivery point or apartment was not confirmed.'};
    if(zip5!==input.zip.slice(0,5))
      return {input,ok:false,reason:'Verified address has a different five-digit ZIP; review before applying.'};
    return {input,ok:true,zip4:plus4,provider:'Smarty'};
  });
  return {provider:'Smarty US Street Address API',results};
}
// Import only from well-known public file hosts, never localhost, private network
// addresses, arbitrary servers or HTTP. The user explicitly supplies every URL;
// app does not crawl devices, repositories, or cloud accounts.
const FILE_EXT = /\.(csv|tsv|tab|psv|json|jsonl|ndjson|txt)$/i;
function allowedRemoteHost(host){
  const h=String(host||'').toLowerCase();
  return [
    'raw.githubusercontent.com','gist.githubusercontent.com','github.com',
    'storage.googleapis.com','drive.google.com','docs.google.com',
    'dl.dropboxusercontent.com','1drv.ms'
  ].includes(h) || [
    '.googleusercontent.com','.dropbox.com','.dropboxusercontent.com',
    '.onedrive.live.com','.sharepoint.com','.box.com','.boxcloud.com'
  ].some(suffix=>h.endsWith(suffix) && h.length>suffix.length);
}
function validateRemoteUrl(input){
  if(typeof input!=='string' || input.length>2048)throw Error('Enter a public HTTPS file URL.');
  let u;try{u=new URL(input.trim());}catch(_){throw Error('Enter a valid HTTPS URL.');}
  if(u.protocol!=='https:' || u.username || u.password || u.port || !allowedRemoteHost(u.hostname))
    throw Error('For security, use a public direct HTTPS file link from GitHub, Google Drive, Dropbox, OneDrive, SharePoint or Box.');
  return u;
}
async function importRemoteFile(url,filename='',fetchImpl=global.fetch){
  let next=validateRemoteUrl(url);
  const name=String(filename||decodeURIComponent(next.pathname.split('/').pop()||'')).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,160);
  if(!FILE_EXT.test(name))throw Error('Provide a filename ending in CSV, TSV, TXT or JSON (including JSONL/NDJSON).');
  for(let attempt=0;attempt<=4;attempt++){
    const r=await fetchImpl(next.toString(),{redirect:'manual',headers:{accept:'text/plain, text/csv, application/json, application/octet-stream;q=0.5'},signal:AbortSignal.timeout(25000)});
    if([301,302,303,307,308].includes(r.status)){
      if(attempt===4)throw Error('Too many remote redirects.');
      next=validateRemoteUrl(new URL(r.headers.get('location')||'',next).toString());continue;
    }
    if(!r.ok)throw Error('Remote file unavailable (HTTP '+r.status+'). For private cloud files, sign in to your own account and download locally first.');
    const mime=(r.headers.get('content-type')||'').toLowerCase();
    if(/html|javascript|xml/.test(mime))throw Error('The link returned a website or login page, not a downloadable file.');
    const size=Number(r.headers.get('content-length'));
    const max=26*1024*1024;
    if(size>max)throw Error('Online file exceeds 26 MB.');
    const chunks=[];let total=0;
    if(!r.body?.getReader)throw Error('Online file response could not be read safely.');
    const reader=r.body.getReader();
    try{
      for(;;){const {value,done}=await reader.read();if(done)break;
        total+=value.byteLength;if(total>max)throw Error('Online file exceeds 26 MB.');chunks.push(Buffer.from(value));
      }
    }finally{if(total>max)await reader.cancel().catch(()=>{});}
    if(!total)throw Error('The online file is empty.');
    let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}
    catch(_){throw Error('Only UTF-8 text files are supported.');}
    if(/^[\s\uFEFF]*<(?:!doctype|html|head|body|script)/i.test(content))throw Error('The link returned an HTML page, not an account file.');
    return {name,text:content,size:total,source:'online'};
  }
  throw Error('Online import failed.');
}
async function dnsMailCheck(domain,fetchImpl=global.fetch){
  const d=String(domain||'').trim().toLowerCase();
  if(!DOMAIN.test(d))throw Error('Invalid domain.');
  const u='https://cloudflare-dns.com/dns-query?name='+encodeURIComponent(d)+'&type=MX';
  const r=await fetchImpl(u,{headers:{accept:'application/dns-json'},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('DNS check unavailable (HTTP '+r.status+').');
  const data=await r.json();
  if(data.Status!==0 && data.Status!==3)throw Error('DNS service returned an error.');
  const mx=(data.Answer||[]).filter(x=>x.type===15).map(x=>String(x.data||'').replace(/\.$/,'').trim()).filter(Boolean);
  return {domain:d,mx,warning:mx.some(x=>/google\.com|outlook\.com|protection\.outlook\.com|zoho\.|hostinger\.|secureserver\./i.test(x))
    ? 'An existing external email provider may be handling this domain. Do not change MX records until its administrator confirms compatibility.'
    : mx.some(x=>/mx\.cloudflare\.net/i.test(x))
      ? 'Cloudflare MX records found. This is not proof that Email Routing is enabled or ready.'
      : 'MX results alone do not prove Email Routing is ready. Check your current mail service before changing any records.'};
}
// Florida mailing-city reference: public preferred/acceptable labels sourced from
// unitedstateszipcodes.org's ZIP data via a fixed, pinned GitHub archive mirror.
// Never treats a five-digit ZIP/city relation as a street-specific ZIP+4 match.
const FL_CITY_REFERENCE_URL = 'https://raw.githubusercontent.com/seanpianka/Zipcodes/427e664995b5e0c7d44eab740ea5a46cb12f7581/scripts/data/zip_code_database.csv';
let floridaCitiesCache = null;
let floridaCitiesPending = null;
function parseZipCityCsv(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 7 * 1024 * 1024) throw Error('Florida ZIP reference was empty or exceeded its size limit.');
  const rows=[]; let row=[],cell='',quoted=false,start=true;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (quoted) {
      if(c==='"' && text[i+1]==='"'){cell+='"';i++;}
      else if(c==='"')quoted=false;
      else cell+=c;
    } else if(c==='"' && start){quoted=true;start=false;}
    else if(c===','){row.push(cell);rowStart();}
    else if(c==='\n' || c==='\r'){
      if(c==='\r' && text[i+1]==='\n')i++;
      row.push(cell);if(row.length>1)rows.push(row);row=[];cell='';start=true;
    } else {cell+=c;start=false;}
  }
  if(quoted)throw Error('Invalid ZIP reference CSV: unterminated quoted value.');
  if(cell || row.length){row.push(cell);if(row.length>1)rows.push(row);}
  if(!rows.length)throw Error('Florida ZIP reference had no rows.');
  const head=rows.shift().map(x=>x.trim().toLowerCase().replace(/^\ufeff/,''));
  const names=['zip','state','primary_city','acceptable_cities','unacceptable_cities'];
  const inds=Object.fromEntries(names.map(name=>[name,head.indexOf(name)]));
  if(names.some(name=>inds[name]<0))throw Error('Florida ZIP reference schema changed: could not identify mailing-city fields.');
  const retired=head.indexOf('decommissioned'),type=head.indexOf('type');
  const out=[];let seen=new Set();
  for(const fields of rows){
    const zip=(fields[inds.zip]||'').trim(),state=(fields[inds.state]||'').trim().toUpperCase();
    if(state!=='FL' || !/^\d{5}$/.test(zip) || (retired>=0 && /^(1|true)$/i.test((fields[retired]||'').trim())))continue;
    const city=(fields[inds.primary_city]||'').trim();
    if(!city || city.length>100 || seen.has(zip))continue;
    const valid=(fields[inds.acceptable_cities]||'').split(',').map(s=>s.trim()).filter(s=>s.length && s.length<=100);
    // The unacceptable_cities column must never be surfaced as allowed alternatives.
    const unacceptable=new Set((fields[inds.unacceptable_cities]||'').split(',').map(s=>s.trim().toLowerCase()));
    const alternatives=[...new Set(valid)].filter(s=>s.toLowerCase()!==city.toLowerCase()&&!unacceptable.has(s.toLowerCase()));
    out.push({zip,city,state:'FL',alternatecity:alternatives.join('|'),source:'florida-zip-reference',zipType:type>=0?String(fields[type]||''):''});
    seen.add(zip);
  }
  if(out.length<100)throw Error('Florida ZIP reference did not contain the expected active ZIP records.');
  return out;
  function rowStart(){cell='';start=true;}
}
async function loadFloridaZipCities(fetchImpl=global.fetch){
  if(fetchImpl===global.fetch && floridaCitiesCache)return floridaCitiesCache;
  if(fetchImpl===global.fetch && floridaCitiesPending)return floridaCitiesPending;
  const task=(async()=>{
    const r=await fetchImpl(FL_CITY_REFERENCE_URL,{redirect:'error',headers:{accept:'text/csv,text/plain'},signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Error('Florida ZIP data unavailable (HTTP '+r.status+'). You can still import an official accepted-city table.');
    const ct=String(r.headers?.get?.('content-type')||'');
    if(/text\/html/i.test(ct))throw Error('Florida ZIP data returned an HTML page instead of a ZIP table.');
    if(Number(r.headers?.get?.('content-length'))>7*1024*1024)throw Error('Florida ZIP reference was unexpectedly large.');
    const rows=parseZipCityCsv(await r.text());
    return {source:'UnitedStatesZIPCodes Florida ZIP/city reference (pinned open-source mirror)',url:'https://www.unitedstateszipcodes.org/fl/',rows,count:rows.length,
      warning:'ZIP and accepted city names only. This is NOT a ZIP+4 or delivery-point verification.'};
  })();
  if(fetchImpl!==global.fetch)return task;
  floridaCitiesPending=task;
  try{return floridaCitiesCache=await task;}
  finally{floridaCitiesPending=null;}
}

module.exports={validateConfig,isAddress,cloudflare,lookupZip,lookupUsps,lookupSmarty,loadFloridaZipCities,parseZipCityCsv,FL_CITY_REFERENCE_URL,allowedRemoteHost,validateRemoteUrl,importRemoteFile,dnsMailCheck};
