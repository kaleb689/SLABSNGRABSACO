// Owner-approved rasters are the ONLY permitted backgrounds for Discord recap images.
// Never substitute a generic photo or display historic values from the source raster.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const APPROVED_NAME="SLABSNGRABSACO_Target_Drop_Recap_Final.png";
export const APPROVED_SHA256="71ad40b06e3b5b53f42ef9c680a5f4396191be7f79127aeb86ce2b7998ebdef4";
const MEDIA=new Set(["cdn.discordapp.com","media.discordapp.net","target.scene7.com"]);
const safeUrl=value=>{try{const u=new URL(String(value||""));return u.protocol==="https:"&&MEDIA.has(u.hostname.toLowerCase());}catch{return false;}};
const fingerprint=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const validImage=bytes=>Buffer.isBuffer(bytes)&&bytes.length>10000&&bytes.length<=12*1024*1024&&fingerprint(bytes)===APPROVED_SHA256;
const escape=value=>String(value??"").replace(/[&<>"'\u0000-\u001f]/g," ").replace(/@everyone|@here|<@!?\d+>/gi,"").slice(0,110);
const prices=cents=>"$"+(cents/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const label=retailer=>({all:"ALL RETAILERS",target:"TARGET",walmart:"WALMART",pokemoncenter:"POKÉMON CENTER",costco:"COSTCO",sams:"SAM'S CLUB"})[retailer];
export async function approvedTemplate({filePath="",channelIds=[],api=null,request=fetch,cachePath=""}={}){
  for(const candidate of [new URL("./assets/Neon Target Drop Recap Template.png",import.meta.url),cachePath,filePath].filter(Boolean))try{const b=await fs.readFile(candidate);if(validImage(b))return b;}catch(e){if(e.code!=="ENOENT")throw e;}
  for(const id of channelIds){
    if(!api||!/^[0-9]{17,22}$/.test(String(id)))continue;
    let before="";
    for(let page=0;page<8;page++){
      const messages=await api("/channels/"+id+"/messages?limit=100"+(before?"&before="+before:""));
      if(!Array.isArray(messages))throw Error("Approved recap image search failed.");
      for(const msg of messages){
        const attachments=(msg.attachments||[]).filter(a=>
          safeUrl(a?.url)&&Number(a?.size)>10000&&
          Number(a?.size)<=12*1024*1024&&
          (a.filename===APPROVED_NAME||
            /\.png$/i.test(String(a.filename||""))));
        // Discord can rename an uploaded attachment. Exact image hash—not
        // its display filename—is the acceptance requirement.
        for(const a of attachments){
          try {
            const resp=await request(a.url,{signal:AbortSignal.timeout(10000)});
            if(!resp.ok){console.warn("Recap asset download HTTP",resp.status);continue;}
            const b=Buffer.from(await resp.arrayBuffer());
            if(validImage(b)){
              if(cachePath)try{await fs.mkdir(path.dirname(cachePath),{recursive:true});await fs.writeFile(cachePath,b,{mode:0o600});}catch(e){console.warn("Recap asset cache:",e.code||e.name);}
              console.info("Clean recap template checksum verified");
              return b;
            }
            console.info("Recap asset checksum mismatch",{bytes:b.length,sha256:fingerprint(b)});
          }catch(e){console.warn("Recap asset download failed",e.name);}
        }
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
  const txt=(value,x,y,size,color="#fff",weight=800)=>
    '<text x="'+x+'" y="'+y+'" font-size="'+size+'" font-family="Arial,DejaVu Sans,sans-serif" font-weight="'+weight+'" fill="'+color+'">'+escape(value)+'</text>';
  const glass=(x,y,w,h,rx=11)=>
    '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+rx+'" fill="#061b2b" fill-opacity="1" stroke="#338fb8" stroke-opacity=".38" stroke-width="1.5"/>';
  // The clean approved image already contains the headings and empty panels.
  let svg='<svg xmlns="http://www.w3.org/2000/svg" width="1672" height="941" viewBox="0 0 1672 941">';
  svg+='<defs><linearGradient id="clean" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#071d32"/><stop offset="1" stop-color="#02111f"/></linearGradient><linearGradient id="metric" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#061b2b"/><stop offset=".92" stop-color="#061b2b" stop-opacity="1"/><stop offset="1" stop-color="#061b2b" stop-opacity="1"/></linearGradient></defs>';
  if(retailer!=="target"){
    svg+=glass(1263,20,352,113,9);
    svg+=txt(label(retailer)+" DROP",1287,70,retailer==="pokemoncenter"?28:34);
  }
  svg+=txt(date.toUpperCase(),1320,126,29,"#ffffff",900);
    svg+=txt(prices(report.totalSpentCents),101,312,67,"#00f73c",900);
    svg+=txt("+"+report.totalUnits,755,312,64,"#00d7ff",900);

  const metrics=[
    {enabled:visibility.showPlacedOrders!==false,label:"PLACED ORDERS",value:String(placed),color:"#54c7ff"},
    {enabled:visibility.showCancelled!==false,label:"CANCELLED",value:String(cancelled),color:"#ff7187"},
    {enabled:visibility.showStickRate!==false,label:"STICK RATE",value:rate.toFixed(1)+"%",color:"#35ed6f"}
  ].filter(x=>x.enabled);
  // Draw optional metrics only when enabled; never draw a placeholder.
  if(metrics.length){
    const dy=0;
    svg+=`<g transform="translate(0 ${dy})">`;
    svg+='<rect x="63" y="371" width="814" height="94" rx="16" fill="url(#metric)" stroke="#36b5e6" stroke-opacity=".4" stroke-width="2"/>';
    const gap=14,width=(784-gap*(metrics.length-1))/metrics.length;
    metrics.forEach((m,i)=>{
      const x=79+i*(width+gap);
      if(i)svg+='<line x1="'+(x-8)+'" y1="380" x2="'+(x-8)+'" y2="454" stroke="#2bbce7" stroke-opacity=".45"/>';
      svg+=txt(m.value,x+10,411,38,m.color,900);
      svg+=txt(m.label,x+10,444,20,"#f0f8fd",800);
    });
    svg+="</g>";
  }
  // Use the existing top-products panel; no historic product rows exist.
  (report.topProducts||[]).slice(0,4).forEach((p,i)=>{
    const y=550+i*69;
    if(i)svg+='<line x1="98" y1="'+(y-4)+'" x2="1554" y2="'+(y-4)+'" stroke="#72bfd6" stroke-opacity=".35"/>';
    svg+='<rect x="96" y="'+(y+5)+'" width="44" height="46" rx="8" fill="#07314b" stroke="#18baff" stroke-width="1.7"/>';
    svg+=txt(String(i+1),107,y+39,27,"#eafaff");
    const name=escape(p.name||"Product not identified");
    svg+=txt(name.length>92?name.slice(0,89)+"…":name,233,y+28,
      name.length>70?22:name.length>49?25:29,"#f7fbff",800);
    svg+=txt("Qty: "+(Number(p.quantity)||0),233,y+55,22,"#91d9f1",700);
  });
  return Buffer.from(svg+"</svg>");
}
async function sourceImage(url,request,sharp){
  if(!safeUrl(url))return null;
  try{
    const resp=await request(url,{signal:AbortSignal.timeout(8000)});
    if(!resp.ok||!/^image\//i.test(resp.headers.get("content-type")||""))return null;
    const b=Buffer.from(await resp.arrayBuffer());
    if(b.length>4*1024*1024)return null;
    return await sharp(b).resize(56,56,{fit:"contain",background:"#ffffff"}).png().toBuffer();
  }catch{return null;}
}
export async function renderRecapGraphic({template,report,retailer,visibility={},request=fetch,sharpModule=null}){
  if(!validImage(template))throw Error("Approved recap template did not match locked image hash.");
  if(!label(retailer)||!report?.readyToPublish||!Number.isSafeInteger(report.totalSpentCents)||report.totalSpentCents<0||
     !Number.isSafeInteger(report.totalUnits)||report.totalUnits<0||
     !Number.isFinite(Date.parse(report.periodStart)))
    throw Error("Incomplete or unverified Discord recap cannot be rendered.");
  const sharp=sharpModule||(await import("sharp")).default;
  // Dynamic contents are rebuilt cleanly, without blurring the approved image.
  const layers=[{input:overlay(report,retailer,visibility),left:0,top:0}];
  for(const [i,p] of (report.topProducts||[]).slice(0,4).entries()){
    const input=await sourceImage(p.imageUrl,request,sharp);
    if(input)layers.push({input,left:162,top:555+i*69});
  }
  return sharp(template).composite(layers).png({compressionLevel:9,palette:true,quality:100}).toBuffer();
}
