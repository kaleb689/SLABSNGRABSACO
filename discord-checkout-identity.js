// Extract only explicitly labeled checkout identifiers from trusted Discord
// webhook messages. Never infer ownership from message author or an unlabelled
// email (which could be a notification or shipping address).
const EMAIL = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const ORDER = /^[A-Z0-9][A-Z0-9._# /-]{2,119}$/i;
const emailLabels = /^(?:email(?: address)?|checkout email|account(?: email| login| username)?|profile email|retailer(?: account)? email|login email|username)$/i;
const orderLabels = /^(?:order(?: (?:number|id|no\.?|#))?|confirmation (?:number|id|no\.?|#)|retailer order (?:number|id|#))$/i;
const profileLabels = /^(?:profile(?: name)?|account name|customer profile)$/i;

function readable(value) {
  return String(value || "").replace(/[*_\x60]/g, "").replace(/\u200b/g, "").trim();
}
function labelText(value) {
  return readable(value).replace(/:$/, "").replace(/\s+/g, " ").toLowerCase().trim();
}
function unique(values) {
  const distinct = [...new Set(values.filter(Boolean))];
  return distinct.length === 1 ? distinct[0] : "";
}
function asEmail(value) {
  const text = readable(value).replace(/^<mailto:/i, "").replace(/^</, "").replace(/>$/, "").trim();
  return EMAIL.test(text) ? text.toLowerCase() : "";
}
function asOrder(value) {
  const text = readable(value).replace(/^#/, "").trim();
  if (!ORDER.test(text) || /^(?:unknown|pending|none|null|n\/a)$/i.test(text)) return "";
  return text;
}

// Only labeled fields and lines count. Conflicting labels are deliberately
// left unmatched rather than giving an order to the wrong paying customer.
export function checkoutIdentityFromDiscord(message) {
  const pairs = [];
  const addLines = text => {
    for (const line of String(text || "").split(/\r?\n/)) {
      const match = readable(line).replace(/^[>\-•\s]+/, "")
        .match(/^([^:\n]{2,55})\s*:\s*(.{1,200})$/);
      if (match) pairs.push([labelText(match[1]), readable(match[2])]);
    }
  };
  addLines(message?.content);
  for (const embed of Array.isArray(message?.embeds) ? message.embeds : []) {
    for (const field of Array.isArray(embed?.fields) ? embed.fields : []) {
      pairs.push([labelText(field.name), readable(field.value)]);
    }
    addLines(embed?.description);
    addLines(embed?.footer?.text);
  }
  const emails = [], orderNumbers = [], profileNames = [];
  for (const [label, value] of pairs) {
    if (emailLabels.test(label)) emails.push(asEmail(value));
    if (orderLabels.test(label)) orderNumbers.push(asOrder(value));
    if (profileLabels.test(label)) profileNames.push(readable(value).slice(0, 100));
  }
  return {
    orderNumber: unique(orderNumbers),
    email: unique(emails),
    profileName: unique(profileNames)
  };
}

// One authoritative checkout channel prevents ingesting copies from the
// public hits channel or two parallel input feeds. An explicitly configured
// source beats the generic success channel. Reject the mirror as a source.
export function checkoutSourceSelection({ checkoutChannelId, successChannelId, hitsChannelId, discoveredChannelIds = [] } = {}) {
  const valid = value => /^\d{17,22}$/.test(String(value || ""));
  const hits = valid(hitsChannelId) ? String(hitsChannelId) : null;
  const explicit = valid(checkoutChannelId) ? String(checkoutChannelId) : null;
  const configured = valid(successChannelId) ? String(successChannelId) : null;
  if (explicit && explicit !== hits) return { channels: [explicit], source: "checkout_source" };
  if (explicit === hits) return { channels: [], source: "mirror_rejected" };
  if (configured && configured !== hits) return { channels: [configured], source: "success_channel" };
  const discovered = [...new Set(discoveredChannelIds.map(String).filter(id => valid(id) && id !== hits))];
  return { channels: discovered.length === 1 ? discovered : [], source: discovered.length === 1 ? "discovered" : "unconfigured_or_ambiguous" };
}
