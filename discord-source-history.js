// Discord exposes at most 100 messages per page. Re-reading only the latest
// ten pages every minute silently leaves older unimported successes behind.
// Keep a durable, source-specific historical cursor so each successful scan
// continues further back, without slowing fresh checkout detection.
const SNOWFLAKE = /^\d{17,22}$/;

export async function collectDiscordCheckoutPages(getPage, {
  channelId, previous = {}, recentPages = 10, historyPages = 5
} = {}) {
  if (!SNOWFLAKE.test(String(channelId || "")))
    throw new Error("A numeric Discord checkout channel ID is required.");
  if (typeof getPage !== "function") throw new Error("Discord message page reader is required.");
  const all = [], seen = new Set();
  const append = page => {
    if (!Array.isArray(page)) throw new Error("Discord returned an invalid message page.");
    for (const message of page) {
      const id = String(message?.id || "");
      if (!SNOWFLAKE.test(id)) continue;
      if (!seen.has(id)) { seen.add(id); all.push(message); }
    }
    return page;
  };
  let before = "", newestMessageId = null, recentReachedEnd = false;
  const maxRecent = Math.max(1, Math.min(10, Number(recentPages) || 10));
  const maxHistory = Math.max(0, Math.min(10, Number(historyPages) || 5));
  for (let pageIndex = 0; pageIndex < maxRecent; pageIndex++) {
    const page = append(await getPage(before));
    if (pageIndex === 0) newestMessageId = String(page[0]?.id || "") || null;
    if (!page.length || page.length < 100) { recentReachedEnd = true; break; }
    const oldest = String(page[page.length - 1]?.id || "");
    if (!SNOWFLAKE.test(oldest)) throw new Error("Discord page is missing the oldest message ID.");
    before = oldest;
  }

  const previousMatches = String(previous?.channelId || "") === String(channelId);
  let complete = recentReachedEnd || (previousMatches && previous?.complete === true);
  // An interrupted scan never advances the checkpoint. Replays remain safe,
  // because the upstream checkout reconciliation is idempotent.
  let historyBefore = previousMatches && SNOWFLAKE.test(String(previous?.before || ""))
    ? String(previous.before) : before;
  let historyPagesRead = 0;
  if (!complete && historyBefore) {
    for (let i = 0; i < maxHistory; i++) {
      const page = append(await getPage(historyBefore));
      historyPagesRead++;
      if (!page.length || page.length < 100) {
        complete = true;
        break;
      }
      const oldest = String(page[page.length - 1]?.id || "");
      if (!SNOWFLAKE.test(oldest)) throw new Error("Discord historical page has no last message ID.");
      historyBefore = oldest;
    }
  }
  return {
    messages: all,
    newestMessageId,
    history: { channelId: String(channelId),
      before: historyBefore || null, complete, historyPagesRead,
      messagesScanned: all.length }
  };
}
