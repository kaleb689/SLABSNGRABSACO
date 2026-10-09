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
  // Shikari's "Account" field is often "retailer-email:retailer-password".
  // Extract only the explicit email prefix. NEVER return, log, persist, or
  // show the password suffix. A standalone password is not a checkout ID.
  const text = readable(value).replace(/^<mailto:/i, "").trim();
  const match = text.match(/^<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?(?::[^\r\n]*)?$/i);
  const email = match?.[1] || "";
  return EMAIL.test(email) ? email.toLowerCase() : "";
}
function asOrder(value) {
  const text = readable(value).replace(/^#/, "").trim();
  if (!ORDER.test(text) || text.length < 5 || !/\d/.test(text) || /^(?:unknown|pending|none|null|n\/a)$/i.test(text)) return "";
  return text;
}

// Only labeled fields and lines count. Conflicting labels are deliberately
// left unmatched rather than giving an order to the wrong paying customer.
export function checkoutIdentityFromDiscord(message) {
  const pairs = [];
  const addLines = text => {
    const lines = String(text || "").split(/\r?\n/).map(line =>
      readable(line).replace(/^[>\-•\s]+/, "").trim());
    // Shikari can render its embed details as alternating lines:
    // "Account" followed by "retailer-email:password", and "Order ID"
    // followed by the retailer's order number (rather than "Key: Value").
    const recognized = label => emailLabels.test(label) ||
      orderLabels.test(label) || profileLabels.test(label);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const inline = line.match(/^([^:\n]{2,55})\s*:\s*(.{1,200})$/);
      if (inline && recognized(labelText(inline[1]))) {
        pairs.push([labelText(inline[1]), readable(inline[2])]);
        continue;
      }
      if (!recognized(labelText(line))) continue;
      const value = lines[i + 1] || "";
      if (!value || recognized(labelText(value))) continue;
      pairs.push([labelText(line), value]);
      i++;
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
  if (explicit && explicit === hits) return { channels: [], source: "mirror_rejected" };
  if (configured && configured !== hits) return { channels: [configured], source: "success_channel" };
  const discovered = [...new Set(discoveredChannelIds.map(String).filter(id => valid(id) && id !== hits))];
  return { channels: discovered.length === 1 ? discovered : [], source: discovered.length === 1 ? "discovered" : "unconfigured_or_ambiguous" };
}

/**
 * Status comes ONLY from the color of the authoritative Discord webhook
 * embed. Green = confirmed, orange/yellow = review hold, red = cancelled.
 * Unrecognised/mixed colors are not silently treated as successful.
 */
export function checkoutStatusFromDiscord(message) {
  const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
  const statuses = new Set();
  for (const embed of embeds) {
    const color = Number(embed?.color);
    if (!Number.isInteger(color) || color <= 0 || color > 0xffffff) continue;
    const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max-min;
    if (d < 45 || max < 95) continue;
    let hue = max === r ? ((g-b)/d)%6 : max === g ? (b-r)/d+2 : (r-g)/d+4;
    hue = ((hue*60)%360+360)%360;
    if (hue >= 75 && hue <= 175) statuses.add("confirmed");
    else if (hue >= 18 && hue <= 65) statuses.add("review_hold");
    else if (hue <= 15 || hue >= 345) statuses.add("cancelled");
  }
  return statuses.size === 1 ? [...statuses][0] : null;
}

/**
 * Shikari often links the product in the embed description rather than
 * naming a "Product" field. This returns only a product title and NEVER
 * falls back to "Account", "Proxy", login credentials, or order metadata.
 */
export function checkoutProductFromDiscord(message) {
  const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    const description = String(embed?.description || "");
    const linked = description.match(/\[([^\]\r\n]{3,250})\]\(https?:\/\/[^\s)]+\)/i)?.[1];
    const plainLine = description.split(/\r?\n/).map(s => s.trim()
      .replace(/^[>*\s]+/, "").replace(/^\*\*(.+)\*\*$/, "$1"))
      .find(s => s.length >= 10 && s.length <= 250 &&
        !/^(?:success|order|profile|site|account|proxy|status|quantity|price|checkout)\b/i.test(s) &&
        !/[\r\n@]/.test(s) && !/https?:\/\//i.test(s));
    const name = String(linked || plainLine || "").trim().slice(0,250);
    if (name.length >= 3 && !/@|https?:\/\/|\b(?:account|password|proxy|login|card|security code)\b/i.test(name) &&
        !/(?:\d[ -]*?){13,19}/.test(name)) return name;
  }
  return "";
}
