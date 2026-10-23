// One-change-per-profile selectable jig catalog; text variants are not USPS validation.
const standard=[
 ["direction.short","Directions","Abbreviate directions (NORTHWEST to NW)"],
 ["direction.long","Directions","Expand directions (NW to NORTHWEST)"],
 ["ordinal.number","Street numbers","Remove ordinal suffix from a numbered street"],
 ["ordinal.suffix","Street numbers","Use the correct ordinal suffix for a numbered street"],
 ["ordinal.word","Street numbers","Spell out the numbered street ordinal"],
 ["ordinal.cardinal","Street numbers","Spell out the numbered street cardinal"],
 ["ordinal.spaced","Street numbers","Separate the ordinal suffix from a numbered street"],
 ["suffix.matching","Street types","Switch the actual street suffix to its equivalent spelling (St/Street, Rd/Road, etc.)"],
 ...[["apt","Apt"],["unit","Unit"],["suite","Suite"],["ste","Ste"],["apartment","Apartment"],["hash","#"],["hashcompact","Number sign without spacing"],["apthash","Apartment label with number sign"],["condo","Condo"],["number","Number only"]].map(([id,label])=>["unit."+id,"Apartment / unit",label]),
 ["city.alternate","Mailing cities","Use an alternate USPS-matched mailing city for this address"],
 ["zip.five","ZIP formatting","Use five-digit ZIP instead of ZIP+4"],
 ["zip.four","ZIP formatting","Lookup and use address-verified ZIP+4"]
];
// Experimental address formats are opt-in, not USPS-verified, and may not deliver.
// Misspellings and double-letter jigs were explicitly removed from this set.
const experimental=[
 ["house.fraction","Fractional house number","Add 1/2 after house number"],
 ["unit.random","Apartment / unit","Add a random Apt, Ste, Unit, # or other numbered second line when no unit exists"],
 ["unit.building","Multiple unit designators","BLDG with existing unit"],
 ["street.compressed","Compressed street names","Join street and suffix words"],
 ["unit.floor","Floor and apartment","Use a floor and apartment designation where applicable"],
 ["grid.compressed","Compressed grid","Compress directional street grid (grid streets only)"],
 ["house.letter","Alphanumeric house number","Add letter to house number (experimental)"],
 ["house.hyphen","Alphanumeric house number","Add hyphenated letter to house number (experimental)"]
];
export const ADDRESS_JIG_OPTIONS=Object.freeze([...standard.map(([id,group,label])=>({id,group,label,risk:"standard"})),...experimental.map(([id,group,label])=>({id,group,label,risk:"experimental"}))]);
const clean=x=>String(x??"").replace(/\s+/g," ").trim();
const fields=a=>Object.fromEntries(["address","address2","city","state","zip","country"].map(k=>[k,clean(a?.[k])]));
const directionPairs=[["NORTHWEST","NW"],["SOUTHWEST","SW"],["NORTHEAST","NE"],["SOUTHEAST","SE"],["NORTH","N"],["SOUTH","S"],["EAST","E"],["WEST","W"]];
const suffixPairs=[["LANE","LN"],["AVENUE","AVE"],["STREET","ST"],["ROAD","RD"],["DRIVE","DR"],["TERRACE","TER"],["BOULEVARD","BLVD"],["COURT","CT"],["CIRCLE","CIR"],["PARKWAY","PKWY"],["TRAIL","TRL"],["HIGHWAY","HWY"],["PLACE","PL"],["WAY","WY"],["ALLEY","ALY"],["SQUARE","SQ"],["MANOR","MNR"],["CENTER","CTR"]];
function swapToken(text,from,to){const words=text.split(" ");const index=words.findIndex(w=>w.toUpperCase()===from);if(index<0)return text;words[index]=to;return words.join(" ");}
function unitNumber(text){return clean(text).match(/^(?:(?:APT|APARTMENT|UNIT|SUITE|STE|CONDO|#)\s*#?\s*)?([A-Z0-9-]+)$/i)?.[1]||null;}
function streetOrdinal(text,kind){
 const m=text.match(/^(\d+[A-Z0-9/-]*\s+(?:(?:NW|SW|NE|SE|N|S|E|W|NORTHWEST|SOUTHWEST|NORTHEAST|SOUTHEAST|NORTH|SOUTH|EAST|WEST)\s+)?)(\d{1,3})(ST|ND|RD|TH)?(?=\s)/i);
 if(!m)return text;const n=Number(m[2]),has=!!m[3];if(n<1||n>999)return text;
 if(n>99 && (kind==="word" || kind==="cardinal"))return text;
 const suffix=(n%100>=11&&n%100<=13)?"TH":({1:"ST",2:"ND",3:"RD"}[n%10]||"TH");
 const ones=["","FIRST","SECOND","THIRD","FOURTH","FIFTH","SIXTH","SEVENTH","EIGHTH","NINTH"];
 const tensWords={10:"TENTH",20:"TWENTIETH",30:"THIRTIETH",40:"FORTIETH",50:"FIFTIETH",60:"SIXTIETH",70:"SEVENTIETH",80:"EIGHTIETH",90:"NINETIETH"};
 const teens={11:"ELEVENTH",12:"TWELFTH",13:"THIRTEENTH",14:"FOURTEENTH",15:"FIFTEENTH",16:"SIXTEENTH",17:"SEVENTEENTH",18:"EIGHTEENTH",19:"NINETEENTH"};
 const tenRoot={20:"TWENTY",30:"THIRTY",40:"FORTY",50:"FIFTY",60:"SIXTY",70:"SEVENTY",80:"EIGHTY",90:"NINETY"};
 const ord=ones[n]||teens[n]||tensWords[n]||(tenRoot[Math.floor(n/10)*10]&&ones[n%10]?tenRoot[Math.floor(n/10)*10]+"-"+ones[n%10]:"");
 const cardinalOnes=["","ONE","TWO","THREE","FOUR","FIVE","SIX","SEVEN","EIGHT","NINE"];
 const cardinalTeens={10:"TEN",11:"ELEVEN",12:"TWELVE",13:"THIRTEEN",14:"FOURTEEN",15:"FIFTEEN",16:"SIXTEEN",17:"SEVENTEEN",18:"EIGHTEEN",19:"NINETEEN"};
 const cardinalTens={20:"TWENTY",30:"THIRTY",40:"FORTY",50:"FIFTY",60:"SIXTY",70:"SEVENTY",80:"EIGHTY",90:"NINETY"};
 const cardinal=cardinalOnes[n]||cardinalTeens[n]||cardinalTens[n]||
   (tenRoot[Math.floor(n/10)*10]&&cardinalOnes[n%10]?tenRoot[Math.floor(n/10)*10]+"-"+cardinalOnes[n%10]:"");
 if(kind==="number"&&!has)return text;if(kind==="suffix"&&has)return text;if(["word","cardinal","spaced"].includes(kind)&&!has)return text;
 const replacement=kind==="number"?m[2]:kind==="suffix"?m[2]+suffix:kind==="word"?ord:
   kind==="cardinal"?cardinal:kind==="spaced"?m[2]+" "+m[3]:null;
 return replacement?m[1]+replacement+text.slice(m[0].length):text;
}
function apply(base,id){
 const a={...base},street=a.address.toUpperCase(),unit=a.address2.toUpperCase();
 if(id==="direction.short"||id==="direction.long"){
   const m=street.match(/^(\d+[A-Z0-9/-]*\s+)([A-Z]+)(\s+.*)$/);
   if(m){const pair=directionPairs.find(([full,short])=>m[2]===(id==="direction.short"?full:short));if(pair)a.address=m[1]+pair[id==="direction.short"?1:0]+m[3];}
 }else if(id.startsWith("ordinal.")){a.address=streetOrdinal(street,id.slice(8));}
 else if(id==="suffix.matching"){
   const words=street.trim().split(/\s+/),last=words.length-1;
   const position=/^(N|S|E|W|NW|NE|SW|SE|NORTH|SOUTH|EAST|WEST|NORTHWEST|NORTHEAST|SOUTHWEST|SOUTHEAST)$/.test(words[last])?last-1:last;
   const token=(words[position]||"").replace(/\.$/,"");
   const pair=suffixPairs.find(([full,short])=>token===full||token===short);
   if(pair){words[position]=token===pair[0]?pair[1]:pair[0];a.address=words.join(" ");}
 }
 else if(id==="unit.random"){
   if(unit || /(?:\s|,)(?:APT|APARTMENT|UNIT|SUITE|STE|CONDO|ROOM|RM|#)\s*#?\s*[A-Z0-9-]+\s*$/i.test(street))return null;
   const labels=["APT","STE","UNIT","#","SUITE","APARTMENT","CONDO","RM"];
   const label=labels[Math.floor(Math.random()*labels.length)];
   a.address2=label+" "+String(100+Math.floor(Math.random()*900));
 }else if(id.startsWith("unit.")){const n=unitNumber(unit);if(!n)return null;const labels={apt:"APT",unit:"UNIT",suite:"SUITE",ste:"STE",apartment:"APARTMENT",hash:"#",hashcompact:"#",apthash:"APT #",condo:"CONDO",number:""};const kind=id.slice(5),label=labels[kind];if(label===undefined)return null;a.address2=(label?label+(kind==="hashcompact"?"":" "):"")+n;}
 else if(id==="zip.five"&&/^\d{5}-\d{4}$/.test(a.zip)){a.zip=a.zip.slice(0,5);}
 else if(id==="zip.four"){return null; /* Never fabricate ZIP+4; retain verified source as-is. */}
else if(id==="house.fraction"){a.address=street.replace(/^(\d+)(?=\s)/,"$1 1/2");}
 else if(id==="unit.building"&&unit){a.address2="BLDG "+unit;}
 else if(id==="street.compressed"){a.address=street.replace(/(\b[A-Z0-9-]+)\s+([A-Z]{2,})$/,"$1$2");}
 else if(id==="unit.floor"){const m=unitNumber(unit)?.match(/^(\d+)([A-Z])$/);if(m)a.address2="FL "+m[1]+" APT "+m[2];}
 else if(id==="grid.compressed"){a.address=street.replace(/^(\d+\s+)([NS])\s+(\d+)\s+([EW])\b/,"$1$2$3$4");}
 else if(id==="house.letter"){a.address=street.replace(/^(\d+)(?=\s)/,"$1A");}
 else if(id==="house.hyphen"){a.address=street.replace(/^(\d+)(?=\s)/,"$1-A");}
 const key=x=>JSON.stringify(Object.values(x).map(v=>v.toUpperCase()));
 return key(a)!==key(base)?a:null;
}
export function eligibleJigSelections(original,ids=[]){
 const base=fields(original);if(!base.address)return [];
 const active=[...new Set((Array.isArray(ids)?ids:[]).map(id=>/^suffix\./.test(id)?"suffix.matching":id))].filter(id=>ADDRESS_JIG_OPTIONS.some(x=>x.id===id));
 const seen=new Set(),out=[];
 for(const id of active){const a=apply(base,id);if(!a)continue;const key=JSON.stringify(Object.values(a).map(v=>v.toUpperCase()));if(seen.has(key))continue;seen.add(key);out.push({id,address:a,experimental:ADDRESS_JIG_OPTIONS.find(x=>x.id===id).risk==="experimental"});}
 return out;
}


/*
 * Rotate individually selected formats across main addresses. Each address
 * still receives at most four alternatives; untouched originals are not
 * included in this list.
 */
export function rotatedJigSelections(original, selectedIds=[], mainAddressIndex=0, limit=4) {
  const candidates=eligibleJigSelections(original,selectedIds);
  if(!candidates.length)return [];
  const categoryById=new Map(ADDRESS_JIG_OPTIONS.map(option=>[option.id,option.group]));
  const grouped=new Map();
  for(const candidate of candidates){
    const category=categoryById.get(candidate.id)||"Other";
    if(!grouped.has(category))grouped.set(category,[]);
    grouped.get(category).push(candidate);
  }
  const columns=[...grouped.values()];
  const interleaved=[];
  for(let index=0;columns.some(group=>index<group.length);index++){
    for(const group of columns)if(index<group.length)interleaved.push(group[index]);
  }
  const position=Math.max(0,Math.floor(Number(mainAddressIndex)||0));
  const shift=(position*4)%interleaved.length;
  const rotated=[...interleaved.slice(shift),...interleaved.slice(0,shift)];
  const count=Math.max(0,Math.floor(Number(limit)||0));
  return rotated.slice(0,count);
}
