// One-change-per-profile selectable jig catalog; text variants are not USPS validation.
const standard=[
 ["direction.short","Directions","Abbreviate directions (NORTHWEST to NW)"],
 ["direction.long","Directions","Expand directions (NW to NORTHWEST)"],
 ["ordinal.number","Street numbers","87TH to 87 (numeric street name)"],
 ["ordinal.suffix","Street numbers","87 to 87TH (street ordinal)"],
 ["ordinal.word","Street numbers","9TH to NINTH"],
 ...[["LANE","LN"],["AVENUE","AVE"],["STREET","ST"],["DRIVE","DR"],["TERRACE","TER"],["BOULEVARD","BLVD"],["MANOR","MNR"],["CENTER","CTR"]].flatMap(([long,short])=>[
   ["suffix."+short.toLowerCase(),"Street types",long+" to "+short],
   ["suffix."+short.toLowerCase()+".full","Street types",short+" to "+long]
 ]),
 ...[["apt","Apt"],["unit","Unit"],["suite","Suite"],["ste","Ste"],["hash","#"],["condo","Condo"],["number","Number only"]].map(([id,label])=>["unit."+id,"Apartment / unit",label]),
 ["city.plantation","Mailing cities","Plantation / Fort Lauderdale, ZIP 33324"],
 ["city.pompano","Mailing cities","Pompano Beach / Lighthouse Point, ZIP 33064"],
 ["zip.five","ZIP formatting","Use five-digit ZIP instead of ZIP+4"]
];
const experimental=[
 ...["NORTHWAST","NORTHWST","NORTWEST","SOUTHWAST","SOUTWEST"].map(x=>["direction.typo."+x.toLowerCase(),"Directional misspellings",x]),
 ...["LAEN","LAYN","LAYNE","LLANE","AVNUE","AVENU","BOULVARD","BOULIVARD"].map(x=>["street.typo."+x.toLowerCase(),"Street misspellings",x]),
 ...["BROWARDD","CENNTER","SABALL","PALMM"].map(x=>["double."+x.toLowerCase(),"Double letters",x]),
 ["house.fraction","Fractional house number","Add 1/2 after house number"],
 ["unit.building","Multiple unit designators","BLDG with existing unit"],
 ["street.compressed","Compressed street names","Join street and suffix words"],
 ["unit.floor","Floor and apartment","4B to FL 4 APT B (only where applicable)"],
 ["grid.compressed","Compressed grid","N 450 W to N450W (grid only)"],
 ["house.letter","Alphanumeric house number","123 to 123A"],
 ["house.hyphen","Alphanumeric house number","123 to 123-A"]
];
export const ADDRESS_JIG_OPTIONS=Object.freeze([...standard.map(([id,group,label])=>({id,group,label,risk:"standard"})),...experimental.map(([id,group,label])=>({id,group,label,risk:"experimental"}))]);
const clean=x=>String(x??"").replace(/\s+/g," ").trim();
const fields=a=>Object.fromEntries(["address","address2","city","state","zip","country"].map(k=>[k,clean(a?.[k])]));
const directionPairs=[["NORTHWEST","NW"],["SOUTHWEST","SW"],["NORTHEAST","NE"],["SOUTHEAST","SE"],["NORTH","N"],["SOUTH","S"],["EAST","E"],["WEST","W"]];
const suffixPairs=[["LANE","LN"],["AVENUE","AVE"],["STREET","ST"],["DRIVE","DR"],["TERRACE","TER"],["BOULEVARD","BLVD"],["MANOR","MNR"],["CENTER","CTR"]];
function swapToken(text,from,to){const words=text.split(" ");const index=words.findIndex(w=>w.toUpperCase()===from);if(index<0)return text;words[index]=to;return words.join(" ");}
function unitNumber(text){return clean(text).match(/^(?:(?:APT|APARTMENT|UNIT|SUITE|STE|CONDO|#)\s*#?\s*)?([A-Z0-9-]+)$/i)?.[1]||null;}
function streetOrdinal(text,kind){
 const m=text.match(/^(\d+[A-Z0-9/-]*\s+(?:(?:NW|SW|NE|SE|N|S|E|W|NORTHWEST|SOUTHWEST|NORTHEAST|SOUTHEAST|NORTH|SOUTH|EAST|WEST)\s+)?)(\d{1,2})(ST|ND|RD|TH)?(?=\s)/i);
 if(!m)return text;const n=Number(m[2]),has=!!m[3];if(n<1||n>99)return text;
 const suffix=(n%100>=11&&n%100<=13)?"TH":({1:"ST",2:"ND",3:"RD"}[n%10]||"TH");
 const ones=["","FIRST","SECOND","THIRD","FOURTH","FIFTH","SIXTH","SEVENTH","EIGHTH","NINTH"];
 const tensWords={10:"TENTH",20:"TWENTIETH",30:"THIRTIETH",40:"FORTIETH",50:"FIFTIETH",60:"SIXTIETH",70:"SEVENTIETH",80:"EIGHTIETH",90:"NINETIETH"};
 const teens={11:"ELEVENTH",12:"TWELFTH",13:"THIRTEENTH",14:"FOURTEENTH",15:"FIFTEENTH",16:"SIXTEENTH",17:"SEVENTEENTH",18:"EIGHTEENTH",19:"NINETEENTH"};
 const tenRoot={20:"TWENTY",30:"THIRTY",40:"FORTY",50:"FIFTY",60:"SIXTY",70:"SEVENTY",80:"EIGHTY",90:"NINETY"};
 const ord=ones[n]||teens[n]||tensWords[n]||(tenRoot[Math.floor(n/10)*10]&&ones[n%10]?tenRoot[Math.floor(n/10)*10]+"-"+ones[n%10]:"");
 if(kind==="number"&&!has)return text;if(kind==="suffix"&&has)return text;if(kind==="word"&&!has)return text;
 const replacement=kind==="number"?m[2]:kind==="suffix"?m[2]+suffix:ord;
 return replacement?m[1]+replacement+text.slice(m[0].length):text;
}
function apply(base,id){
 const a={...base},street=a.address.toUpperCase(),unit=a.address2.toUpperCase();
 if(id==="direction.short"||id==="direction.long"){
   const m=street.match(/^(\d+[A-Z0-9/-]*\s+)([A-Z]+)(\s+.*)$/);
   if(m){const pair=directionPairs.find(([full,short])=>m[2]===(id==="direction.short"?full:short));if(pair)a.address=m[1]+pair[id==="direction.short"?1:0]+m[3];}
 }else if(id.startsWith("ordinal.")){a.address=streetOrdinal(street,id.slice(8));}
 else if(id.startsWith("suffix.")){const parts=id.split("."),pair=suffixPairs.find(([,short])=>short.toLowerCase()===parts[1]);if(pair){const from=parts[2]==="full"?pair[1]:pair[0],to=parts[2]==="full"?pair[0]:pair[1];const words=street.split(" ");const final=words.length-1;if(words[final]===from){words[final]=to;a.address=words.join(" ");}}}
 else if(id.startsWith("unit.")){const n=unitNumber(unit);if(!n)return null;const labels={apt:"APT",unit:"UNIT",suite:"SUITE",ste:"STE",hash:"#",condo:"CONDO",number:""};const label=labels[id.slice(5)];if(label===undefined)return null;a.address2=(label?label+" ":"")+n;}
 else if(id==="city.plantation"&&a.zip.startsWith("33324")){const c=a.city.toUpperCase();a.city=c==="PLANTATION"?"FORT LAUDERDALE":c==="FORT LAUDERDALE"?"PLANTATION":a.city;}
 else if(id==="city.pompano"&&a.zip.startsWith("33064")){const c=a.city.toUpperCase();a.city=c==="POMPANO BEACH"?"LIGHTHOUSE POINT":c==="LIGHTHOUSE POINT"?"POMPANO BEACH":a.city;}
 else if(id==="zip.five"&&/^\d{5}-\d{4}$/.test(a.zip)){a.zip=a.zip.slice(0,5);}
 else if(id.startsWith("direction.typo.")){
   const to=id.split(".")[2].toUpperCase(),south=to.startsWith("S"),full=south?"SOUTHWEST":"NORTHWEST",short=south?"SW":"NW";
   a.address=street.replace(/^(\d+[A-Z0-9/-]*\s+)([A-Z]+)(\s+.*)$/,(_,h,dir,tail)=>dir===full||dir===short?h+to+tail:street);
 }else if(id.startsWith("street.typo.")){
   const to=id.split(".")[2].toUpperCase(),map={LAEN:"LANE",LAYN:"LANE",LAYNE:"LANE",LLANE:"LANE",AVNUE:"AVENUE",AVENU:"AVENUE",BOULVARD:"BOULEVARD",BOULIVARD:"BOULEVARD"},from=map[to];if(!from)return null;
   const short=suffixPairs.find(x=>x[0]===from)?.[1];a.address=swapToken(street,from,to);if(a.address===street)a.address=swapToken(street,short,to);
 }else if(id.startsWith("double.")){
   const to=id.split(".")[1].toUpperCase(),from={BROWARDD:"BROWARD",CENNTER:"CENTER",SABALL:"SABAL",PALMM:"PALM"}[to];if(!from)return null;a.address=swapToken(street,from,to);
 }else if(id==="house.fraction"){a.address=street.replace(/^(\d+)(?=\s)/,"$1 1/2");}
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
 const active=[...new Set(Array.isArray(ids)?ids:[])].filter(id=>ADDRESS_JIG_OPTIONS.some(x=>x.id===id));
 const seen=new Set(),out=[];
 for(const id of active){const a=apply(base,id);if(!a)continue;const key=JSON.stringify(Object.values(a).map(v=>v.toUpperCase()));if(seen.has(key))continue;seen.add(key);out.push({id,address:a,experimental:ADDRESS_JIG_OPTIONS.find(x=>x.id===id).risk==="experimental"});}
 return out;
}
