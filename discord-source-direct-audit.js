/**
 * Temporary READ-ONLY verification of the SlabsNGrabsTC Discord Success channel.
 * Do not post messages, store payloads, emit order numbers, or access website ledgers.
 * Uses only the bot's existing Discord read credentials in server process memory.
 */
import { checkoutStatusFromDiscord, checkoutIdentityFromDiscord } from "./discord-checkout-identity.js";
import { isModuleLifecycleDiscordMessage } from "./discord-checkout-event-policy.js";
import { checkoutExplicitPaidTotal } from "./checkout-price-policy.js";
import { communityProductKey, communityProductName } from "./community-product-identity.js";

const MARK = "DIRECT_DISCORD_SLABSNGRABSTC_AUDIT_20261113";
const GUILD_KEY = "slabsngrabstc";
const DAY_START = Date.parse("2026-11-13T05:00:00.000Z");
const DAY_END = Date.parse("2026-11-14T05:00:00.000Z");
const DROP_START = Date.parse("2026-11-13T08:00:00.000Z");
const DROP_END = Date.parse("2026-11-13T13:00:00.000Z");
const MAX_PAGES = 45;

const normalize = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const snowflakeAt = t => ((BigInt(Math.floor(t)) - 1420070400000n) << 22n).toString();
const cents = value => Number.isFinite(Number(value)) && Number(value) > 0
  ? Math.round(Number(value) * 100) : null;
const addCount = (obj, key, by=1) => { obj[key] = (obj[key] || 0) + by; };
const safeProduct = n => {
  const s = communityProductName(n).trim();
  if (!s || s.length > 170 || /@|\b(?:password|account|address|phone|order\s*(?:id|number)|security code|email|login)\b/i.test(s)) return "";
  return s;
};
const safeDomain = raw => {
  try { const u = new URL(String(raw || "")); return u.protocol === "https:" ? u.hostname.slice(0, 80) : ""; }
  catch { return ""; }
};

async function getDiscord(token, route) {
  for (let retry = 0; retry < 5; retry++) {
    const r = await fetch("https://discord.com/api/v10" + route, {
      headers: { Authorization: "Bot " + token },
      signal: AbortSignal.timeout(18000)
    });
    if (r.status === 429) {
      const data = await r.json().catch(() => ({}));
      await new Promise(resolve => setTimeout(resolve,
        Math.max(500, Math.min(6000, (Number(data.retry_after) || .8) * 1000 + 250))));
      continue;
    }
    if (!r.ok) throw new Error("Discord HTTP " + r.status + " on read-only route");
    return r.json();
  }
  throw new Error("Discord rate limit did not resolve");
}

async function getMessages(token, channelId, oldestMillis) {
  const gathered = [];
  let before = snowflakeAt(Date.now() + 60000);
  let pages = 0, earliest = null, crossed = false;
  for (; pages < MAX_PAGES; pages++) {
    const result = await getDiscord(token, "/channels/" + channelId + "/messages?limit=100&before=" + before);
    if (!Array.isArray(result) || !result.length) { crossed = true; break; }
    let earliestInPage = Infinity;
    for (const m of result) {
      const t = Date.parse(m.timestamp || "");
      if (!Number.isFinite(t)) continue;
      earliestInPage = Math.min(earliestInPage, t);
      if (t >= oldestMillis) gathered.push(m);
    }
    earliest = Number.isFinite(earliestInPage) ? new Date(earliestInPage).toISOString() : earliest;
    if (earliestInPage < oldestMillis) { crossed = true; pages++; break; }
    before = result[result.length - 1].id;
    if (result.length < 100) { crossed = true; pages++; break; }
  }
  return { messages: gathered, pages, complete: crossed, earliestFetched: earliest };
}

function summarize(messages, bounds, parseCheckout) {
  const { from, to, name } = bounds;
  const timeEligible = messages.filter(m => {
    const at = Date.parse(m?.timestamp || "");
    return Number.isFinite(at) && at >= from && at < to;
  });
  const colorCounts = {}, parsedCounts = {}, missingParse = {}, sourceRetailers = {},
    messageAuthorTypes = {}, imageHosts = {}, hourCounts = {};
  const parsedEvents = [];
  let missingOrderNumber = 0, moduleLifecycle = 0;
  for (const m of messages) {
    const timestamp = Date.parse(m.timestamp || "");
    if (!Number.isFinite(timestamp) || timestamp < from) continue;
    if (isModuleLifecycleDiscordMessage(m)) { if (timestamp < to) moduleLifecycle++; continue; }
    const status = checkoutStatusFromDiscord(m) || "unknown";
    const raw = parseCheckout(m);
    if (timestamp < to) {
      addCount(colorCounts, status);
      addCount(messageAuthorTypes, m.webhook_id ? "webhook" : "not_webhook");
      for (const e of Array.isArray(m.embeds) ? m.embeds : []) {
        const domain = safeDomain(e?.thumbnail?.url || e?.image?.url);
        if (domain) addCount(imageHosts, domain);
      }
      if (raw) {
        addCount(parsedCounts, raw.status || "unknown");
        addCount(sourceRetailers, String(raw.retailer || "(none)").slice(0,80));
        if (!String(raw.orderNumber || "").trim()) missingOrderNumber++;
      } else {
        addCount(missingParse, status);
      }
      const hour = new Intl.DateTimeFormat("en-US", {
        timeZone:"America/New_York",hour:"2-digit",hourCycle:"h23"
      }).format(new Date(timestamp));
      if (!hourCounts[hour]) hourCounts[hour] = {};
      addCount(hourCounts[hour], status);
    }
    if (raw && ["confirmed","review_hold","cancelled"].includes(raw.status)) {
      const identity = checkoutIdentityFromDiscord(m);
      const orderId = String(identity.orderNumber || raw.orderNumber || "").trim().toLowerCase();
      parsedEvents.push({
        timestamp,
        status:raw.status,
        key:orderId.length >= 5 ? "order:" + orderId : "message:" + String(m.id),
        orderNumberAvailable:orderId.length >= 5,
        items:Array.isArray(raw.items) ? raw.items : [],
        paidCents:cents(checkoutExplicitPaidTotal(m))
      });
    }
  }
  const groups = new Map();
  for (const event of parsedEvents.sort((a,b) => a.timestamp-b.timestamp)) {
    const prior=groups.get(event.key) || { firstAt:event.timestamp,events:[],firstSuccessAt:null,lastStatus:"unverified",bestItems:[],paid:null,hasNumber:event.orderNumberAvailable };
    prior.firstAt=Math.min(prior.firstAt,event.timestamp);
    prior.events.push(event);
    prior.lastStatus=event.status;
    if (event.status === "confirmed" || event.status === "review_hold") {
      prior.firstSuccessAt=Math.min(prior.firstSuccessAt ?? event.timestamp,event.timestamp);
      const sum=q=>q.reduce((a,i)=>a+Math.max(0,Number(i.quantity)||0),0);
      if (sum(event.items)>sum(prior.bestItems)) prior.bestItems=event.items;
      if (event.paidCents !== null) prior.paid=event.paidCents;
    }
    groups.set(event.key,prior);
  }
  const cohort=[...groups.values()].filter(g=>{
    const first=g.firstSuccessAt ?? g.firstAt;
    return first>=from && first<to;
  });
  const retained=cohort.filter(g=>g.lastStatus==="confirmed"||g.lastStatus==="review_hold");
  const products=new Map(), productNames=new Map(), statusUnique={}, paidCents={value:0};
  let units=0,knownPrice=0,unknownPrice=0,eventsOfSameOrder=0,noNumberOrders=0;
  for(const group of cohort) {
    addCount(statusUnique,group.lastStatus);
    if(group.events.length>1)eventsOfSameOrder+=group.events.length-1;
    if(!group.hasNumber)noNumberOrders++;
  }
  for(const group of retained) {
    if(group.paid!==null){paidCents.value+=group.paid;knownPrice++}
    else unknownPrice++;
    for(const item of group.bestItems){
      const q=Number(item.quantity);
      if(!Number.isSafeInteger(q)||q<=0) continue;
      const name=safeProduct(item.name);
      if(!name) continue;
      const key=communityProductKey(name,item.sku) || name.toLowerCase();
      addCount(products,key,q);
      if(!productNames.has(key))productNames.set(key,name);
      units+=q;
    }
  }
  const topProducts=[...products.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
    .slice(0,8).map(([key,qty])=>({name:productNames.get(key),quantity:qty}));
  return {
    window:name,
    from:new Date(from).toISOString(),
    toExclusive:new Date(to).toISOString(),
    directMessagesInWindow:timeEligible.length,
    moduleLifecycle,
    statusColorMessages:colorCounts,
    parsedCheckoutMessages:parsedCounts,
    ignoredMessagesByColor:missingParse,
    webhookTypes:messageAuthorTypes,
    retailerFieldsParsed:sourceRetailers,
    missingOrderNumbersInParsed:missingOrderNumber,
    imageHosts,
    perHour:hourCounts,
    distinctAttemptGroups:cohort.length,
    latestStatusPerAttempt:statusUnique,
    retainedSuccessOrHold:retained.length,
    duplicatedOrderEvents:eventsOfSameOrder,
    attemptedGroupsWithoutOrderNumber:noNumberOrders,
    retainedUnits:units,
    verifiedPaidCents:paidCents.value,
    paidPriceKnownOrders:knownPrice,
    priceMissingOrders:unknownPrice,
    topProducts
  };
}

export async function auditSlabsNGrabsTCSuccess({ token, parseCheckout }={}) {
  if (!token || typeof parseCheckout !== "function") {
    console.log(MARK + " " + JSON.stringify({error:"Discord bot credentials or source parser unavailable"}));
    return;
  }
  try {
    const guilds=await getDiscord(token,"/users/@me/guilds");
    const target=(Array.isArray(guilds)?guilds:[]).filter(g=>normalize(g.name)===GUILD_KEY);
    const related=(Array.isArray(guilds)?guilds:[])
      .filter(g=>normalize(g.name).includes("slabsngrabs"))
      .map(g=>({guild:String(g.name).slice(0,90),id:String(g.id)}));
    console.log(MARK+"_GUILD "+JSON.stringify({connectedGuilds:guilds.length,relatedGuilds:related,targetGuilds:target.length}));
    if(target.length!==1) return;
    const channels=await getDiscord(token,"/guilds/"+target[0].id+"/channels");
    const success=(Array.isArray(channels)?channels:[])
      .filter(c=>[0,5].includes(c.type) && normalize(c.name).includes("success") && !normalize(c.name).includes("hit"));
    console.log(MARK+"_CHANNELS "+JSON.stringify({guild:target[0].name,
      candidates:success.map(c=>({name:c.name,id:String(c.id),type:c.type}))}));
    for(const channel of success) {
      try {
        const {messages,pages,complete,earliestFetched}=await getMessages(token,String(channel.id),DAY_START);
        const parseCheckoutSafe=message=>{
          try{return parseCheckout(message,String(channel.id))}catch{return null}
        };
        console.log(MARK+"_RESULT "+JSON.stringify({
          guild:target[0].name,
          channel:channel.name,
          pages,complete,earliestFetched,
          downloadedMessages:messages.length,
          wholeDay:summarize(messages,{from:DAY_START,to:DAY_END,name:"2026-11-13 full local day"},parseCheckoutSafe),
          morning:summarize(messages,{from:DROP_START,to:DROP_END,name:"2026-11-13 03:00-08:00 Eastern"},parseCheckoutSafe)
        }));
      }catch(error){console.log(MARK+"_CHANNEL_ERROR "+JSON.stringify({channel:channel.name,error:String(error?.message||"read failed").slice(0,130)}))}
    }
  } catch(error){
    console.log(MARK+"_ERROR "+JSON.stringify({error:String(error?.message||"read failed").slice(0,180)}));
  }
}
