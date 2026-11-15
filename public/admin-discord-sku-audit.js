// Admin-only Discord SKU selection history. No customer-side route or data access.
const search=document.getElementById("discordSkuAuditSearch");
const from=document.getElementById("discordSkuAuditFrom");
const to=document.getElementById("discordSkuAuditTo");
const button=document.getElementById("loadDiscordSkuAudit");
const more=document.getElementById("moreDiscordSkuAudit");
const status=document.getElementById("discordSkuAuditStatus");
const output=document.getElementById("discordSkuAuditLog");
let offset=0, total=0, rows=[],loading=false;
const element=(tag,className,text)=>{
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=String(text);
  return node;
};
const localTime=timestamp=>{
  const time=Date.parse(timestamp||"");
  return Number.isFinite(time)
    ? new Date(time).toLocaleString(undefined,{year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})
    : "Date unavailable";
};
const firstName=record=>String(record.customerName||"").trim() ||
  (record.customerAccountId ? "Customer "+record.customerAccountId : "Unmatched Discord user");
const groupName=event=>String(event.retailer||"Other").toUpperCase();
const actionName=action=>({
  select:"Selected",increase:"Increased quantity",decrease:"Decreased quantity",
  deselect:"Removed",run_all:"Run all",opt_out:"Opted out"
})[action] || "Changed";
function render(){
  output.replaceChildren();
  if(!rows.length){
    output.append(element("p","admin-sku-empty","No recorded Discord SKU changes match these filters. Old choices are not backfilled."));
    return;
  }
  const accounts=new Map();
  for(const record of rows){
    const key=String(record.customerAccountId||"unmatched:"+record.discordUserId);
    if(!accounts.has(key))accounts.set(key,[]);
    accounts.get(key).push(record);
  }
  for(const records of accounts.values()){
    const customer=records[0],folder=element("details","admin-sku-folder");
    const heading=element("summary","",firstName(customer)+" · "+records.length+" saved interaction"+(records.length===1?"":"s"));
    folder.append(heading);
    const meta=element("p","admin-sku-meta",
      (customer.email||"No current email")+" · Discord: "+(customer.discordDisplayName||customer.discordUserId||"Unknown")+
      " · "+(customer.attribution==="verified_linked_discord_id"?"Verified linked ID":"Unmatched / needs reconciliation"));
    folder.append(meta);
    const dateGroups=new Map();
    for(const record of records){
      const when=String(record.recordedAt||"").slice(0,10);
      for(const event of record.events||[]){
        const key=when+"|"+groupName(event);
        if(!dateGroups.has(key))dateGroups.set(key,[]);
        dateGroups.get(key).push({record,event});
      }
    }
    for(const [key,changes] of dateGroups){
      const group=element("details","admin-sku-drop-group");
      const parts=key.split("|");
      group.append(element("summary","",parts[0]+" · "+parts[1]+" · "+changes.length+" change"+(changes.length===1?"":"s")));
      for(const {record,event} of changes){
        const change=element("article","admin-sku-change");
        change.append(element("strong","",actionName(event.action)+
          (event.sku?" · "+event.sku:"")));
        change.append(element("span","",String(event.productName||"Drop-level action")));
        change.append(element("small","",
          "Qty "+Number(event.beforeQuantity||0)+" → "+Number(event.afterQuantity||0)+
          " · "+localTime(record.recordedAt)+
          " · Channel "+(event.channelId||record.interactionChannelId||"unknown")));
        group.append(change);
      }
      folder.append(group);
    }
    output.append(folder);
  }
}
async function load(append=false){
  if(loading)return;
  loading=true;button.disabled=true;more.disabled=true;
  if(!append){offset=0;rows=[];status.textContent="Loading Discord SKU history…";}
  try{
    const params=new URLSearchParams({limit:"40",offset:String(offset),
      search:search.value.trim(),from:from.value,to:to.value});
    const response=await fetch("/api/admin/discord-sku-selection-logs?"+params.toString(),
      {credentials:"same-origin",cache:"no-store"});
    const data=await response.json();
    if(!response.ok||data.ok!==true)throw Error(data.error||"Unable to retrieve SKU history.");
    const next=Array.isArray(data.entries)?data.entries:[];
    rows.push(...next);offset+=next.length;total=Number(data.total)||0;
    status.textContent=total+" recorded interaction"+(total===1?"":"s")+
      " · Most recent first · Time shown locally";
    more.hidden=offset>=total;render();
  }catch(error){
    status.textContent=error.message||"Could not load Discord SKU history.";
  }finally{loading=false;button.disabled=false;more.disabled=false;}
}
button?.addEventListener("click",()=>void load(false));
search?.addEventListener("keydown",event=>{
  if(event.key==="Enter"){event.preventDefault();void load(false);}
});
more?.addEventListener("click",()=>void load(true));
