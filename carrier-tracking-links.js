/**
 * Generate customer-visible tracking links from an identified official carrier
 * and a verified retailer tracking number. Never redirect customers to
 * opaque tracking links, email click-trackers, or a generic homepage.
 */
const CARRIERS = Object.freeze(["UPS", "FedEx", "USPS"]);

function carrierLabel(value) {
  const label = String(value || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (label === "ups" || label === "unitedparcelservice") return "UPS";
  if (label === "fedex" || label === "federalexpress") return "FedEx";
  if (label === "usps" || label === "unitedstatespostalservice") return "USPS";
  return null;
}

export function normalizeTrackingNumber(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw || !/^[A-Z0-9\s-]{7,45}$/.test(raw)) return null;
  const number = raw.replace(/[\s-]/g, "");
  if (number.length < 7 || number.length > 34 ||
      !/^[A-Z0-9]+$/.test(number) || /^([A-Z0-9])\1+$/.test(number) ||
      /(?:TEST|DEMO|EXAMPLE)/.test(number)) return null;
  return number;
}

function validForCarrier(carrier, number) {
  if (!CARRIERS.includes(carrier) || !number) return false;
  if (carrier === "UPS") {
    return /^1Z[0-9A-Z]{16}$/.test(number) ||
      /^\d{7,20}$/.test(number) || /^T\d{10}$/.test(number);
  }
  if (carrier === "FedEx") return /^\d{10,34}$/.test(number);
  return /^\d{20,34}$/.test(number) || /^[A-Z]{2}\d{9}US$/.test(number);
}

export function carrierFromTrackingNumber(value) {
  const number = normalizeTrackingNumber(value);
  if (!number) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(number)) return "UPS";
  if (/^[A-Z]{2}\d{9}US$/.test(number) ||
      /^9[2-5]\d{18,20}$/.test(number)) return "USPS";
  // Numbers used by FedEx, UPS and USPS can overlap. Never guess.
  return null;
}

export function parseOfficialCarrierTrackingUrl(value) {
  try {
    const raw = String(value || "").replace(/&amp;/gi, "&");
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    let carrier = null, keys = [];
    if (host === "ups.com" || host.endsWith(".ups.com")) {
      carrier = "UPS"; keys = ["tracknum", "tracknums", "trackn"];
    } else if (host === "fedex.com" || host.endsWith(".fedex.com")) {
      carrier = "FedEx"; keys = ["trknbr", "tracknumbers", "trackingnumber"];
    } else if (host === "usps.com" || host.endsWith(".usps.com")) {
      carrier = "USPS"; keys = ["tlabels", "trackingnumber", "tracknum"];
    } else return null;
    // No inference from a URL merely mentioning "tracking": it must contain
    // an actual number in an official-carrier tracking parameter.
    let number = null;
    for (const [key, value] of url.searchParams.entries()) {
      if (keys.includes(key.toLowerCase())) {
        number = normalizeTrackingNumber(value);
        if (number) break;
      }
    }
    return number && validForCarrier(carrier, number)
      ? {carrier, trackingNumber:number} : null;
  } catch {
    return null;
  }
}

function trackingUrl(carrier, number) {
  if (carrier === "UPS") return "https://www.ups.com/track?loc=en_US&tracknum=" + encodeURIComponent(number);
  if (carrier === "FedEx") return "https://www.fedex.com/fedextrack/?trknbr=" + encodeURIComponent(number);
  if (carrier === "USPS") return "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + encodeURIComponent(number);
  return null;
}

export function verifiedCarrierTracking(shipping = {}) {
  const explicitCarrier = carrierLabel(shipping?.carrier);
  const explicitNumber = normalizeTrackingNumber(shipping?.trackingNumber);
  const fromLink = parseOfficialCarrierTrackingUrl(shipping?.trackingUrl);
  const number = explicitNumber || fromLink?.trackingNumber || null;
  const carrier = explicitCarrier || fromLink?.carrier || carrierFromTrackingNumber(number);
  const mismatch = Boolean(fromLink &&
    ((explicitCarrier && explicitCarrier !== fromLink.carrier) ||
     (explicitNumber && explicitNumber !== fromLink.trackingNumber)));
  const url = !mismatch && validForCarrier(carrier, number)
    ? trackingUrl(carrier, number) : null;
  return {carrier:carrier || null, trackingNumber:number, url};
}
