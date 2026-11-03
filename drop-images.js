// Product pictures for formatted drop cards. Images come only from the
// owner's own paste: files attached to it, and the previews Discord itself
// generated for the product links in it. Nothing is invented or scraped;
// downloads are limited to Discord's own image hosts.
const DISCORD_IMAGE_HOSTS = /^(?:cdn\.discordapp\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net)$/i;
export const MAX_DROP_IMAGES = 10;
export const MAX_DROP_IMAGE_BYTES = 8 * 1024 * 1024;

export function isDiscordImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && DISCORD_IMAGE_HOSTS.test(url.hostname);
  } catch { return false; }
}

export function hasLinks(message) {
  return /https?:\/\//i.test(String(message?.content || ""));
}

// Link previews first, in the order the links appear (matching product
// order), then attached image files. Duplicates are dropped.
export function dropImageSources(message) {
  const found = [], seen = new Set();
  const add = (url, name) => {
    if (!isDiscordImageUrl(url) || seen.has(url) || found.length >= MAX_DROP_IMAGES) return;
    seen.add(url);
    found.push({ url, name });
  };
  const content = String(message?.content || "");
  const previews = (Array.isArray(message?.embeds) ? message.embeds : [])
    .filter(embed => embed && embed.type !== "rich")
    .map(embed => ({ embed, at: embed.url ? content.indexOf(embed.url) : -1 }))
    .sort((a, b) => (a.at < 0 ? 1e9 : a.at) - (b.at < 0 ? 1e9 : b.at));
  for (const { embed } of previews) {
    const picture = embed.image || embed.thumbnail;
    add(picture?.proxy_url || picture?.url, "product");
  }
  for (const file of Array.isArray(message?.attachments) ? message.attachments : []) {
    if (/^image\//i.test(String(file?.content_type || "")) || /\.(?:png|jpe?g|webp|gif)(?:$|\?)/i.test(String(file?.filename || "")))
      add(file.proxy_url || file.url, "photo");
  }
  return found;
}

export function imageExtension(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  return "jpg";
}
