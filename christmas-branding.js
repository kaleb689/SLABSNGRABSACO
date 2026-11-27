// Christmas 2026: preserve the original artwork; decorate around its silhouette.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const ORIGINAL=path.join(ROOT,"public","slabsngrabs-aco-logo-transparent.png");
const SEASONAL=path.join(ROOT,"public","slabsngrabs-aco-christmas-2026.png");
export function christmasActive(date=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{
    timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(date).map(x=>[x.type,x.value]));
  const key=parts.year+"-"+parts.month+"-"+parts.day;
  return key>="2026-11-27"&&key<"2027-01-01";
}
const palette=["#ff464f","#58ee89","#ffd16b","#f7faff"];
function lightsSvg(){
  const bulbs=Array.from({length:28},(_,i)=>{
    const angle=-Math.PI/2+2*Math.PI*i/28;
    const x=512+453*Math.cos(angle),y=512+447*Math.sin(angle);
    const color=palette[i%palette.length],rotation=angle*180/Math.PI+90;
    return '<g transform="translate('+x.toFixed(1)+' '+y.toFixed(1)+') rotate('+rotation.toFixed(1)+')"><ellipse cy="9" rx="16" ry="22" fill="'+color+'" opacity=".42" filter="url(#glow)"/><rect x="-6" y="-7" width="12" height="11" rx="3" fill="#133b2a"/><ellipse cy="10" rx="8.5" ry="13.5" fill="'+color+'" stroke="#fff" stroke-opacity=".55" stroke-width="1.5"/><ellipse cx="-2.5" cy="5" rx="2" ry="4" fill="#fff" opacity=".8"/></g>';
  }).join("");
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><filter id="glow"><feGaussianBlur stdDeviation="8"/></filter><linearGradient id="wire" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ac2438"/><stop offset=".5" stop-color="#e1434e"/><stop offset="1" stop-color="#159b56"/></linearGradient></defs><ellipse cx="512" cy="512" rx="453" ry="447" fill="none" stroke="#0b301e" stroke-width="10"/><ellipse cx="512" cy="512" rx="453" ry="447" fill="none" stroke="url(#wire)" stroke-width="3"/>'+bulbs+'</svg>');
}
let logoWork;
export function prepareChristmasLogo(){
  if(!logoWork)logoWork=(async()=>{
    // The original PNG stays untouched. All holiday art is behind the original,
    // so its lettering, card art, sports card, and typography are not redrawn.
    const {data:original,info}=await sharp(ORIGINAL).ensureAlpha()
      .trim({background:"#00000000",threshold:2})
      .resize({width:875,height:875,fit:"inside"}).png().toBuffer({resolveWithObject:true});
    const {data:raw,info:ri}=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const halo=Buffer.alloc(raw.length);
    for(let y=0;y<ri.height;y++)for(let x=0;x<ri.width;x++){
      const p=(y*ri.width+x)*4,t=x/Math.max(1,ri.width-1);
      halo[p]=Math.round(21+216*t);halo[p+1]=Math.round(159-112*t);
      halo[p+2]=Math.round(80-19*t);halo[p+3]=raw[p+3];
    }
    const edge=await sharp(halo,{raw:{width:ri.width,height:ri.height,channels:4}})
      .resize({width:ri.width+24,height:ri.height+24,fit:"fill"}).blur(4).png().toBuffer();
    const png=await sharp({create:{width:1024,height:1024,channels:4,background:"#00000000"}})
      .composite([{input:lightsSvg()},{input:edge,gravity:"centre"},{input:original,gravity:"centre"}])
      .png().toBuffer();
    const temp=SEASONAL+".tmp";
    await fs.writeFile(temp,png);await fs.rename(temp,SEASONAL);
    return png;
  })().catch(error=>{logoWork=undefined;throw error;});
  return logoWork;
}
async function makeBanner(logo){
  const bg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><defs><linearGradient id="bg"><stop stop-color="#071d16"/><stop offset=".5" stop-color="#071018"/><stop offset="1" stop-color="#350c15"/></linearGradient></defs><path fill="url(#bg)" d="M0 0H960V540H0Z"/><path d="M0 25Q120 75 240 25T480 25T720 25T960 25" fill="none" stroke="#33644c" stroke-width="3"/>'+Array.from({length:32},(_,i)=>'<circle cx="'+(15+i*30)+'" cy="'+(45+14*Math.sin(i*Math.PI/4))+'" r="5" fill="'+palette[i%4]+'"/>').join("")+'<path d="M0 513H960" stroke="#9e3041" stroke-width="3"/></svg>');
  const art=await sharp(logo).resize(470,470).png().toBuffer();
  return sharp(bg).composite([{input:art,left:245,top:35}]).png().toBuffer();
}
const uri=buffer=>"data:image/png;base64,"+buffer.toString("base64");
async function backupGuildArt(guildId,field,hash){
  if(!hash)return null;
  if(!/^[a-zA-Z0-9_]+$/.test(hash))throw Error("Unexpected Discord artwork hash");
  const kind=field==="icon"?"icons":"banners", ext=hash.startsWith("a_")?"gif":"png";
  const response=await fetch("https://cdn.discordapp.com/"+kind+"/"+guildId+"/"+hash+"."+ext+"?size="+(field==="icon"?512:1024),{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error("Cannot back up existing Discord "+field);
  const buffer=Buffer.from(await response.arrayBuffer());
  if(!buffer.length||buffer.length>8*1024*1024)throw Error("Unexpected Discord artwork size");
  return "data:image/"+ext+";base64,"+buffer.toString("base64");
}
async function saveMarker(file,state){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=file+".tmp";await fs.writeFile(temp,JSON.stringify(state),{mode:0o600});await fs.rename(temp,file);
}
export async function syncDiscordChristmasBranding({api,guildId,dataDir,date=new Date()}){
  if(typeof api!=="function"||!/^\d{17,22}$/.test(String(guildId||""))||!dataDir)return;
  const marker=path.join(dataDir,"discord-christmas-2026-"+guildId+".json");
  let state={fields:{}};
  try{state=JSON.parse(await fs.readFile(marker,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;}
  const active=christmasActive(date);
  if(!active&&!Object.keys(state.fields).length)return;
  let guild=await api("/guilds/"+guildId);
  if(active){
    const logo=await prepareChristmasLogo();
    for(const field of ["icon","banner"]){
      if(field==="banner"&&!guild.features?.includes("BANNER"))continue;
      const existing=state.fields[field];
      if(existing?.applied||existing?.restored||existing?.pending&&guild[field]!==existing.before)continue;
      try{
        const backup=existing?existing.backup:await backupGuildArt(guildId,field,guild[field]||null);
        const entry=existing||{before:guild[field]||null,backup,pending:true};
        state.fields[field]=entry;await saveMarker(marker,state);
        const artwork=field==="icon"?await sharp(logo).resize(512,512).png().toBuffer():await makeBanner(logo);
        const updated=await api("/guilds/"+guildId,"PATCH",{[field]:uri(artwork)});
        if(!updated?.[field])throw Error("Discord did not confirm seasonal "+field);
        entry.applied=updated[field];entry.pending=false;await saveMarker(marker,state);
        guild=updated;
        console.log("Christmas Discord "+field+": updated");
      }catch(e){console.error("Christmas Discord "+field+":",e?.message||"unavailable");}
    }
  }else{
    for(const [field,entry] of Object.entries(state.fields)){
      if(!entry.applied||entry.restored)continue;
      if(guild[field]!==entry.applied){entry.restored="skipped-manual-change";await saveMarker(marker,state);continue;}
      try{
        guild=await api("/guilds/"+guildId,"PATCH",{[field]:entry.backup});
        entry.restored=true;await saveMarker(marker,state);
        console.log("Christmas Discord "+field+": restored");
      }catch(e){console.error("Christmas Discord restoration "+field+":",e?.message||"unavailable");}
    }
  }
}
