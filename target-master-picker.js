import { targetMasterItems } from "./target-sku-master.js";

const PAGE_SIZE = 5;
const REVIEW_SIZE = 15;
const BACKTICK = String.fromCharCode(96);
const sku = value => String(value || "").trim().toUpperCase();
const safe = value => String(value || "").replace(/[\r\n<>@*_`~|]/g, " ").replace(/\s+/g, " ").trim();
const button = (label, id, style = 2, disabled = false) =>
  ({ type: 2, style, label, custom_id: id, disabled });
const allSkus = master => new Set(targetMasterItems(master).map(row => row.sku));

export function newTargetPickDraft(master, savedSkus = [], quantity = 1) {
  const allowed = allSkus(master);
  const baseline = [...new Set((Array.isArray(savedSkus) ? savedSkus : []).map(sku))]
    .filter(value => allowed.has(value));
  return {
    selected: [...baseline],
    baseline: [...baseline],
    quantity: Number(quantity) === 2 ? 2 : 1,
    query: "",
    page: 0,
    updatedAt: new Date().toISOString()
  };
}

export function targetPickDiff(draft) {
  const before = new Set((draft?.baseline || []).map(sku));
  const after = new Set((draft?.selected || []).map(sku));
  return {
    added: [...after].filter(value => !before.has(value)),
    removed: [...before].filter(value => !after.has(value))
  };
}

export function toggleTargetPick(master, draft, value) {
  const key = sku(value);
  if (!allSkus(master).has(key))
    throw new Error("This Target SKU is no longer in the master. Refresh and choose an available product.");
  const selected = new Set((draft?.selected || []).map(sku));
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  if (selected.size > 200) throw new Error("You can select up to 200 SKUs. Remove some before adding more.");
  return { ...draft, selected: [...selected], updatedAt: new Date().toISOString() };
}

export function setTargetPickQuantity(draft, value) {
  const quantity = Number(value);
  if (![1, 2].includes(quantity)) throw new Error("Choose Qty 1 or Qty 2 for all SKUs.");
  return { ...draft, quantity, updatedAt: new Date().toISOString() };
}

export function searchTargetPicks(draft, query) {
  const filtered = String(query || "").replace(/[\r\n]/g, " ").trim().slice(0, 100);
  return { ...draft, query: filtered, page: 0, updatedAt: new Date().toISOString() };
}

export function pasteTargetPicks(master, draft, input) {
  const raw = String(input || "").trim();
  if (!raw || raw.length > 1800) throw new Error("Paste a comma-separated list of Target SKUs (up to 1,800 characters).");
  const parts = [...new Set(raw.split(/[,;\s]+/g).map(sku).filter(Boolean))];
  if (!parts.length || parts.length > 200)
    throw new Error("Paste between 1 and 200 Target SKUs.");
  const allowed = allSkus(master);
  const missing = parts.filter(value => !allowed.has(value));
  if (missing.length) throw new Error(
    "Not in the Target master: " + missing.slice(0, 12).join(",") +
    (missing.length > 12 ? " (+" + (missing.length - 12) + " more)" : "") +
    ". Nothing was changed."
  );
  const selected = new Set((draft?.selected || []).map(sku));
  const start = selected.size;
  for (const part of parts) selected.add(part);
  if (selected.size > 200) throw new Error("You can select up to 200 SKUs. Nothing was changed.");
  return {
    draft: { ...draft, selected: [...selected], query: "", page: 0, updatedAt: new Date().toISOString() },
    added: selected.size - start
  };
}

export function targetMasterPicker(master, draft, requestedPage, notice = "") {
  const items = targetMasterItems(master);
  const words = safe(draft?.query).toLowerCase().split(/\s+/g).filter(Boolean);
  const matched = words.length
    ? items.filter(row => words.every(word => (row.sku + " " + row.name).toLowerCase().includes(word)))
    : items;
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const requested = Number(requestedPage ?? draft?.page ?? 0);
  const page = Number.isFinite(requested) ? Math.max(0, Math.min(pages - 1, Math.trunc(requested))) : 0;
  const view = matched.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = new Set((draft?.selected || []).map(sku));
  const list = view.map((row, index) => {
    const indexLabel = (index + 1) + ".";
    return "**" + indexLabel + "** " + (selected.has(row.sku) ? "✅" : "▫️") +
      " " + BACKTICK + safe(row.sku).slice(0, 60) + BACKTICK +
      " — " + safe(row.name).slice(0, 110);
  });
  const description = [
    notice ? "**" + safe(notice).slice(0, 320) + "**" : "",
    "**Target SKU picker** · " + items.length + " catalog products",
    "Tap a numbered button to add/remove the matching product. No long dropdowns.",
    words.length ? "**Search:** " + safe(draft.query) : "",
    matched.length ? list.join("\n") : "No matching products. Try a different search.",
    "**Selected in this draft:** " + selected.size +
      " · **Qty " + (draft?.quantity === 2 ? 2 : 1) + " for ALL SKUs**",
    "Page " + (page + 1) + "/" + pages + " · " + matched.length + " matching product(s)",
    "Changes are private until you choose **Confirm Selections**."
  ].filter(Boolean).join("\n\n");
  const controls = [];
  if (view.length) controls.push({ type: 1, components: view.map((row, index) =>
    button((selected.has(row.sku) ? "✓ " : "+ ") + (index + 1),
      "targetpick:toggle:" + row.sku + ":" + page, selected.has(row.sku) ? 3 : 2)
  ) });
  controls.push({ type: 1, components: [
    button("Previous", "targetpick:page:" + (page - 1), 2, page === 0),
    button("Next", "targetpick:page:" + (page + 1), 2, page >= pages - 1),
    button("Search", "targetpick:search", 1),
    button("Clear Search", "targetpick:clear", 2, !words.length),
    button("Paste SKUs", "targetpick:paste", 1)
  ] });
  controls.push({ type: 1, components: [
    button("Qty 1", "targetpick:qty:1", draft?.quantity === 1 ? 3 : 2),
    button("Qty 2", "targetpick:qty:2", draft?.quantity === 2 ? 3 : 2),
    button("Review (" + selected.size + ")", "targetpick:review:0", 1),
    button("Confirm Selections", "targetpick:confirm", 3)
  ] });
  return { flags: 64, allowed_mentions: { parse: [] },
    embeds: [{ title: "Choose Target SKUs", description, color: 0xe74c3c }], components: controls };
}

export function targetMasterPickReview(master, draft, requestedPage = 0) {
  const catalog = new Map(targetMasterItems(master).map(row => [row.sku, row]));
  const selected = [...new Set((draft?.selected || []).map(sku))].filter(key => catalog.has(key));
  const pages = Math.max(1, Math.ceil(selected.length / REVIEW_SIZE));
  const page = Math.max(0, Math.min(pages - 1, Number(requestedPage) || 0));
  const visible = selected.slice(page * REVIEW_SIZE, (page + 1) * REVIEW_SIZE);
  const { added, removed } = targetPickDiff(draft);
  const lines = visible.map(key => BACKTICK + safe(key).slice(0, 60) + BACKTICK +
    " — " + safe(catalog.get(key)?.name).slice(0, 88));
  return {
    flags: 64, allowed_mentions: { parse: [] },
    embeds: [{
      title: "Review Target SKU Selections",
      description: "**" + selected.length + " selected · Qty " + (draft?.quantity === 2 ? 2 : 1) +
        " for ALL SKUs**\n\n" + (lines.join("\n") || "No Target SKUs selected.") +
        "\n\n**New choices:** " + added.length + " · **Removed choices:** " + removed.length +
        "\nNothing changes in your saved selections until you confirm.",
      footer: { text: "Page " + (page + 1) + "/" + pages },
      color: 0xe74c3c
    }],
    components: [
      { type: 1, components: [
        button("Previous", "targetpick:review:" + (page - 1), 2, page === 0),
        button("Next", "targetpick:review:" + (page + 1), 2, page >= pages - 1),
        button("Back to Picker", "targetpick:back", 2),
        button("Confirm Selections", "targetpick:confirm", 3)
      ] }
    ]
  };
}
