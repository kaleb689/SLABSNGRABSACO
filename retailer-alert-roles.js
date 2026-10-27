// One registry for Discord self-assigned roles and customer-app drop filtering.
// A Discord click opts into a retailer, not into OS-level phone permission.
export const RETAILER_ALERTS = Object.freeze([
  Object.freeze({ key: "target", name: "Target", role: "Target Drop Alerts", emoji: "🎯" }),
  Object.freeze({ key: "walmart", name: "Walmart", role: "Walmart Drop Alerts", emoji: "🛒" }),
  Object.freeze({ key: "pokemoncenter", name: "Pokémon Center", role: "Pokémon Center Drop Alerts", emoji: "⚡" }),
  Object.freeze({ key: "costco", name: "Costco", role: "Costco Drop Alerts", emoji: "📦" }),
  Object.freeze({ key: "sams", name: "Sam's Club", role: "Sam's Club Drop Alerts", emoji: "⭐" })
]);
export const RETAILER_ALERT_KEYS = Object.freeze(RETAILER_ALERTS.map(item => item.key));
export const retailerAlert = key => RETAILER_ALERTS.find(item => item.key === key) || null;
export function retailerFromDropLabel(label) {
  const name=String(label||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  if(name.includes("pokemoncenter")||name.includes("pkc"))return "pokemoncenter";
  if(name.includes("target"))return "target";
  if(name.includes("walmart"))return "walmart";
  if(name.includes("costco"))return "costco";
  if(name.includes("sams")||name.includes("samsclub"))return "sams";
  return null;
}
export function mentionedRetailers(message) {
  const text=String(message||"").toLowerCase();
  return RETAILER_ALERTS.filter(item=>
    item.key==="pokemoncenter"?/pokemon\s*center|\bpkc\b/.test(text):
    item.key==="sams"?/sam['’]?s(?:\s+club)?/.test(text):
    new RegExp("\\b"+item.key+"\\b","i").test(text)
  ).map(item=>item.key);
}
export function retailerAlertButtons() {
  return [{type:1,components:RETAILER_ALERTS.map(spec=>({
    type:2,style:2,label:spec.name,custom_id:"retailer:role:"+spec.key,
    emoji:{name:spec.emoji}
  }))}];
}
export function receivesRetailerAlert(selected,retailer) {
  const keys=Array.isArray(retailer)?retailer:[retailer];
  return keys.some(key=>RETAILER_ALERT_KEYS.includes(key)&&selected?.[key]===true);
}
