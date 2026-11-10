import { mentionedRetailers } from "./retailer-alert-roles.js";

export const TARGET_MASTER_MARKER = "SLABSNGRABSACO | Target SKU Master";
const SEED = [
  ["1012055696","Pokemon TCG: Prismatic Evolutions Super Premium Collection"],
  ["1011206804","Pokemon TCG: Prismatic Evolutions Elite Trainer Box"],
  ["93803457","Pokemon TCG: Prismatic Evolutions Poster Collection"],
  ["93954446","Pokemon TCG: Prismatic Evolutions Booster Bundle"],
  ["94681790","Pokemon TCG: Charizard Ultra-Premium Collection"],
  ["1011209279","Pokemon TCG: First Partner Collection 2"],
  ["1011960739","Pokemon TCG: First Partner Collection 3"],
  ["95082118","Pokemon TCG: Ascended Heroes Elite Trainer Box"],
  ["95093981","Pokemon TCG: Ascended Heroes Poster Collection"],
  ["95093982","Pokemon TCG: Ascended Heroes Gardevoir Poster Collection"],
  ["1007935778","Pokemon TCG: Ascended Heroes Charmander Sticker Collection"],
  ["1011467802","Pokemon TCG: Destined Rivals Elite Trainer Box"],
  ["94681760","Pokemon TCG: Destined Rivals Booster Box"],
  ["95120822","Pokemon TCG: Ascended Heroes Gastly Sticker Collection"],
  ["95120834","Pokemon TCG: Ascended Heroes Booster Bundle"],
  ["95163306","Pokemon TCG: Ascended Heroes Feraligatr ex Box"],
  ["1008581387","Pokemon TCG: Ascended Heroes Emboar ex Box"],
  ["95163305","Pokemon TCG: Ascended Heroes Meganium ex Box"],
  ["94681782","Pokemon TCG: Mega Evolution Booster Bundle"],
  ["94636854","Pokemon TCG: Unova Poster Collection"],
  ["1011701039","Pokemon TCG: Temporal Forces Elite Trainer Box 1"],
  ["91255507","Pokemon TCG: Temporal Forces Elite Trainer Box 2"],
  ["1012055695","Pokemon TCG: Shrouded Fable Booster Bundle"],
  ["1010892076","Pokemon TCG: 30th Celebration Elite Trainer Box"],
  ["1011407490","Pokemon TCG: 30th Celebration Booster Bundle"],
  ["1010892074","Pokemon TCG: 30th Celebration Binder Collection"],
  ["1010892067","Pokemon TCG: 30th Celebration Poster Collection"],
  ["1010892069","Pokemon TCG: 30th Celebration Mini Tin"],
  ["1010892070","Pokemon TCG: 30th Celebration Knockout Box"],
  ["1010892078","Pokemon TCG: 30th Celebration Sticker Collection"],
  ["1010892065","Pokemon TCG: 30th Celebration ex Box #1"],
  ["1010892068","Pokemon TCG: 30th Celebration ex Box #2"],
  ["1009154741","One Piece Card Game Mini Case Set - Luffy/Shanks/Hancock (TS-03), Styles Vary"],
  ["1012422107","Pokemon TCG: 30th Celebration Mini Tin - Styles May Vary"],
  ["1012644665","Pokemon TCG: Mega Evolution - Ascended Heroes Tin - Mega Meganium ex"],
  ["1012644666","Pokemon TCG: Mega Evolution - Ascended Heroes Tin - Mega Feraligatr ex"],
  ["1012644667","Pokemon TCG: Mega Evolution - Ascended Heroes Tin - Mega Emboar ex"],
  ["1012663804","Pokemon TCG: 30th Celebration Ditto Premium Collection"],
  ["1012793603","Pokemon TCG: 30th Celebration Figure Collection - Mew"],
  ["1012850573","Pokemon TCG: 30th Celebration Figure Collection - Mewtwo"],
  ["1012850570","Pokemon TCG: 30th Celebration Ultra-Premium Collection - Day"],
  ["1012850572","Pokemon TCG: 30th Celebration Ultra-Premium Collection - Night"],
  ["1012793604","Pokemon TCG: Mega Evolution - Delta Reign Elite Trainer Box"],
  ["1013166578","Pokemon TCG: Mega Evolution - Delta Reign Booster Bundle"],
  ["1013166573","Pokemon TCG: Mega Evolution - Delta Reign Three-Booster Blister"],
  ["1013166576","Pokemon TCG: Mega Evolution - Delta Reign Booster Display"]
];
export const INITIAL_TARGET_SKUS = Object.freeze(SEED.map(([sku,name])=>Object.freeze({sku,name})));
const skuKey = value=>String(value||"").trim().toUpperCase();
const isSku = value=>/^[A-Z0-9][A-Z0-9._-]{2,79}$/.test(value);
const safeName = value=>String(value||"").replace(/[\r\n<>@*_~|]/g," ").replace(/\s+/g," ").trim().slice(0,180);
const tick = String.fromCharCode(96);
const button = (label,id,disabled=false,style=2)=>({type:2,style,label,custom_id:id,disabled});

export function initialTargetMaster(at=new Date().toISOString()) {
  return {version:1,startedAt:at,updatedAt:at,messageId:null,
    entries:Object.fromEntries(INITIAL_TARGET_SKUS.map(x=>[x.sku,{sku:x.sku,name:x.name,source:"owner-supplied-master",addedAt:at}])),
    removed:{}};
}
export function targetMasterItems(master) {
  return Object.values(master?.entries||{}).filter(x=>isSku(skuKey(x?.sku)))
    .sort((a,b)=>a.sku.localeCompare(b.sku,"en",{numeric:true}));
}
export function targetSkuCandidates(message,products,{directTarget=false,generalDrop=false}={}) {
  if(!directTarget&&!generalDrop)return [];
  if(!directTarget) {
    const text=[message?.content,...(message?.embeds||[]).flatMap(e=>[
      e?.title,e?.description,...(e?.fields||[]).flatMap(f=>[f.name,f.value])
    ])].filter(Boolean).join("\n");
    // In mixed-retailer posts, refuse to assign another store's SKUs to Target.
    const found=mentionedRetailers(text);
    if(found.length!==1||found[0]!=="target")return [];
  }
  const result=new Map();
  for(const row of Array.isArray(products)?products:[]) {
    const sku=skuKey(row?.sku);
    if(!isSku(sku))continue;
    result.set(sku,{sku,name:safeName(row.name)||"Product name pending"});
  }
  return [...result.values()];
}
export function targetMessageTime(message) {
  const date=Date.parse(message?.edited_timestamp||message?.timestamp||"");
  if(Number.isFinite(date))return date;
  const id=String(message?.id||"");
  if(/^\d{17,22}$/.test(id))return Number((BigInt(id)>>22n)+1420070400000n);
  return NaN;
}
export function targetMasterAdd(master,products,source={}) {
  const next=structuredClone(master),added=[];
  next.entries||={}; next.removed||={};
  for(const row of Array.isArray(products)?products:[]) {
    const sku=skuKey(row?.sku);
    if(!isSku(sku)||next.removed[sku]||next.entries[sku])continue;
    next.entries[sku]={sku,name:safeName(row?.name)||"Product name pending",
      source:"discord",sourceChannelId:String(source.channelId||""),
      sourceMessageId:String(source.messageId||""),
      addedAt:source.at||new Date().toISOString()};
    added.push(sku);
  }
  if(added.length)next.updatedAt=new Date().toISOString();
  return {master:next,added};
}
export function targetMasterRemove(master,sku,ownerId="",at=new Date().toISOString()) {
  const key=skuKey(sku);
  if(!isSku(key)||!master?.entries?.[key])return {master,removed:false};
  const next=structuredClone(master),previous=next.entries[key];
  delete next.entries[key];
  next.removed||={};
  next.removed[key]={name:previous.name,removedAt:at,removedBy:String(ownerId)};
  next.updatedAt=at;
  return {master:next,removed:true};
}
export function targetMasterRestore(master,sku,name,ownerId="",at=new Date().toISOString()) {
  const key=skuKey(sku),title=safeName(name);
  if(!isSku(key)||title.length<3)throw Error("Enter a valid Target SKU and product name.");
  const next=structuredClone(master); next.entries||={};next.removed||={};
  const existed=Boolean(next.entries[key]);
  next.entries[key]={sku:key,name:title,source:"owner-manual",
    addedBy:String(ownerId),addedAt:next.entries[key]?.addedAt||at};
  delete next.removed[key];
  next.updatedAt=at;
  return {master:next,created:!existed};
}
export function targetMasterDashboard(master) {
  const items=targetMasterItems(master),preview=items.slice(0,18);
  return {allowed_mentions:{parse:[]},
    embeds:[{title:"Target SKU Master - "+items.length+" products",
      description:(preview.map(x=>tick+x.sku+tick+" - "+safeName(x.name)).join("\n")||"No Target SKUs saved.")+
        (items.length>preview.length?"\n\n+"+(items.length-preview.length)+" more - View Full List for all.":"")+
        "\n\nAuto-adds unique Target SKUs from Target Drops and Target-only Upcoming / Dropping Tonight posts.",
      color:0xe74c3c,footer:{text:TARGET_MASTER_MARKER}}],
    components:[{type:1,components:[button("View Full List","targetmaster:view:0",false,1),
      button("Manage SKUs (owner)","targetmaster:manage:0")]}]};
}
export function targetMasterView(master,page=0) {
  const items=targetMasterItems(master),pages=Math.max(1,Math.ceil(items.length/20));
  const chosen=Math.max(0,Math.min(Number(page)||0,pages-1));
  const shown=items.slice(chosen*20,(chosen+1)*20);
  return {flags:64,allowed_mentions:{parse:[]},
    embeds:[{title:"Target Master - "+items.length+" SKUs - Page "+(chosen+1)+"/"+pages,
      description:shown.map(x=>tick+x.sku+tick+" - "+safeName(x.name)).join("\n")||"No SKUs saved.",
      color:0xe74c3c}],
    components:[{type:1,components:[
      button("Previous","targetmaster:view:"+(chosen-1),chosen===0),
      button("Next","targetmaster:view:"+(chosen+1),chosen===pages-1),
      button("Manage (owner)","targetmaster:manage:"+chosen)
    ]}]};
}
export function targetMasterManage(master,page=0) {
  const items=targetMasterItems(master),pages=Math.max(1,Math.ceil(items.length/25));
  const chosen=Math.max(0,Math.min(Number(page)||0,pages-1));
  const shown=items.slice(chosen*25,(chosen+1)*25),components=[];
  if(shown.length)components.push({type:1,components:[{type:3,custom_id:"targetmaster:choose:"+chosen,
    placeholder:"Choose a Target SKU to remove",min_values:1,max_values:1,
    options:shown.map(x=>({label:(x.sku+" - "+safeName(x.name)).slice(0,100),value:x.sku}))}]});
  components.push({type:1,components:[
    button("Previous","targetmaster:manage:"+(chosen-1),chosen===0),
    button("Next","targetmaster:manage:"+(chosen+1),chosen===pages-1),
    button("Add / Restore SKU","targetmaster:add",false,3)
  ]});
  return {flags:64,allowed_mentions:{parse:[]},components,
    content:"**Manage Target SKU Master** - "+items.length+" products - page "+(chosen+1)+"/"+pages+
      "\nSelect a SKU to remove it. Removed SKUs stay excluded from future scans unless you restore them manually."};
}
