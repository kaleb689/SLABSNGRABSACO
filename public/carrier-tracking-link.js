/**
 * Open authenticated customers' shipments directly on the carrier's official
 * tracking page. Never follow an untrusted retailer/email URL or include the
 * customer's order, address, account, or mailbox information in the link.
 */
const carriers = Object.freeze({
  fedex: {
    label: "FedEx",
    url: number => "https://www.fedex.com/fedextrack/?trknbr=" + encodeURIComponent(number)
  },
  ups: {
    label: "UPS",
    url: number => "https://www.ups.com/track?loc=en_US&tracknum=" + encodeURIComponent(number)
  },
  usps: {
    label: "USPS",
    url: number => "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + encodeURIComponent(number)
  },
  dhl: {
    label: "DHL",
    url: number => "https://www.dhl.com/us-en/home/tracking.html?tracking-id=" +
      encodeURIComponent(number) + "&submit=1"
  }
});

function carrierCode(value) {
  const name = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/^fedex(?:express|ground|home|home delivery)?$/.test(name) ||
      name === "federalexpress") return "fedex";
  if (/^ups(?:ground|mailinnovations|surepost)?$/.test(name) ||
      name === "unitedparcelservice") return "ups";
  if (/^usps(?:groundadvantage|prioritymail|firstclass)?$/.test(name) ||
      name === "unitedstatespostalservice" || name === "postalservice") return "usps";
  if (/^dhl(?:express|ecommerce|globalmail)?$/.test(name)) return "dhl";
  return null;
}

function trackingNumber(value) {
  const original = String(value ?? "").trim();
  // No symbols with structural meaning in links, no multiple tracking IDs,
  // and never use a retailer order number as a package tracking number.
  if (!/^[a-z0-9][a-z0-9 -]{6,48}[a-z0-9]$/i.test(original)) return null;
  const normalized = original.replace(/[ -]/g, "").toUpperCase();
  return /^[A-Z0-9]{8,40}$/.test(normalized) ? normalized : null;
}

function officialLinkEvidence(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const domain = url.hostname.toLowerCase();
  const hosts = {
    "www.fedex.com": "fedex", "fedex.com": "fedex",
    "www.ups.com": "ups", "ups.com": "ups", "wwwapps.ups.com": "ups",
    "tools.usps.com": "usps", "www.usps.com": "usps",
    "www.dhl.com": "dhl", "dhl.com": "dhl"
  };
  const carrier = hosts[domain];
  if (!carrier) return null;
  const params = {
    fedex: ["trknbr", "tracknumbers"],
    ups: ["tracknum", "InquiryNumber1"],
    usps: ["tLabels"],
    dhl: ["tracking-id"]
  };
  for (const key of params[carrier]) {
    const number = trackingNumber(url.searchParams.get(key));
    if (number) return { carrier, number };
  }
  return null;
}

/**
 * @returns {{href:string, carrier:string, trackingNumber:string}|null}
 * Both a recognized carrier and a real tracking ID are required. Supports
 * verified carrier URLs already on older order records, but always rebuilds
 * the outgoing link on our fixed list of official carrier domains.
 */
export function carrierTrackingLink(shipping = {}) {
  if (!shipping || typeof shipping !== "object") return null;
  const urlEvidence = officialLinkEvidence(shipping.trackingUrl);
  const explicitCarrier = carrierCode(shipping.carrier);
  const explicitNumber = trackingNumber(shipping.trackingNumber);
  // 1Z-prefixed package IDs are unambiguous UPS tracking numbers.
  const inferred = /^1Z[A-Z0-9]{16}$/.test(explicitNumber || "") ? "ups" : null;
  const carrier = explicitCarrier || urlEvidence?.carrier || inferred;
  const number = explicitNumber ||
    (urlEvidence && carrier === urlEvidence.carrier ? urlEvidence.number : null);
  if (!carrier || !number) return null;
  return {
    href: carriers[carrier].url(number),
    carrier: carriers[carrier].label,
    trackingNumber: number
  };
}
