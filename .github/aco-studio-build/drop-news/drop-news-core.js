'use strict';
const retailers={target:'Target',walmart:'Walmart',pokemoncenter:'Pokémon Center',costco:'Costco',sams:'Sam’s Club'};
const domains={target:['target.com'],walmart:['walmart.com'],pokemoncenter:['pokemoncenter.com','pokemon.com'],costco:['costco.com'],sams:['samsclub.com']};
function publicUrl(value){
 try{const u=new URL(value);const h=u.hostname.toLowerCase();
 if(u.protocol!=='https:'||u.username||u.password||u.port||!h.includes('.')||/^[\d.]+$/.test(h)||h.includes(':')||/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(h))return null;
 return u.href;}catch{return null;}
}
function officialUrl(value,retailer){const url=publicUrl(value);if(!url)return false;const h=new URL(url).hostname;return (domains[retailer]||[]).some(d=>h===d||h.endsWith('.'+d));}
const str=(v,max=3000)=>typeof v==='string'?v.trim().slice(0,max):'';
const array=(v,max)=>Array.isArray(v)?v.slice(0,max):[];
const iso=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
function validateFeed(raw){
 if(raw?.schema!==1||!iso(raw.publishedAt)||!Array.isArray(raw.retailers))throw Error('Drop News feed format is unavailable.');
 if(Date.parse(raw.publishedAt)>Date.now()+86400000)throw Error('Drop News publication date is invalid.');
 const ids=raw.retailers.map(x=>x?.id);if(ids.length!==5||new Set(ids).size!==5||ids.some(id=>!Object.hasOwn(retailers,id)))throw Error('Drop News retailer coverage is incomplete.');
 const entries=(list,retailer,rumor=false)=>array(list,30).map(item=>{
  const sources=array(item?.sources,10).map(s=>({title:str(s?.title,200),url:publicUrl(s?.url),checkedAt:iso(s?.checkedAt)})).filter(s=>s.url&&s.checkedAt);
  if(!sources.length||!str(item?.title))throw Error('Drop News entry is missing checked sources.');
  if(!rumor&&!sources.some(s=>officialUrl(s.url,retailer)))throw Error('Confirmed Drop News requires a retailer official source.');
  return {title:str(item.title,220),kind:rumor?'rumor':['drop','rule_change','policy_baseline','listing'].includes(item.kind)?item.kind:'listing',productName:str(item.productName,220),sku:str(item.sku,120),dropAt:str(item.dropAt,200),details:str(item.details),planningImpact:str(item.planningImpact),checks:array(item.checks,12).map(x=>str(x,500)),sources};
 });
 return {schema:1,publishedAt:iso(raw.publishedAt),summary:str(raw.summary),retailers:raw.retailers.map(r=>({id:r.id,name:retailers[r.id],coverage:str(r.coverage),confirmed:entries(r.confirmed,r.id),checks:array(r.checks,12).map(x=>str(x,500))})),rumors:array(raw.rumors,30).map(r=>{if(!Object.hasOwn(retailers,r.retailer))throw Error('Unknown rumor retailer.');return {retailer:r.retailer,...entries([r],r.retailer,true)[0]};})};
}
// Latest Monday at 08:00 in New York, accounting for DST without host timezone assumptions.
function mondayEditionDue(now=new Date()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
 const date=new Date(Date.UTC(+parts.year,+parts.month-1,+parts.day));const days=(date.getUTCDay()+6)%7;
 date.setUTCDate(date.getUTCDate()-days-(days===0&&+parts.hour<8?7:0));
 // 08:00 is always safely after the DST transition, which occurs on Sundays.
 const offset=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'}).formatToParts(new Date(date.getTime()+16*3600000)).find(p=>p.type==='timeZoneName').value.replace('GMT',''));
 return date.getTime()+(8-offset)*3600000;
}
function staleFeed(feed,now=new Date()){return !feed||Date.parse(feed.publishedAt)<mondayEditionDue(now);}
module.exports={retailers,publicUrl,officialUrl,validateFeed,mondayEditionDue,staleFeed};
