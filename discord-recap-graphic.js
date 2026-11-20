// Owner-approved raster is the ONLY permitted background for Discord recap images.
// Never substitute a generic photo or display historic values from the source raster.
import crypto from "node:crypto";
import fs from "node:fs/promises";

export const APPROVED_NAME="SLABSNGRABSACO_Target_Drop_Recap_Final.png";
export const APPROVED_SHA256="a487218985737ee1ed592ab008e804eae71e635f0dd5404e352b02f37915682c";
const MEDIA=new Set(["cdn.discordapp.com","media.discordapp.net","target.scene7.com"]);
const safeUrl=value=>{try{const u=new URL(String(value||""));return u.protocol==="https:"&&MEDIA.has(u.hostname.toLowerCase());}catch{return false;}};
const fingerprint=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const validImage=bytes=>Buffer.isBuffer(bytes)&&bytes.length>10000&&bytes.length<=12*1024*1024&&fingerprint(bytes)===APPROVED_SHA256;
const escape=value=>String(value??"").replace(/[&<>"'\u0000-\u001f]/g," ").replace(/@everyone|@here|<@!?\d+>/gi,"").slice(0,110);
const prices=cents=>"$"+(cents/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const label=retailer=>({all:"ALL RETAILERS",target:"TARGET",walmart:"WALMART",pokemoncenter:"POKÉMON CENTER",costco:"COSTCO",sams:"SAM'S CLUB"})[retailer];
export async function approvedTemplate({filePath="",channelIds=[],api=null,request=fetch}={}){
  if(filePath)try{const b=await fs.readFile(filePath);if(validImage(b))return b;}catch(e){if(e.code!=="ENOENT")throw e;}
  for(const id of channelIds){
    if(!api||!/^[0-9]{17,22}$/.test(String(id)))continue;
    let before="";
    for(let page=0;page<8;page++){
      const messages=await api("/channels/"+id+"/messages?limit=100"+(before?"&before="+before:""));
      if(!Array.isArray(messages))throw Error("Approved recap image search failed.");
      for(const msg of messages)for(const a of msg.attachments||[]){
        if(a.filename!==APPROVED_NAME||!safeUrl(a.url)||Number(a.size)>12*1024*1024)continue;
        const resp=await request(a.url,{signal:AbortSignal.timeout(15000)});
        if(!resp.ok)continue;
        const b=Buffer.from(await resp.arrayBuffer());
        if(validImage(b))return b;
      }
      if(messages.length<100)break;
      before=String(messages.at(-1)?.id||"");
      if(!/^[0-9]{17,22}$/.test(before))break;
    }
  }
  throw Error("Exact owner-approved recap PNG not found. No graphic was posted.");
}
function overlay(report,retailer,visibility={}){
  const placed=Number(report.ordersPlaced)||0,cancelled=Number(report.deduplicatedCancelledOrders)||0;
  const rate=placed>0?Math.round(1000*Math.max(0,placed-cancelled)/placed)/10:0;
  const date=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",month:"short",day:"numeric",year:"numeric"}).format(new Date(report.periodStart));
  const mask=(x,y,w,h,o=1)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#071827" fill-opacity="${o}"/>`;
  const text=(value,x,y,size,color="#fff")=>`<text x="${x}" y="${y}" font-size="${size}" font-family="Arial,DejaVu Sans,sans-serif" font-weight="900" fill="${color}" stroke="#071524" stroke-width="2" paint-order="stroke">${escape(value)}</text>`;
  let svg='<svg xmlns="http://www.w3.org/2000/svg" width="1672" height="941" viewBox="0 0 1672 941">';
  svg+=mask(1234,25,410,114)+`<rect x="1239" y="28" width="399" height="107" rx="10" fill="none" stroke="#08def5" stroke-width="6"/>`;
  svg+=text(label(retailer)+" DROP",1265,76,retailer==="pokemoncenter"?35:47)+text(date.toUpperCase(),1290,124,31);
  svg+=mask(93,207,472,91)+text(prices(report.totalSpentCents),97,283,78,"#09ef27");
  svg+=mask(736,191,197,90)+text("+"+report.totalUnits,744,253,70,"#00d9ff");
  for(const [visible,x,w,value] of [
    [visibility.showPlacedOrders!==false,64,254,String(placed)],
    [visibility.showCancelled!==false,341,255,String(cancelled)],
    [visibility.showStickRate!==false,619,251,rate.toFixed(1)+"%"]
  ]){
    if(!visible)svg+=mask(x,341,w,108);
    else svg+=mask(x+68,347,w-84,53)+text(value,x+78,390,45);
  }
  svg+=mask(93,513,1460,286);
  for(const [i,p] of (report.topProducts||[]).slice(0,4).entries()){
    const y=548+i*65;
    if(i)svg+=`<line x1="97" y1="${y-32}" x2="1540" y2="${y-32}" stroke="#b8cfe7" stroke-opacity=".65" stroke-width="2"/>`;
    svg+=`<rect x="94" y="${y-20}" width="45" height="47" rx="10" fill="#113b59" stroke="#39bce6" stroke-width="2"/>`;
    const name=escape(p.name||"Product not identified");
    svg+=text(i+1,106,y+13,28)+text(name.length>94?name.slice(0,91)+"…":name,232,y+2,name.length>68?24:name.length>45?28:34);
    svg+=text("Qty: "+Math.max(0,Number(p.quantity)||0),232,y+29,25);
  }
  return Buffer.from(svg+"</svg>");
}
async function sourceImage(url,request,sharp){
  if(!safeUrl(url))return null;
  try{
    const resp=await request(url,{signal:AbortSignal.timeout(8000)});
    if(!resp.ok||!/^image\//i.test(resp.headers.get("content-type")||""))return null;
    const b=Buffer.from(await resp.arrayBuffer());
    if(b.length>4*1024*1024)return null;
    return sharp(b).resize(55,55,{fit:"contain",background:"#ffffff"}).png().toBuffer();
  }catch{return null;}
}
export async function renderRecapGraphic({template,report,retailer,visibility={},request=fetch,sharpModule=null}){
  if(!validImage(template))throw Error("Approved recap template did not match locked image hash.");
  if(!label(retailer)||!report?.readyToPublish||!Number.isSafeInteger(report.totalSpentCents)||report.totalSpentCents<0||
     !Number.isSafeInteger(report.totalUnits)||report.totalUnits<0||
     !Number.isFinite(Date.parse(report.periodStart)))
    throw Error("Incomplete or unverified Discord recap cannot be rendered.");
  const sharp=sharpModule||(await import("sharp")).default;
  const layers=[{input:overlay(report,retailer,visibility),left:0,top:0}];
  for(const [i,p] of (report.topProducts||[]).slice(0,4).entries()){
    const input=await sourceImage(p.imageUrl,request,sharp);
    if(input)layers.push({input,left:162,top:525+i*65});
  }
  return sharp(template).composite(layers).png().toBuffer();
}
