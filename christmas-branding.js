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
const ART_VERSION="christmas-2026-v2";
const palette=["#ff464f","#58ee89","#ffd16b","#f7faff"];
function lightsSvg(){
  // Keep all ornaments outside the two card faces and the original lettering.
  // The broad draped string, corner sprigs and snow accents surround the original emblem.
  const points=[[86,126],[155,91],[228,65],[306,48],[391,40],[477,40],[558,40],[642,44],[723,59],[800,82],[872,118],[928,176],[958,251],[976,334],[980,418],[981,504],[979,590],[965,675],[932,754],[885,821],[822,876],[745,920],[662,946],[576,962],[488,970],[401,963],[315,949],[235,922],[159,879],[99,821],[59,754],[36,675],[26,590],[24,504],[28,418],[40,334],[60,250],[75,184]];
  const bulbs=points.map(([x,y],i)=>{
    const a=Math.atan2(y-512,x-512)*180/Math.PI-90,c=palette[i%palette.length];
    return '<g transform="translate('+x+' '+y+') rotate('+a.toFixed(1)+')"><ellipse cy="11" rx="19" ry="25" fill="'+c+'" opacity=".55" filter="url(#glow)"/><rect x="-7" y="-7" width="14" height="13" rx="3" fill="#294d2f"/><ellipse cy="12" rx="10" ry="16" fill="'+c+'" stroke="#fff" stroke-opacity=".75" stroke-width="1.4"/><ellipse cx="-3" cy="7" rx="3" ry="5" fill="#fff" opacity=".8"/></g>';
  }).join("");
  const wire=points.map(([x,y],i)=>(i?"L":"M")+x+" "+y).join(" ")+"Z";
  const snow=Array.from({length:42},(_,i)=>{
    const a=i*2.399963,x=512+Math.cos(a)*(468+(i%4)*8),y=512+Math.sin(a)*(450+(i%5)*8);
    return '<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="'+(i%3+1.6)+'" fill="#fff" opacity="'+(.34+(i%4)*.12)+'"/>';
  }).join("");
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><filter id="glow"><feGaussianBlur stdDeviation="9"/></filter><radialGradient id="h"><stop stop-color="#174b2c" stop-opacity=".20"/><stop offset="1" stop-color="#10221b" stop-opacity="0"/></radialGradient></defs><ellipse cx="512" cy="512" rx="475" ry="465" fill="url(#h)"/><path d="'+wire+'" fill="none" stroke="#0b271b" stroke-width="8" stroke-linejoin="round"/><path d="'+wire+'" fill="none" stroke="#5b7953" stroke-width="2.5" stroke-linejoin="round"/>'+snow+bulbs+'</svg>');
}
let logoWork;
export function prepareChristmasLogo(){
  if(!logoWork)logoWork=(async()=>{
    // The original PNG stays untouched. Use its real pixels rather than redrawing
    // either graded card or the lettering. Recolor only blue trim outside protected card zones.
    const {data:original,info}=await sharp(ORIGINAL).ensureAlpha()
      .trim({background:"#00000000",threshold:2})
      .resize({width:875,height:875,fit:"inside"}).png().toBuffer({resolveWithObject:true});
    const {data:raw,info:ri}=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const halo=Buffer.alloc(raw.length);
    const decorated=Buffer.from(raw);
    for(let y=0;y<ri.height;y++)for(let x=0;x<ri.width;x++){
      const p=(y*ri.width+x)*4,t=x/Math.max(1,ri.width-1);
      halo[p]=Math.round(21+216*t);halo[p+1]=Math.round(159-112*t);
      halo[p+2]=Math.round(80-19*t);halo[p+3]=raw[p+3];
      const u=x/Math.max(1,ri.width-1),v=y/Math.max(1,ri.height-1);
      // Protect Charizard and Josh Allen in the upper center and the lower hand/card art.
      // All grayscale lettering stays pixel-identical; only saturated cyan trim is recolored.
      const cardZone=(v<.47&&u>.14&&u<.86)||(v>.68&&u>.20&&u<.80);
      const r=raw[p],g=raw[p+1],b=raw[p+2];
      if(!cardZone&&raw[p+3]>0&&b-r>45&&g-r>28&&b>85&&b>=g*.87){
        const brightness=Math.max(r,g,b)/255;
        const red=(u+v*.28)>.61;
        const colors=red?[255,63,76]:[64,222,118];
        for(let c=0;c<3;c++)decorated[p+c]=Math.min(255,Math.round(colors[c]*brightness*.92+Math.min(r,g,b)*.12));
      }
    }
    const edge=await sharp(halo,{raw:{width:ri.width,height:ri.height,channels:4}})
      .resize({width:ri.width+24,height:ri.height+24,fit:"fill"}).blur(4).png().toBuffer();
    const colored=await sharp(decorated,{raw:{width:ri.width,height:ri.height,channels:4}}).png().toBuffer();
    const png=await sharp({create:{width:1024,height:1024,channels:4,background:"#00000000"}})
      .composite([{input:lightsSvg()},{input:edge,gravity:"centre"},{input:colored,gravity:"centre"}])
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
      if(existing?.restored)continue;
      // Upgrade the already-applied v1 image exactly once, retaining its original
      // pre-Christmas backup. Never overwrite an unrelated manual change.
      if(existing?.applied){
        if(existing.artVersion===ART_VERSION)continue;
        if(guild[field]!==existing.applied)continue;
      }else if(existing?.pending&&guild[field]!==existing.before)continue;
      try{
        const backup=existing?existing.backup:await backupGuildArt(guildId,field,guild[field]||null);
        const entry=existing||{before:guild[field]||null,backup,pending:true};
        state.fields[field]=entry;await saveMarker(marker,state);
        const artwork=field==="icon"?await sharp(logo).resize(512,512).png().toBuffer():await makeBanner(logo);
        const updated=await api("/guilds/"+guildId,"PATCH",{[field]:uri(artwork)});
        if(!updated?.[field])throw Error("Discord did not confirm seasonal "+field);
        entry.applied=updated[field];entry.artVersion=ART_VERSION;entry.pending=false;await saveMarker(marker,state);
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
