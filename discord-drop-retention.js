export const DROP_MESSAGE_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;

export function dropMessageExpired(message, now = Date.now()) {
  if (!message?.id || message.pinned || ![0, 19].includes(message.type ?? 0)) return false;
  let created = Date.parse(message.timestamp || "");
  if (!Number.isFinite(created) && /^\d{17,22}$/.test(String(message.id))) {
    created = Number((BigInt(message.id) >> 22n) + 1420070400000n);
  }
  return Number.isFinite(created) && created > 0 && now - created >= DROP_MESSAGE_RETENTION_MS;
}

// Only explicitly provisioned drop channels participate. Cursor continuity
// prevents busy channels from hiding expired messages behind recent pages.
// Use individual DELETEs: Discord bulk deletion cannot handle older backlog.
export function createDropMessageRetention({ api, getChannelIds, onDeleted = async () => {},
  now = Date.now, maxPages = 10, onError = () => {} }) {
  const cursors = new Map();
  const pendingRetirements = new Map();
  let running = false;
  return async function cleanupExpiredDropMessages() {
    if (running) return;
    running = true;
    try {
      const channels = new Set(getChannelIds());
      for (const id of cursors.keys()) if (!channels.has(id)) cursors.delete(id);
      for (const channelId of channels) {
        const deleted = pendingRetirements.get(channelId) || new Set();
        try {
          let before = cursors.get(channelId) || "";
          for (let page = 0; page < maxPages; page++) {
            const history = await api(`/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`);
            if (!Array.isArray(history)) throw Error("Invalid drop-channel history response.");
            if (!history.length) { cursors.delete(channelId); break; }
            for (const message of history) {
              if (!dropMessageExpired(message, now())) continue;
              try { await api(`/channels/${channelId}/messages/${message.id}`, "DELETE"); }
              catch (error) { if (!/HTTP 404\b/.test(String(error?.message))) throw error; }
              deleted.add(String(message.id));
            }
            const oldest = String(history.at(-1).id);
            if (history.length < 100 || oldest === before) { cursors.delete(channelId); break; }
            before = oldest;
            cursors.set(channelId, before);
          }
        } catch (error) { onError(error, channelId); }
        // Retire metadata even if a later request failed, without deleting
        // private Users-SKUs messages outside the drop channels.
        if (deleted.size) {
          pendingRetirements.set(channelId, deleted);
          try { await onDeleted(channelId, deleted); pendingRetirements.delete(channelId); }
          catch (error) { onError(error, channelId); }
        }
      }
    } finally { running = false; }
  };
}
