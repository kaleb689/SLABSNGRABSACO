// Official-carrier tracking integration for existing, Discord-verified orders.
// Never creates checkouts; API secrets stay on the server. No scraping or paid aggregator.
const tidy = (value, max = 160) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const safeDate = value => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const compactDate = value => {
  const raw = tidy(value, 40);
  if (/^\d{8}$/.test(raw)) return raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6, 8);
  return raw || null;
};
const array = value => Array.isArray(value) ? value : value ? [value] : [];

export function cleanTrackingNumber(value) {
  const candidate = String(value || "").toUpperCase().replace(/[\s-]+/g, "");
  return /^[A-Z0-9]{8,34}$/.test(candidate) ? candidate : null;
}

export function knownCarrier(carrier, number = "") {
  const carrierName = tidy(carrier, 100).toLowerCase();
  if (/\b(?:usps|united states postal service|postal service)\b/.test(carrierName)) return "USPS";
  if (/\b(?:fedex|federal express)\b/.test(carrierName)) return "FedEx";
  if (/\bups\b|united parcel service/.test(carrierName)) return "UPS";
  if (/^1Z[A-Z0-9]{16}$/i.test(String(number || "").replace(/[\s-]/g, ""))) return "UPS";
  return null;
}

export function officialTrackingUrl(carrier, number) {
  const normalized = cleanTrackingNumber(number);
  if (!normalized) return null;
  const selected = knownCarrier(carrier, normalized);
  if (selected === "UPS") return "https://www.ups.com/track?loc=en_US&tracknum=" + encodeURIComponent(normalized);
  if (selected === "FedEx") return "https://www.fedex.com/fedextrack/?trknbr=" + encodeURIComponent(normalized);
  if (selected === "USPS") return "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + encodeURIComponent(normalized);
  return null;
}

export function trackingEvidenceFromEmail({subject = "", text = "", html = ""} = {}) {
  const combined = [subject, text, html.replace(/<[^>]*>/g, " ")]
    .join("\n").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&");
  let number = null, carrier = null;
  const explicit = /\btracking\s*(?:number|no\.?|#|id)\s*[:#-]?\s*([A-Z0-9][A-Z0-9 -]{7,42})/ig;
  for (const match of combined.matchAll(explicit)) {
    const first = match[1].split(/\s{2,}|[;,|<>]/)[0];
    const candidate = cleanTrackingNumber(first);
    if (candidate) { number = candidate; break; }
    const separated = (match[1].match(/[A-Z0-9-]{8,34}/gi) || []).map(cleanTrackingNumber).find(Boolean);
    if (separated) { number = separated; break; }
  }
  // Carrier URLs in legitimate retailer emails may include the number when text does not.
  const urls = [String(text || ""), String(html || "")].join("\n").match(/https?:\/\/[^\s"'<>\u0000-\u001f]+/gi) || [];
  for (const url of urls.slice(0, 80)) {
    try {
      const parsed = new URL(url.replace(/&amp;/gi, "&"));
      if (parsed.protocol !== "https:") continue;
      const host = parsed.hostname.toLowerCase();
      const site = host === "ups.com" || host.endsWith(".ups.com") ? "UPS"
        : host === "fedex.com" || host.endsWith(".fedex.com") ? "FedEx"
        : host === "usps.com" || host.endsWith(".usps.com") ? "USPS" : null;
      if (!site) continue;
      const param = ["tracknum", "trknbr", "tLabels", "trackingNumber", "trackingnumber"]
        .map(key => parsed.searchParams.get(key)).find(Boolean);
      const fromUrl = cleanTrackingNumber(param);
      if (fromUrl && (!number || number === fromUrl)) { number = fromUrl; carrier = site; break; }
    } catch { /* malformed mail link */ }
  }
  carrier ||= knownCarrier(
    /\b(?:FedEx|Federal Express)\b/i.test(combined) ? "FedEx"
      : /\b(?:USPS|United States Postal Service)\b/i.test(combined) ? "USPS"
      : /\b(?:UPS|United Parcel Service)\b/i.test(combined) ? "UPS" : "",
    number
  );
  return {trackingNumber: number, carrier, trackingUrl: officialTrackingUrl(carrier, number)};
}

export function carrierStage(value = "", code = "") {
  const status = tidy(value, 220).toLowerCase();
  const carrierCode = tidy(code, 20).toUpperCase();
  if (/(?:^|\b)(?:delivered|delivery completed|delivery complete|left at front door|signed for)(?:\b|$)/.test(status) &&
      !/\b(?:expected|estimated|scheduled|will be|not|undeliverable)\b/.test(status)) return "delivered";
  if (/\bout for delivery\b|\bon vehicle for delivery\b/.test(status) || carrierCode === "OD") return "out_for_delivery";
  if (/\bin transit\b|\bon the way\b|\bdeparted\b|\barrived at\b|\barrival at\b|\bat facility\b|\bin transport\b/.test(status) ||
      carrierCode === "IT") return "in_transit";
  if (/\bshipped\b|\blabel created\b|\bshipment information\b|\bpicked up\b|\baccepted\b|\bpossession of item\b|\bpackage received\b/.test(status) ||
      ["PU", "OC"].includes(carrierCode)) return "shipped";
  if (carrierCode === "DL") return "delivered";
  return null;
}

function toEvent({description = "", time = null, city = "", state = "", country = "", code = ""} = {}) {
  const status = tidy(description, 160);
  if (!status) return null;
  return {
    status,
    at: safeDate(time),
    location: [tidy(city, 70), tidy(state, 40), tidy(country, 35)].filter(Boolean).join(", ").slice(0, 160) || null,
    stage: carrierStage(status, code),
    source: "carrier_api"
  };
}

function normalizeEvents(events) {
  const dedup = new Map();
  for (const entry of array(events).slice(0, 120)) {
    if (!entry || typeof entry !== "object") continue;
    const normalized = {
      status: tidy(entry.status, 160),
      at: safeDate(entry.at || entry.date),
      location: tidy(entry.location, 160) || null,
      stage: ["shipped", "in_transit", "out_for_delivery", "delivered"].includes(entry.stage) ? entry.stage : null,
      source: entry.source === "retailer_email" ? "retailer_email" : "carrier_api"
    };
    if (!normalized.status) continue;
    const key = JSON.stringify([normalized.status, normalized.at, normalized.location]);
    dedup.set(key, normalized);
  }
  return [...dedup.values()].sort((a, b) => (Date.parse(b.at || "") || 0) - (Date.parse(a.at || "") || 0)).slice(0, 50);
}

function upsTime(event = {}) {
  const day = compactDate(event.gmtDate || event.date);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const rawTime = String(event.gmtTime || event.time || "000000").padStart(6, "0").slice(0, 6);
  if (!/^\d{6}$/.test(rawTime)) return null;
  const offset = event.gmtOffset && /^[+-]\d{2}:\d{2}$/.test(event.gmtOffset) ? event.gmtOffset : "Z";
  return day + "T" + rawTime.slice(0,2) + ":" + rawTime.slice(2,4) + ":" + rawTime.slice(4,6) + offset;
}

export function normalizeCarrierResponse(carrier, requestedNumber, data) {
  const number = cleanTrackingNumber(requestedNumber);
  const selected = knownCarrier(carrier, number);
  if (!selected || !number || !data || typeof data !== "object") return null;
  let rawEvents = [], status = null, estimatedDelivery = null;
  if (selected === "UPS") {
    const shipment = array(data.trackResponse?.shipment)[0];
    const packages = array(shipment?.package);
    const pack = packages.find(p => cleanTrackingNumber(p?.trackingNumber) === number) ||
      (packages.length === 1 && !cleanTrackingNumber(packages[0]?.trackingNumber) ? packages[0] : null);
    if (!pack) return null;
    rawEvents = array(pack.activity).map(item => toEvent({
      description: item?.status?.description || item?.status?.simplifiedTextDescription,
      time: upsTime(item), city: item?.location?.address?.city,
      state: item?.location?.address?.stateProvince,
      country: item?.location?.address?.countryCode, code: item?.status?.code
    }));
    status = carrierStage(pack.currentStatus?.description || pack.currentStatus?.simplifiedTextDescription || "", pack.currentStatus?.code);
    estimatedDelivery = compactDate(array(pack.deliveryDate).find(d => d?.type === "SDD" || d?.type === "RDD")?.date);
  } else if (selected === "FedEx") {
    const matches = array(data.output?.completeTrackResults).flatMap(group => array(group.trackResults));
    const result = matches.find(t => cleanTrackingNumber(t?.trackingNumberInfo?.trackingNumber) === number) ||
      (matches.length === 1 && !cleanTrackingNumber(matches[0]?.trackingNumberInfo?.trackingNumber) ? matches[0] : null);
    if (!result || result.error) return null;
    rawEvents = array(result.scanEvents).map(item => toEvent({
      description: item?.eventDescription || item?.derivedStatus || item?.eventType,
      time: item?.date, city: item?.scanLocation?.city,
      state: item?.scanLocation?.stateOrProvinceCode,
      country: item?.scanLocation?.countryCode, code: item?.eventType
    }));
    status = carrierStage(result.latestStatusDetail?.description || result.latestStatusDetail?.statusByLocale || "", result.latestStatusDetail?.code);
    estimatedDelivery = compactDate(
      array(result.dateAndTimes).find(item => /ESTIMATED_DELIVERY|COMMITMENT/i.test(item?.type || ""))?.dateTime ||
      result.estimatedDeliveryTimeWindow?.window?.ends
    );
  } else if (selected === "USPS") {
    const result = array(data)[0] || data;
    if (result?.error || (result?.trackingNumber && cleanTrackingNumber(result.trackingNumber) !== number)) return null;
    rawEvents = array(result.trackingEvents).map(item => toEvent({
      description: item?.eventType || item?.eventDescription,
      time: item?.GMTTimestamp || item?.eventTimestamp,
      city: item?.eventCity, state: item?.eventState,
      country: item?.eventCountry, code: item?.eventCode
    }));
    status = carrierStage(result.status || result.statusSummary || result.statusCategory || "");
    estimatedDelivery = compactDate(
      result.deliveryDateExpectation?.expectedDeliveryDate ||
      result.deliveryDateExpectation?.predictedDeliveryDate || result.expectedDeliveryDate
    );
  }
  const events = normalizeEvents(rawEvents.filter(Boolean));
  if (!status) status = events.find(e => e.stage)?.stage || null;
  // An empty response is not evidence of a carrier update.
  if (!status && !events.length && !estimatedDelivery) return null;
  return {
    carrier: selected, trackingNumber: number, status, estimatedDelivery,
    trackingUrl: officialTrackingUrl(selected, number), events, source: "carrier_api"
  };
}

export function mergeCarrierShipping(prior = {}, update, observedAt = new Date().toISOString()) {
  if (!update || !cleanTrackingNumber(update.trackingNumber) ||
      (prior.trackingNumber && cleanTrackingNumber(prior.trackingNumber) !== cleanTrackingNumber(update.trackingNumber))) return null;
  const stages = {shipped: 1, in_transit: 2, out_for_delivery: 3, delivered: 4};
  const oldRank = stages[prior.status] || 0, newRank = stages[update.status] || 0;
  const history = normalizeEvents([...(prior.events || []), ...(update.events || [])]);
  const next = {
    ...prior,
    status: newRank > oldRank ? update.status : prior.status || update.status || null,
    estimatedDelivery: update.estimatedDelivery || prior.estimatedDelivery || null,
    trackingNumber: update.trackingNumber,
    trackingUrl: update.trackingUrl || prior.trackingUrl || null,
    carrier: update.carrier || prior.carrier || null,
    events: history,
    deliveredAt: newRank >= 4 && oldRank < 4 ? history.find(e => e.stage === "delivered")?.at || observedAt : prior.deliveredAt || null,
    enRouteAt: prior.enRouteAt || (newRank >= 1 ? history.find(e => e.stage === "shipped" || e.stage === "in_transit")?.at || observedAt : null),
    updatedAt: observedAt,
    source: "carrier_api"
  };
  const meaningful = value => JSON.stringify([
    value.status, value.estimatedDelivery, value.trackingNumber, value.trackingUrl,
    value.carrier, value.deliveredAt, value.enRouteAt, normalizeEvents(value.events)
  ]);
  return meaningful(prior) === meaningful(next) ? null : next;
}

// These APIs use first-party access only. No tracking credentials reach the browser.
export function createCarrierTrackingClient({config = process.env, fetchImpl = fetch} = {}) {
  const tokenCache = new Map();
  const credentials = {
    UPS: [config.UPS_CLIENT_ID, config.UPS_CLIENT_SECRET],
    FedEx: [config.FEDEX_CLIENT_ID, config.FEDEX_CLIENT_SECRET],
    USPS: [config.USPS_CLIENT_ID, config.USPS_CLIENT_SECRET]
  };
  const configured = carrier => {
    const selected = knownCarrier(carrier);
    return Boolean(selected && credentials[selected].every(value => typeof value === "string" && value.trim()));
  };
  async function jsonRequest(url, options) {
    const response = await fetchImpl(url, {...options, signal: AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error("Carrier API HTTP " + response.status);
    const text = await response.text();
    if (text.length > 1000000) throw new Error("Carrier API response too large");
    return JSON.parse(text);
  }
  async function getToken(carrier) {
    const saved = tokenCache.get(carrier);
    if (saved && saved.expires > Date.now() + 60000) return saved.value;
    const [id, secret] = credentials[carrier];
    if (!id || !secret) throw new Error("Carrier credentials not configured");
    let token;
    if (carrier === "UPS") {
      token = await jsonRequest("https://onlinetools.ups.com/security/v1/oauth/token", {
        method: "POST",
        headers: {"Authorization": "Basic " + Buffer.from(id + ":" + secret).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"},
        body: "grant_type=client_credentials"
      });
    } else if (carrier === "FedEx") {
      token = await jsonRequest("https://apis.fedex.com/oauth/token", {
        method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: new URLSearchParams({grant_type: "client_credentials", client_id: id, client_secret: secret}).toString()
      });
    } else {
      token = await jsonRequest("https://apis.usps.com/oauth2/v3/token", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({grant_type: "client_credentials", client_id: id, client_secret: secret})
      });
    }
    if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Carrier access token missing");
    tokenCache.set(carrier, {value: token.access_token,
      expires: Date.now() + Math.max(60, Number(token.expires_in) || 1800) * 1000});
    return token.access_token;
  }
  async function lookup(carrier, number) {
    const normalizedNumber = cleanTrackingNumber(number);
    const selected = knownCarrier(carrier, normalizedNumber);
    if (!configured(selected) || !normalizedNumber) return null;
    const token = await getToken(selected);
    let result;
    if (selected === "UPS") {
      result = await jsonRequest("https://onlinetools.ups.com/api/track/v1/details/" + encodeURIComponent(normalizedNumber) + "?locale=en_US&returnSignature=false", {
        method: "GET",
        headers: {Authorization: "Bearer " + token, transId: "SNGACO-TRACK", transactionSrc: "SLABSNGRABSACO"}
      });
    } else if (selected === "FedEx") {
      result = await jsonRequest("https://apis.fedex.com/track/v1/trackingnumbers", {
        method: "POST",
        headers: {Authorization: "Bearer " + token, "Content-Type": "application/json", "x-locale": "en_US"},
        body: JSON.stringify({includeDetailedScans: true, trackingInfo: [{trackingNumberInfo: {trackingNumber: normalizedNumber}}]})
      });
    } else {
      result = await jsonRequest("https://apis.usps.com/tracking/v3r2/tracking", {
        method: "POST", headers: {Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json"},
        body: JSON.stringify([{trackingNumber: normalizedNumber}])
      });
    }
    return normalizeCarrierResponse(selected, normalizedNumber, result);
  }
  return {configured, lookup};
}
