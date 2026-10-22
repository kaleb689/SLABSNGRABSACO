import crypto from "node:crypto";
import {createNotificationDeliveryGuard} from "./notification-delivery-guard.js";

// Shipment notifications are keyed to a verified order and one distinct stage.
// Changes to ETA, scanner timestamps and email formatting must not resend a
// SHIPPED DM; only a later IN TRANSIT/OUT FOR DELIVERY/DELIVERED stage qualifies.
const stages=new Set(["shipped","in_transit","out_for_delivery","delivered"]);
export function shippingDiscordDmKey({accountId,discordUserId,retailer,orderNumber,status}={}){
 const recipient=String(discordUserId||"").trim();
 const a=String(accountId||"").trim(),r=String(retailer||"").trim().toLowerCase();
 const o=String(orderNumber||"").trim().toLowerCase();
 const stage=String(status||"").trim().toLowerCase();
 if(!/^\d{17,22}$/.test(recipient)||!a||!r||!o||!stages.has(stage))return null;
 return crypto.createHash("sha256").update(JSON.stringify([a,r,o,stage])).digest("hex");
}
export function createShippingDiscordDmLedger({dataDir,guard=createNotificationDeliveryGuard({dataDir})}={}){
 return {claim:details=>{
   const event=shippingDiscordDmKey(details);
   if(!event)return Promise.resolve({send:false,reason:"invalid_shipping_notification"});
   return guard.claim({channel:"discord:shipping",recipient:details.discordUserId,eventKey:event});
 }};
}
