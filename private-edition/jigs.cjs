"use strict";
const crypto=require("node:crypto");
const {changeRow,findField,aliases}=require("./formats.cjs");
const choose=list=>list[crypto.randomInt(list.length)];
const randomName=()=>choose(["Alex","Jordan","Taylor","Morgan","Casey","Riley","Quinn","Avery","Cameron","Reese"])+" "+choose(["Parker","Hayes","Ellis","Reed","Brooks","Morgan","Lane","Blake","Wells","Bell"]);
const suffixes={street:["St","Street"],road:["Rd","Road"],avenue:["Ave","Avenue"],drive:["Dr","Drive"],lane:["Ln","Lane"],boulevard:["Blvd","Boulevard"],court:["Ct","Court"],terrace:["Ter","Terrace"],circle:["Cir","Circle"],parkway:["Pkwy","Parkway"],trail:["Trl","Trail"],highway:["Hwy","Highway"],place:["Pl","Place"],way:["Wy","Way"]};
const defaults=()=>({suffix:true,directional:true,ordinal:true,doubleLetter:false,fraction:false,hyphen:false,randomUnit:false,phone:false,name:false});
function jigAddress(address,options={}){
  let str=String(address||"");if(!str)return str;
  if(options.directional)str=str.replace(/\b(?:Northwest|Northeast|Southwest|Southeast|North|South|East|West|NW|NE|SW|SE|N|S|E|W)\b/i,
    value=>({NW:"Northwest",NE:"Northeast",SW:"Southwest",SE:"Southeast",N:"North",S:"South",E:"East",W:"West",Northwest:"NW",Northeast:"NE",Southwest:"SW",Southeast:"SE",North:"N",South:"S",East:"E",West:"W"})[value]||value);
  if(options.suffix)for(const variants of Object.values(suffixes)){
    const trimmed=str.replace(/\.$/,"");const word=trimmed.split(/\s+/).at(-1);
    if(variants.some(v=>v.toLowerCase()===word.toLowerCase())){str=trimmed.slice(0,-word.length)+(word.toLowerCase()===variants[0].toLowerCase()?variants[1]:variants[0]);break;}
  }
  if(options.ordinal)str=str.replace(/\b(\d+)(?:st|nd|rd|th)\b/i,"$1");
  if(options.doubleLetter)str=str.replace(/(\b[A-Za-z]{4,})/,word=>word.slice(0,2)+word[2]+word.slice(2));
  if(options.fraction)str=str.replace(/^(\d+)/,match=>match+" "+choose(["1/2","1/3","1/4"]));
  if(options.hyphen)str=str.replace(/^(\d+)/,match=>match+"-"+choose(["A","B","C","D","E","F","G","H"]));
  return str;
}
function jigProfile(source,rowIndex,options={}){
  const row=source.rows[rowIndex];if(!row)throw Error("Profile unavailable.");
  const addressKey=findField(row,aliases.address),unitKey=findField(row,aliases.unit),phoneKey=findField(row,aliases.phone);
  const before={...(row||{})},changes={};
  if(addressKey)changes.address=jigAddress(row[addressKey],options);
  if(options.randomUnit&&unitKey&&!String(row[unitKey]||"").trim()&&!/\b(?:apt|unit|suite|ste|#|condo)\b/i.test(String(row[addressKey]||"")))
    changes.unit="Unit "+crypto.randomInt(101,999);
  if(options.phone&&phoneKey){
    const digits=String(row[phoneKey]||"").replace(/\D/g,"");
    if(digits.length===10)changes.phone=digits.slice(0,3)+String(crypto.randomInt(1000000,10000000)).padStart(7,"0");
  }
  if(options.name){const [first,last]=randomName().split(" ");changes.name=first;changes.last=last;}
  const count=changeRow(source,rowIndex,changes);
  return {count,before,after:{...source.rows[rowIndex]}};
}
module.exports={jigProfile,jigAddress,defaults,randomName};
