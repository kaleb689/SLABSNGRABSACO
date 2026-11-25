// Read-only formatter for staff-pasted retailer monitoring posts.
// Parsing never reaches external links or guesses product IDs.
export const FORMATTED_DROP_MARKER = "SLABSNGRABSACO | formatted drop";
const COLOR = 0x38dce8;
const clean = value => String(value || "").replace(/[*_`~]/g, "").trim();
const safe = value => String(value || "").replace(/[\r\n<>@`]/g, " ").trim();
function isNoise(line) {
  // Match exact monitor labels, not prefixes of real product names such as
  // "Apple..." or "Image Comics...".
  return /^(?:walmart draws?|target drops?|pkc drops?|pokemon(?: center)? drops?|costco drops?|sam.?s drops?|poke signals|app|links?|image|seller|type|new product|time|cart limit|pid|sku|ebay|report bugs)$/i.test(line) ||
    /^monitors\b/i.test(line) || /^@/.test(line);
}
function sourceText(input) {
 if(typeof input==="string")return input;
 if(!input||typeof input!=="object")return "";
 return [input.content,
  ...(Array.isArray(input.embeds)?input.embeds:[]).flatMap(embed=>
    [embed.title,embed.description,...(embed.fields||[]).flatMap(field=>[field.name,field.value])])]
   .filter(Boolean).join("\n");
}
function explicitField(lines,start,end,label) {
 const pattern=new RegExp("^(?:"+label+")\\s*(?::|#|-)?\\s*(.*)$","i");
 for(let j=start;j<end;j++){
  const found=pattern.exec(lines[j]);
  if(!found)continue;
  const inline=(found[1]||"").trim();
  if(inline)return inline;
  const next=(lines[j+1]||"").trim();
  if(next&&!/^(?:Price|Type|PID|SKU|TCIN|Time|Cart Limit|Seller|Image|Links?|Monitors?)\b/i.test(next))return next;
 }
 return "";
}
function imageUrl(value){
 try{const url=new URL(String(value||""));return url.protocol==="https:"&&
  /\.(?:png|jpe?g|webp)(?:$|[?#])/i.test(url.pathname+url.search)?url.href:null;}
 catch{return null;}
}
export function parseMonitorDropProducts(input) {
 const lines=sourceText(input).split(/\r?\n/).map(clean).filter(Boolean);
 const products=[],seen=new Set();
 for(let i=1;i<lines.length;i++){
  const label=/^Price\b\s*:?[ \t]*(.*)$/i.exec(lines[i]);
  if(!label)continue;
  const name=lines[i-1];
  if(!name||isNoise(name)||name.length>350)continue;
  const inline=label[1]?.trim()||"";
  const value=inline||lines[i+1]||"";
  const amount=/^\$?\s*([0-9]{1,7}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(?:USD)?$/i.exec(value);
  if(!amount)continue;
  const price=Number(amount[1].replace(/,/g,""));
  if(!Number.isFinite(price)||price<=0||price>1000000)continue;
  const end=(()=>{for(let j=i+1;j<Math.min(lines.length,i+35);j++)
   if(/^Price\b/i.test(lines[j]))return j;return Math.min(lines.length,i+35);})();
  const sku=explicitField(lines,i+1,end,"PID|SKU|TCIN").toUpperCase();
  if(!/^[A-Z0-9][A-Z0-9._-]{2,79}$/.test(sku)||seen.has(sku))continue;
  seen.add(sku);
  const row={name,price:price.toFixed(2),sku};
  const cartLimit=explicitField(lines,i+1,end,"Cart\\s*Limit|Max\\s*Qty|Purchase\\s*Limit");
  if(/^\d{1,3}$/.test(cartLimit))row.cartLimit=Number(cartLimit);
  const seller=explicitField(lines,i+1,end,"Seller");
  if(seller&&seller.length<120)row.seller=seller;
  const type=explicitField(lines,i+1,end,"Type");
  if(type&&type.length<90)row.type=type;
  const time=explicitField(lines,i+1,end,"Time|Draw\\s*Time|Drop\\s*Time");
  if(time&&time.length<110)row.time=time;
  const img=explicitField(lines,i+1,end,"Image|Photo|Product\\s*Image");
  if(imageUrl(img))row.imageUrl=imageUrl(img);
  products.push(row);
 }
 // One unambiguous media image can accompany one product only. Never attach an
 // unrelated monitor image to a different SKU.
 if(products.length===1&&input&&typeof input==="object"){
  const urls=[...(input.attachments||[]).map(x=>x.url),
   ...(input.embeds||[]).flatMap(x=>[x.image?.url,x.thumbnail?.url])];
  const found=urls.map(imageUrl).find(Boolean);
  if(found&&!products[0].imageUrl)products[0].imageUrl=found;
 }
 return products.slice(0,200);
}

// A human announcement such as:
// Product name
// SKU: 1012850572
// Stock: 40k+
// is a valid structured drop without a Price line. Keep the exact posted SKU
// and stock text; a separate verified retailer catalog supplies missing prices.
export function parseSkuStockDropProducts(input) {
 const lines=sourceText(input).split(/\r?\n/).map(clean);
 const products=[],seen=new Set();
 let firstProductAt=-1,stockCount=0;
 const skuLine=/^(?:SKU|PID|TCIN)\s*(?:[:#-]\s*|\s+)([A-Z0-9][A-Z0-9._-]{2,79})$/i;
 const stockLine=/^Stock\s*:\s*([\d,.]+\s*[kKmM]?\+?)$/i;
 const moneyLine=/^(?:Price|Retail|MSRP)\s*:\s*\$?\s*(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)\s*$/i;
 for(let i=1;i<lines.length;i++){
  // Normalize combining accents, then tolerate a stray non-ASCII suffix
  // only after a Target-style numeric ID. Discord's existing selection reader
  // already recognizes that numeric prefix; never invent a different SKU.
  const skuText=lines[i].normalize("NFC");
  let match=skuLine.exec(skuText),hadUnsupportedSuffix=false;
  if(!match){
   match=/^(?:SKU|PID|TCIN)\s*(?:[:#-]\s*|\s+)(\d{7,12})[\u0080-\uFFFF]{1,3}$/u.exec(skuText);
   hadUnsupportedSuffix=Boolean(match);
  }
  if(!match)continue;
  const sku=match[1].toUpperCase();
  if(seen.has(sku))continue;
  let titleAt=i-1;
  while(titleAt>=0&&!lines[titleAt])titleAt--;
  const name=lines[titleAt]||"";
  if(!name||name.length>280||isNoise(name)||
     /^(?:SKU|PID|TCIN|Stock|Price|Retail|MSRP|Resale|Seller|Time|Date|Release|Demand|Cart Limit|Link|https?:\/\/)\s*:/i.test(name)||
     /^https?:\/\//i.test(name)||
     !/[a-z]/i.test(name))continue;
  const row={name,sku};
  if(hadUnsupportedSuffix)row.itemNumberNeedsReview=true;
  for(let j=i+1;j<Math.min(i+4,lines.length);j++){
   const line=lines[j];
   if(skuLine.test(line))break;
   const stock=stockLine.exec(line);
   if(stock&&!row.stock){row.stock=stock[1].replace(/\s+/g,"");stockCount++;}
   const price=moneyLine.exec(line);
   if(price&&!row.price)row.price=Number(price[1].replace(/,/g,"")).toFixed(2);
   if(line&&j>i+1&&!stock&&!price)break;
  }
  if(row.price===undefined){
   for(let j=titleAt+1;j<i;j++){
    const p=moneyLine.exec(lines[j]);
    if(p){row.price=Number(p[1].replace(/,/g,"")).toFixed(2);break;}
   }
  }
  seen.add(sku);
  products.push(row);
  if(firstProductAt<0)firstProductAt=titleAt;
 }
 // Avoid taking precedence over rich Retail/Resale announcements. This path
 // is for inventory-style posts that actually provide stock quantities.
 if(!stockCount)return {products:[],header:""};
 const header=firstProductAt>=0?lines.slice(0,firstProductAt).filter(Boolean).join("\n").slice(0,900):"";
 return {products:products.slice(0,200),header};
}

export function formattedDropName(label) {
  const name = String(label || "Retailer").replace(/\s+Drops?$/i, "").trim();
  if (/walmart/i.test(name)) return "Walmart Draw";
  if (/^pkc$/i.test(name)) return "PKC Drop";
  if (/upcoming/i.test(name)) return "Upcoming Drop";
  if (/in-?store/i.test(name)) return "In-Store Drop";
  if (/tonight/i.test(name)) return "Dropping Tonight";
  return (name || "Retailer") + " Drop";
}
export function formattedDropPayloads(products,label,options={}){
 if(!Array.isArray(products)||!products.length)return [];
 const title=formattedDropName(label);
 const walmart=/walmart/i.test(label);
 const blocks=[];
 for(let start=0;start<products.length;start+=10){
  const block=products.slice(start,start+10),pages=Math.ceil(products.length/10);
  const embeds=block.map((product,index)=>{
   const price=Number(product.price);
   const lines=[
    "**"+safe(product.name)+"**",
    Number.isFinite(price)&&price>0?"Price $"+price.toFixed(2):"Price pending",
    "SKU: "+safe(product.sku).slice(0,80)
   ];
   if(product.stock)lines.push("Stock: "+safe(product.stock).slice(0,70));
   if(product.itemNumberNeedsReview)lines.push("⚠️ Posted item number needs verification");
   if(Number.isInteger(product.cartLimit)&&product.cartLimit>0)lines.push("Cart limit: "+product.cartLimit);
   if(product.type)lines.push("Type: "+safe(product.type).slice(0,80));
   if(product.seller)lines.push("Seller: "+safe(product.seller).slice(0,100));
   // Other retailers intentionally omit release dates/times, including dates
   // copied from a monitoring service. Only Walmart draw times are shown.
   if(walmart&&product.time)lines.push("Draw time: "+safe(product.time).slice(0,110));
   const image=imageUrl(product.imageUrl);
   return {
    ...(index===0?{title:title+(pages>1?" ("+(blocks.length+1)+"/"+pages+")":"")}:{}),
    description:(start===0&&index===0&&options.header
      ? "**Drop details**\n"+safe(options.header).slice(0,900)+"\n\n":"")+lines.join("\n"),color:COLOR,
    ...(image?{thumbnail:{url:image}}:{}),
    footer:{text:FORMATTED_DROP_MARKER}
   };
  });
  // Discord enforces per-embed and aggregate message limits. Preserve the raw paste when it cannot fit.
  if(embeds.some(e=>e.description.length>4096)||embeds.reduce((n,e)=>n+e.description.length+(e.title||"").length+(e.footer?.text||"").length,0)>6000)return [];
  blocks.push({content:"**"+title+"**",embeds,allowed_mentions:{parse:[]}});
 }
 return blocks;
}
export function isFormattedDropPost(message, botId) {
  return Boolean(botId && message?.author?.bot && String(message.author.id) === String(botId) &&
    !message.webhook_id && Array.isArray(message.embeds) &&
    message.embeds.some(embed => embed?.footer?.text === FORMATTED_DROP_MARKER));
}
