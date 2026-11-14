/**
 * Temporary READ-ONLY verification of the SlabsNGrabsTC Discord Success channel.
 * Do not post messages, store payloads, emit order numbers, or access website ledgers.
 * Uses only the bot's existing Discord read credentials in server process memory.
 */
import { checkoutStatusFromDiscord, checkoutIdentityFromDiscord, checkoutProductFromDiscord } from "./discord-checkout-identity.js";
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
const addCount = (obj, key, by=1) => { if (obj instanceof Map) obj.set(key, (obj.get(key) || 0) + by); else obj[key] = (obj[key] || 0) + by; };
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
  const sourceEvidence = [];
  const rejectedRedShapes = [], fieldKinds = {};
  const fieldKind = (value) => {
    const label=String(value||"").toLowerCase().replace(/[*_`]/g,"").trim();
    if (/^(?:order|confirmation|retailer order)/.test(label)) return "order_id_label";
    if (/(?:account|profile|email|login|username)/.test(label)) return "account_or_profile_label";
    if (/(?:product|item)/.test(label)) return "product_label";
    if (/(?:quantity|qty)/.test(label)) return "quantity_label";
    if (/(?:total|paid|charged|amount|subtotal)/.test(label)) return "payment_total_label";
    if (/(?:price)/.test(label)) return "unit_price_label";
    if (/(?:site|retailer|store)/.test(label)) return "retailer_label";
    return "other";
  };
  let missingOrderNumber = 0, moduleLifecycle = 0, rejectedRedWithOrderId = 0, rejectedRedWithoutOrderId = 0;
  for (const m of messages) {
    const timestamp = Date.parse(m.timestamp || "");
    if (!Number.isFinite(timestamp) || timestamp < from) continue;
    if (isModuleLifecycleDiscordMessage(m)) { if (timestamp < to) moduleLifecycle++; continue; }
    const status = checkoutStatusFromDiscord(m) || "unknown";
    const raw = parseCheckout(m);
    const transientIdentity=checkoutIdentityFromDiscord(m);
    const descriptionProduct=safeProduct(checkoutProductFromDiscord(m));
    sourceEvidence.push({
      at:timestamp,status,parsed:Boolean(raw),
      email:transientIdentity.email || "",
      profile:transientIdentity.profileName || "",
      product:descriptionProduct ? communityProductKey(descriptionProduct) : "",
      orderKey:raw?.orderNumber ? "order:"+String(raw.orderNumber).toLowerCase().trim() : ""
    });
    if (timestamp < to) {
      addCount(colorCounts, status);
      addCount(messageAuthorTypes, m.webhook_id ? "webhook" : "not_webhook");
      for (const e of Array.isArray(m.embeds) ? m.embeds : []) {
        const domain = safeDomain(e?.thumbnail?.url || e?.image?.url);
        if (domain) addCount(imageHosts, domain);
      }
      for (const e of Array.isArray(m.embeds) ? m.embeds : []) {
        for (const field of Array.isArray(e?.fields) ? e.fields : []) addCount(fieldKinds, fieldKind(field?.name));
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
    // The original importer rejects red-only cancellation webhooks that lack
    // product details. These still carry a labelled retailer order number and
    // must be included in placed/cancelled attempts, without fabricating items.
    if ((raw && ["confirmed","review_hold","cancelled"].includes(raw.status)) ||
        (!raw && status === "cancelled" && m.webhook_id)) {
      const identity = checkoutIdentityFromDiscord(m);
      const orderId = String(identity.orderNumber || raw?.orderNumber || "").trim().toLowerCase();
      if (!raw && status === "cancelled" && timestamp < to) {
        if (orderId.length >= 5) rejectedRedWithOrderId++;
        else rejectedRedWithoutOrderId++;
        const embeds=Array.isArray(m.embeds) ? m.embeds : [];
        rejectedRedShapes.push({
          hour:new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(timestamp)),
          embeds:embeds.length,
          fieldKinds:embeds.flatMap(e=>(Array.isArray(e.fields)?e.fields:[]).map(f=>fieldKind(f.name))),
          hasIdentityEmail:Boolean(identity.email),
          hasProfileName:Boolean(identity.profileName),
          descriptionHasOrderToken:embeds.some(e=>/\border\b/i.test(String(e.description||""))),
          descriptionHasCancellationToken:embeds.some(e=>/\bcancel(?:led|lation)?\b/i.test(String(e.description||""))),
          titleHasCancellationToken:embeds.some(e=>/\bcancel(?:led|lation)?\b/i.test(String(e.title||""))),
          contentHasCancellationToken:/\bcancel(?:led|lation)?\b/i.test(String(m.content||"")),
          anyProductLink:embeds.some(e=>/\]\(https?:\/\//i.test(String(e.description||""))),
          hasNumericTokens:embeds.some(e=>/(?:\d[ -]*){5,}/.test(String(e.description||"")+
            " "+(Array.isArray(e.fields)?e.fields.map(f=>String(f.value||"")).join(" "):"")))
        });
      }
      parsedEvents.push({
        timestamp,
        status:raw?.status || status,
        key:orderId.length >= 5 ? "order:" + orderId : "message:" + String(m.id),
        orderNumberAvailable:orderId.length >= 5,
        items:Array.isArray(raw?.items) ? raw.items : [],
        paidCents:cents(checkoutExplicitPaidTotal(m))
      });
    }
  }
  const groups = new Map();
  for (const event of parsedEvents.sort((a,b) => a.timestamp-b.timestamp)) {
    const prior=groups.get(event.key) || { firstAt:event.timestamp,events:[],firstSuccessAt:null,lastStatus:"unverified",bestItems:[],lastSuccessItems:[],paid:null,hasNumber:event.orderNumberAvailable };
    prior.firstAt=Math.min(prior.firstAt,event.timestamp);
    prior.events.push(event);
    prior.lastStatus=event.status;
    if (event.status === "confirmed" || event.status === "review_hold") {
      prior.firstSuccessAt=Math.min(prior.firstSuccessAt ?? event.timestamp,event.timestamp);
      const sum=q=>q.reduce((a,i)=>a+Math.max(0,Number(i.quantity)||0),0);
      if (sum(event.items)>sum(prior.bestItems)) prior.bestItems=event.items;
      if (sum(event.items)>0) prior.lastSuccessItems=event.items;
      if (event.paidCents !== null) prior.paid=event.paidCents;
    }
    groups.set(event.key,prior);
  }
  const orphanRedCorrelation=sourceEvidence
    .filter(item=>!item.parsed && item.status==="cancelled" && item.at<to)
    .map(red=>{
      const candidates=sourceEvidence.filter(g=>
        g.parsed && (g.status==="confirmed" || g.status==="review_hold") &&
        Boolean(red.email) && g.email===red.email && g.at<=red.at);
      const byProfile=candidates.filter(g=>Boolean(red.profile) && g.profile===red.profile);
      const byProduct=candidates.filter(g=>Boolean(red.product) && g.product===red.product);
      const strict=byProfile.filter(g=>Boolean(red.product) && g.product===red.product);
      const redCandidate=sourceEvidence.filter(g=>g.parsed && g.status==="cancelled" &&
        Boolean(red.email) && g.email===red.email);
      const redProduct=redCandidate.filter(g=>Boolean(red.product) && g.product===red.product);
      const redProfile=redCandidate.filter(g=>Boolean(red.profile) && g.profile===red.profile);
      const redStrict=redProfile.filter(g=>Boolean(red.product) && g.product===red.product);
      const uniqueKeys=new Set(strict.map(g=>g.orderKey).filter(Boolean));
      return {
        redParsedBySameLogin:redCandidate.length,
        redParsedBySameLoginAndProfile:redProfile.length,
        redParsedBySameLoginAndProduct:redProduct.length,
        redParsedStrict:redStrict.length,
        greenBySameLogin:candidates.length,
        greenBySameLoginAndProfile:byProfile.length,
        greenBySameLoginAndProduct:byProduct.length,
        strictCandidateEvents:strict.length,
        strictUniqueOrderNumbers:uniqueKeys.size,
        strictAlreadyCancelled:[...uniqueKeys].filter(k=>groups.get(k)?.lastStatus==="cancelled").length,
        strictStillActive:[...uniqueKeys].filter(k=>
          groups.get(k)?.lastStatus==="confirmed" || groups.get(k)?.lastStatus==="review_hold").length
      };
    });
  const redOnlyEvents=sourceEvidence.filter(g=>!g.parsed && g.status==="cancelled" && g.at<to);
  const redOnlyGroupSizes = (() => {
    const groups=new Map();
    for(const r of redOnlyEvents){
      const key=String(r.email||"")+"|"+String(r.profile||"")+"|"+String(r.product||"");
      const arr=groups.get(key)||[];
      arr.push(r.at);
      groups.set(key,arr);
    }
    return [...groups.values()].map(arr=>({
      messages:arr.length,spreadMinutes:Math.round((Math.max(...arr)-Math.min(...arr))/60000)
    }));
  })();
  const cohort=[...groups.values()].filter(g=>{
    const first=g.firstSuccessAt ?? g.firstAt;
    return first>=from && first<to;
  });
  const retained=cohort.filter(g=>g.lastStatus==="confirmed"||g.lastStatus==="review_hold");
  const products=new Map(), productNames=new Map(), statusUnique={}, paidCents={value:0};
  let units=0,knownPrice=0,unknownPrice=0,eventsOfSameOrder=0,noNumberOrders=0, itemSubtotalCents=0, missingItemPriceCount=0, itemPriceKnownLines=0;
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
      const itemPrice = cents(item.price);
      if (itemPrice !== null) { itemSubtotalCents += itemPrice*q; itemPriceKnownLines++; }
      else missingItemPriceCount++;
      if(!productNames.has(key))productNames.set(key,name);
      units+=q;
    }
  }
  const latestProducts=new Map(),latestNames=new Map();
  let latestUnits=0, changedLineGroups=0;
  for(const group of retained){
    const items=group.lastSuccessItems.length?group.lastSuccessItems:group.bestItems;
    const sumItems=arr=>arr.reduce((sum,i)=>sum+(Number(i?.quantity)||0),0);
    if(sumItems(group.bestItems)!==sumItems(items))changedLineGroups++;
    for(const item of items){
      const q=Number(item.quantity), name=safeProduct(item.name);
      if(!Number.isSafeInteger(q)||q<=0||!name)continue;
      const key=communityProductKey(name,item.sku)||name.toLowerCase();
      addCount(latestProducts,key,q);
      latestNames.set(key,name);
      latestUnits+=q;
    }
  }
  const latestTopProducts=[...latestProducts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
    .slice(0,8).map(([key,qty])=>({name:latestNames.get(key),quantity:qty}));
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
    fieldKinds,
    rejectedRedShapes,
    orphanRedCorrelation,
    redOnlyGroupSizes,
    webhookTypes:messageAuthorTypes,
    retailerFieldsParsed:sourceRetailers,
    missingOrderNumbersInParsed:missingOrderNumber,
    unparsedRedWithOrderNumber:rejectedRedWithOrderId,
    unparsedRedWithoutOrderNumber:rejectedRedWithoutOrderId,
    imageHosts,
    perHour:hourCounts,
    distinctAttemptGroups:cohort.length,
    latestStatusPerAttempt:statusUnique,
    retainedSuccessOrHold:retained.length,
    duplicatedOrderEvents:eventsOfSameOrder,
    attemptedGroupsWithoutOrderNumber:noNumberOrders,
    retainedUnits:units,
    latestSuccessLineUnits:latestUnits,
    latestSuccessLineTopProducts:latestTopProducts,
    changedLineGroups,
    verifiedPaidCents:paidCents.value,
    paidPriceKnownOrders:knownPrice,
    priceMissingOrders:unknownPrice,
    itemSubtotalCents,
    itemPriceKnownLines,
    missingItemPriceCount,
    topProducts
  };
}


function priceShapeAudit(messages, from, to, parseCheckout) {
  const stats = {
    successMessages:0,uniqueOrderNumbers:0,explicitPaidMessages:0,
    withDollarAnywhere:0,withDollarDescription:0,withDollarTitle:0,withDollarFooter:0,
    withDollarContent:0,withDollarPriceField:0,withUnitPriceField:0,
    withTotalField:0,withOtherMoneyField:0,withPriceInProductLink:0,
    withDecimalInDescription:0,fieldLabelCounts:{},orderTotalBasis:{},
    pricesByProduct:{},priceFieldFormats:{},totalFieldFormats:{},
    simplePriceCents:[],explicitPaidCents:0
  };
  const seen=new Set(), hasDollar=v=>/(?:\$|USD\s*[\d,]+(?:\.\d+)?)/i.test(String(v||""));
  for(const m of messages){
    const at=Date.parse(m.timestamp||"");
    if(!Number.isFinite(at)||at<from||at>=to)continue;
    const status=checkoutStatusFromDiscord(m);
    if(status!=="confirmed"&&status!=="review_hold")continue;
    stats.successMessages++;
    const parsed=parseCheckout(m);
    const id=checkoutIdentityFromDiscord(m).orderNumber;
    const key=id?String(id).trim().toLowerCase():String(m.id);
    seen.add(key);
    const explicit=checkoutExplicitPaidTotal(m);
    if(explicit!==null){
      stats.explicitPaidMessages++;
      stats.explicitPaidCents+=Math.round(explicit*100);
    }
    const embeds=Array.isArray(m.embeds)?m.embeds:[];
    const fields=embeds.flatMap(e=>Array.isArray(e.fields)?e.fields:[]);
    const all=[String(m.content||""),...embeds.flatMap(e=>[
      String(e.title||""),String(e.description||""),String(e.footer?.text||"")]),
      ...fields.map(f=>String(f.value||""))];
    if(all.some(hasDollar))stats.withDollarAnywhere++;
    if(hasDollar(m.content))stats.withDollarContent++;
    if(embeds.some(e=>hasDollar(e.title)))stats.withDollarTitle++;
    if(embeds.some(e=>hasDollar(e.description)))stats.withDollarDescription++;
    if(embeds.some(e=>hasDollar(e.footer?.text)))stats.withDollarFooter++;
    if(embeds.some(e=>/\]\(https?:\/\/[^)]+\).*[$]\s?\d/.test(String(e.description||""))))stats.withPriceInProductLink++;
    if(embeds.some(e=>/(?:^|[^\d])\d{1,5}\.\d{2}(?:$|[^\d])/.test(String(e.description||""))))stats.withDecimalInDescription++;
    let priceField=false,totalField=false,otherMoneyField=false;
    for(const field of fields){
      const label=String(field.name||"").toLowerCase().replace(/[*_]/g,"").trim();
      const value=String(field.value||"");
      const kind=/^(?:unit|item)?\s*price$/.test(label)?"unit-price":
        /\b(?:order|checkout|grand|paid|charged|total|amount)\b/.test(label)?"total":
        /(?:price|cost|subtotal)/.test(label)?"other-price":
        /^(?:product|item)/.test(label)?"product":
        /^(?:quantity|qty)/.test(label)?"quantity":
        /^(?:site|store|retailer)/.test(label)?"retailer":"non-money";
      addCount(stats.fieldLabelCounts,kind);
      if(kind==="unit-price"){
        priceField=true;
        if(hasDollar(value))stats.withDollarPriceField++;
        const simple=/^\s*(?:[$]|USD\s*)?\s*[\d,]+(?:\.\d{2})?\s*(?:USD)?\s*$/i.test(value);
        addCount(stats.priceFieldFormats,simple?"simple_money":hasDollar(value)?"complex_money":"other");
        const n=Number(value.replace(/[^\d.]/g,""));
        if(simple&&Number.isFinite(n)&&n>0&&stats.simplePriceCents.length<35)stats.simplePriceCents.push(Math.round(n*100));
      } else if(kind==="total"){
        totalField=true;
        addCount(stats.totalFieldFormats,hasDollar(value)?"has_currency":/^\s*[\d,.]+\s*$/.test(value)?"numeric":"other");
      } else if(kind==="other-price") otherMoneyField=true;
    }
    if(priceField)stats.withUnitPriceField++;
    if(totalField)stats.withTotalField++;
    if(otherMoneyField)stats.withOtherMoneyField++;
    addCount(stats.orderTotalBasis,String(parsed?.orderTotalBasis||"unparsed"));
    for(const item of Array.isArray(parsed?.items)?parsed.items:[]){
      const name=safeProduct(item?.name);
      if(!name||!(Number(item?.price)>0))continue;
      const product=communityProductKey(name,item.sku)||name.toLowerCase();
      if(!stats.pricesByProduct[product])stats.pricesByProduct[product]={lines:0,cents:[]};
      stats.pricesByProduct[product].lines++;
      const v=Math.round(Number(item.price)*100);
      if(!stats.pricesByProduct[product].cents.includes(v))stats.pricesByProduct[product].cents.push(v);
    }
  }
  stats.uniqueOrderNumbers=seen.size;
  stats.simplePriceCents.sort((a,b)=>a-b);
  return stats;
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
          morning:summarize(messages,{from:DROP_START,to:DROP_END,name:"2026-11-13 03:00-08:00 Eastern"},parseCheckoutSafe),
          priceShape:priceShapeAudit(messages,DROP_START,DROP_END,parseCheckoutSafe)
        }));
      }catch(error){console.log(MARK+"_CHANNEL_ERROR "+JSON.stringify({channel:channel.name,error:String(error?.message||"read failed").slice(0,130)}))}
    }
  } catch(error){
    console.log(MARK+"_ERROR "+JSON.stringify({error:String(error?.message||"read failed").slice(0,180)}));
  }
}
