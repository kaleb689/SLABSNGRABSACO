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
  const placed=Number(report.ordersPlaced)||0;
  const cancelled=Number(report.deduplicatedCancelledOrders)||0;
  const rate=placed>0?Math.round(1000*Math.max(0,placed-cancelled)/placed)/10:0;
  const date=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",
    month:"short",day:"numeric",year:"numeric"}).format(new Date(report.periodStart));
  // Preserve the owner's approved artwork and translucent metric frames.
  // Only cover the previous values, headings that must change, and old
  // product rows. Never overlay an opaque replacement dashboard.
  const patch=(x,y,w,h,opacity=.92)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#061b2b" fill-opacity="${opacity}"/>`;
  const text=(value,x,y,size,color="#fff")=>`<text x="${x}" y="${y}" font-size="${size}" font-family="Arial,DejaVu Sans,sans-serif" font-weight="900" fill="${color}" stroke="#041726" stroke-width="2.5" paint-order="stroke">${escape(value)}</text>`;
  let svg='<svg xmlns="http://www.w3.org/2000/svg" width="1672" height="941" viewBox="0 0 1672 941">';
  if(retailer!=="target"){
    svg+=patch(1313,28,300,56,.98);
    svg+=text(label(retailer)+" DROP",1320,76,retailer==="pokemoncenter"?28:37);
  }
  svg+=patch(1316,90,264,38,1)+text(date.toUpperCase(),1320,120,30);
  svg+=patch(96,205,459,93,1)+text(prices(report.totalSpentCents),100,282,73,"#05eb29");
  svg+=patch(755,197,180,69,1)+text("+"+report.totalUnits,759,253,66,"#00d9ff");
  for(const item of [
    {visible:visibility.showPlacedOrders!==false,x:65,width:252,text:String(placed),textX:142},
    {visible:visibility.showCancelled!==false,x:342,width:253,text:String(cancelled),textX:417},
    {visible:visibility.showStickRate!==false,x:619,width:254,text:rate.toFixed(1)+"%",textX:695}
  ]){
    if(!item.visible){
      svg+=patch(item.x+2,344,item.width-4,102,1);
    }else{
      svg+=patch(item.textX-3,350,item.width-104,49,1);
      svg+=text(item.text,item.textX,392,43);
    }
  }
  const products=(report.topProducts||[]).slice(0,4);
  for(let i=0;i<4;i++){
    const y=521+i*67;
    // Row-only translucent patches protect the outer frame and title.
    svg+=patch(88,y,1468,66,1);
    if(i>0)svg+=`<line x1="92" x2="1545" y1="${y-1}" y2="${y-1}" stroke="#6da3b8" stroke-width="2" stroke-opacity=".8"/>`;
    const product=products[i];
    if(!product)continue;
    const name=escape(product.name||"Product not identified");
    svg+=`<rect x="94" y="${y+5}" width="48" height="49" rx="9" fill="#06304a" stroke="#17b3eb" stroke-width="2"/>`;
    svg+=text(i+1,108,y+40,30);
    svg+=text(name.length>86?name.slice(0,83)+"…":name,236,y+29,
      name.length>70?24:name.length>48?27:31);
    svg+=text("Qty: "+Math.max(0,Number(product.quantity)||0),236,y+56,24);
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
