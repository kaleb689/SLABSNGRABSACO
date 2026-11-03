// Formatter for owner-pasted "drop news" posts (date line, Product /
// Demand Level / Resale Outlook header, then product blocks with SKU,
// Retail, Resale, Market and Link). Output mirrors the community layout:
// header in a quote bar, each product bold with its SKU in a code chip,
// details indented under it, a blank line between every block, extra notes
// in a code box, and the release date/time as a Discord timestamp.
// Read-only: never follows links or invents SKUs, prices or dates.
import { FORMATTED_DROP_MARKER, formattedDropName } from "./drop-monitor-format.js";
import { mentionedRetailers, retailerAlert } from "./retailer-alert-roles.js";

const COLOR = 0x38dce8;
const TZ = "America/New_York";
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const HEADER_LABEL = /^(?:release(?:\s*date)?|date|time|when|product|products|demand(?:\s*level)?|resale\s*outlook|outlook|retailer|location|type)$/i;
const SKU_LABEL = /^(?:sku|pid|tcin|dpci|upc|item\s*#?|item\s*number)$/i;
const PRODUCT_FIELD = /^(?:retail|price|msrp|resale|market|links?|cart\s*limit|limit|qty|quantity|store|profit)$/i;
const NOTES_HEADING = /^(?:additional\s*info(?:rmation)?|notes?|info|details)\s*:?\s*(.*)$/i;

const strip = value => String(value || "").replace(/\*\*|__|`/g, "").replace(/^>\s?/, "").trim();
const safe = value => String(value || "").replace(/[\r\n<>@`]/g, " ").replace(/\s+/g, " ").trim();
const isUrl = value => /^https:\/\/\S+$/i.test(String(value || "").trim());
const bareSku = line => /^(.*[A-Za-z].*?)[\s\-|·]+(\d{6,14})$/.exec(line);
const validSku = value => /^[A-Z0-9][A-Z0-9._-]{2,79}$/.test(String(value || ""));

function labeled(line) {
  if (isUrl(line)) return null;
  const found = /^([A-Za-z][A-Za-z #'&/]{0,28}?)\s*:\s*(.*)$/.exec(line);
  return found ? { label: found[1].trim(), value: found[2].trim() } : null;
}
function emojiFix(value) {
  return String(value || "").replace(/:?green_?check(?:mark)?:/gi, "✅").replace(/:?yellow_?check(?:mark)?:/gi, "☑️");
}

// ---- dates -------------------------------------------------------------
function zoneOffsetMinutes(utcMs) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(new Date(utcMs)).find(p => p.type === "timeZoneName")?.value || "GMT-5";
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(part);
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : -300;
}
function newYorkEpoch(y, mo, d, h = 12, mi = 0) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let utc = guess - zoneOffsetMinutes(guess) * 60000;
  utc = guess - zoneOffsetMinutes(utc) * 60000;
  return Math.floor(utc / 1000);
}
function toHour(h, ampm) {
  let hour = Number(h);
  if (/p/i.test(ampm || "") && hour < 12) hour += 12;
  if (/a/i.test(ampm || "") && hour === 12) hour = 0;
  return hour;
}
// Returns { start, end, hasTime, rest } or null. "rest" keeps wording such as
// "@ Store Open" that is not part of the date itself.
export function parseReleaseDate(text, now = Date.now()) {
  const value = String(text || "");
  let y, mo, d, consumed;
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i.exec(value);
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(value);
  if (named) {
    mo = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase()); d = Number(named[2]);
    y = named[3] ? Number(named[3]) : null; consumed = named;
  } else if (numeric) {
    mo = Number(numeric[1]) - 1; d = Number(numeric[2]);
    y = numeric[3] ? Number(numeric[3].length === 2 ? "20" + numeric[3] : numeric[3]) : null; consumed = numeric;
  } else return null;
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  if (!y) {
    const today = new Date(now);
    y = today.getUTCFullYear();
    if (newYorkEpoch(y, mo, d) * 1000 < now - 7 * 86400000) y++;
  }
  const afterDate = value.slice(consumed.index + consumed[0].length);
  const time = /(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?(?:\s*(?:-|–|to)\s*(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?)?/i.exec(afterDate);
  const result = { hasTime: Boolean(time) };
  if (time) {
    result.start = newYorkEpoch(y, mo, d, toHour(time[1], time[3] || time[6]), Number(time[2]));
    if (time[4]) result.end = newYorkEpoch(y, mo, d, toHour(time[4], time[6] || time[3]), Number(time[5]));
    if (result.end && result.end < result.start) result.end += 86400;
  } else {
    result.start = newYorkEpoch(y, mo, d, 12, 0);
  }
  const before = value.slice(0, consumed.index).replace(/^[\s,]*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s*$/i, "").trim();
  const tail = time ? afterDate.slice(0, time.index) + afterDate.slice(time.index + time[0].length) : afterDate;
  result.rest = [before, tail.replace(/^\s*(?:,|at)\s*/i, "").replace(/\s*\b(?:at)\s*$/i, "").trim()]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return result;
}
export function releaseTimestamp(parsed) {
  if (!parsed) return "";
  const main = parsed.hasTime ? `<t:${parsed.start}:F>` : `<t:${parsed.start}:D>`;
  const end = parsed.end ? ` – <t:${parsed.end}:t>` : "";
  const rest = parsed.rest ? " " + safe(parsed.rest) : "";
  return main + end + rest;
}

// ---- parsing -----------------------------------------------------------
function sourceText(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  return String(input.content || "");
}
export function parseDropNews(input, now = Date.now()) {
  const raw = sourceText(input).split(/\r?\n/);
  const lines = raw.map(strip);
  const header = { release: null, releaseText: "", fields: [], intro: [] };
  const products = [], notes = [];
  let current = null, notesMode = false;
  const nextFilled = from => { for (let j = from; j < lines.length; j++) if (lines[j]) return lines[j]; return ""; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (notesMode) { notes.push(line); continue; }
    if (!line) continue;
    const heading = NOTES_HEADING.exec(line);
    if (heading && (products.length || heading[1])) {
      notesMode = true; if (heading[1]) notes.push(heading[1]); continue;
    }
    if (isUrl(line)) {
      if (current && !current.link) current.link = line; else notes.push(line);
      continue;
    }
    const field = labeled(line);
    if (field && SKU_LABEL.test(field.label)) {
      const sku = field.value.split(/\s+/)[0].toUpperCase();
      if (current && !current.sku && validSku(sku)) current.sku = sku;
      continue;
    }
    if (field && !products.length && HEADER_LABEL.test(field.label)) {
      const date = /^(?:release|date|time|when)/i.test(field.label) ? parseReleaseDate(field.value, now) : null;
      if (date && !header.release) { header.release = date; header.releaseText = field.value; }
      else header.fields.push({ label: field.label, value: field.value });
      continue;
    }
    if (field && current) {
      if (/^links?$/i.test(field.label) && isUrl(field.value)) current.link = current.link || field.value;
      else current.fields.push({ label: field.label, value: field.value });
      continue;
    }
    if (field && !products.length) { header.fields.push({ label: field.label, value: field.value }); continue; }
    if (field) { notes.push(line); continue; }
    // Plain text line.
    const bare = bareSku(line);
    const following = labeled(nextFilled(i + 1));
    const startsProduct = bare || (following && (SKU_LABEL.test(following.label) || PRODUCT_FIELD.test(following.label)));
    if (startsProduct) {
      current = { name: bare ? bare[1].trim() : line, sku: bare ? bare[2] : "", fields: [], link: "" };
      products.push(current);
      continue;
    }
    if (!products.length) {
      const date = !header.release ? parseReleaseDate(line, now) : null;
      if (date) { header.release = date; header.releaseText = line; }
      else header.intro.push(line);
      continue;
    }
    notes.push(line);
  }
  while (notes.length && !notes.at(-1)) notes.pop();
  while (notes.length && !notes[0]) notes.shift();
  return { header, products, notes };
}

// A paste qualifies only when it really is a structured drop list: at least
// one product block, and each block has a valid SKU or its own details
// (Retail, Resale, Link...). Upcoming lists often have no SKUs yet.
export function isDropNewsPaste(parsed) {
  return Boolean(parsed?.products?.length &&
    parsed.products.every(product => validSku(product.sku) || product.fields.length || product.link));
}

// ---- rendering ---------------------------------------------------------
function quoteLine(label, value) {
  return "> **" + safe(label).slice(0, 40) + ":** " + emojiFix(safe(value)).slice(0, 300);
}
function renderProduct(product) {
  const numeric = /^\d{6,14}$/.test(product.sku);
  const lines = ["**" + safe(product.name).slice(0, 200) + "**" + (numeric ? " `" + product.sku + "`" : "")];
  if (!numeric && product.sku) lines.push("> **SKU:** `" + safe(product.sku).slice(0, 80) + "`");
  // The owner does not want the "Market: eBay Sold" line in formatted posts.
  for (const f of product.fields) {
    if (/^market$/i.test(f.label)) continue;
    lines.push(quoteLine(f.label, f.value));
  }
  if (product.link) lines.push("> **Link:** " + product.link);
  return lines.join("\n");
}
// rawText lets Upcoming / Tonight titles name the one retailer the post
// mentions ("Upcoming Drop · Target"). Retailer channels keep their name.
export function dropNewsPayloads(parsed, label, rawText = "") {
  if (!isDropNewsPaste(parsed)) return [];
  let title = formattedDropName(label);
  if (/upcoming|tonight/i.test(String(label || ""))) {
    const found = mentionedRetailers(rawText);
    if (found.length === 1 && retailerAlert(found[0])?.name) title += " · " + retailerAlert(found[0]).name;
  }
  const sections = [];
  const head = [];
  for (const line of parsed.header.intro) head.push("> " + emojiFix(safe(line)).slice(0, 300));
  if (parsed.header.release) head.push("> **Release:** " + releaseTimestamp(parsed.header.release));
  for (const f of parsed.header.fields) head.push(quoteLine(f.label, f.value));
  if (head.length) sections.push(head.join("\n"));
  for (const product of parsed.products) sections.push(renderProduct(product));
  if (parsed.notes.length) {
    const body = parsed.notes.join("\n").replace(/`{3,}/g, "'''").slice(0, 1500);
    sections.push("**Additional Info**\n```\n" + body + "\n```");
  }
  const descriptions = [];
  let buffer = "";
  for (const section of sections) {
    const piece = section.slice(0, 3800);
    if (buffer && buffer.length + piece.length + 2 > 3800) { descriptions.push(buffer); buffer = ""; }
    buffer += (buffer ? "\n\n" : "") + piece;
  }
  if (buffer) descriptions.push(buffer);
  return descriptions.map((description, index) => ({
    embeds: [{
      ...(index === 0 ? { title: title + (descriptions.length > 1 ? " (1/" + descriptions.length + ")" : "") }
        : { title: title + " (" + (index + 1) + "/" + descriptions.length + ")" }),
      description, color: COLOR, footer: { text: FORMATTED_DROP_MARKER }
    }],
    allowed_mentions: { parse: [] }
  }));
}
