// Pure, privacy-minimized audit batches for confirmed Discord SKU interactions.
// Old selections are never backfilled or represented as historical evidence.
const snowflake = value => /^\d{17,22}$/.test(String(value || ""));
const clean = (value, max = 100) => String(value ?? "").trim().slice(0, max);
const qty = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, Math.floor(n))) : 0;
};
const sourceOf = row => {
  const m = /^(\d{17,22}):(\d{17,22}):/.exec(clean(row?.key, 180));
  return {channelId:m?.[1] || null,sourceMessageId:m?.[2] || null};
};
export function safeSkuAuditItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 200).map(row => {
    const source = sourceOf(row);
    return {
      sku:clean(row?.sku,80).toUpperCase(),
      productName:clean(row?.name,150),
      retailer:clean(row?.retailer || "other",30).toLowerCase(),
      quantity:qty(row?.quantity),
      ...source
    };
  }).filter(row => row.sku && row.quantity > 0);
}
const identity = item => item.retailer + "\\u0000" + item.sku;
const skipIds = record => Array.isArray(record?.skippedUpcomingDrops)
  ? record.skippedUpcomingDrops.slice(0,30).map(row => clean(row?.channelId) + ":" + clean(row?.sourceId)).sort()
  : [];
export function buildDiscordSkuAuditBatch(previous, updated, context, now = new Date()) {
  // Only the verified Gateway interaction wrapper supplies this context.
  if (!snowflake(context?.interactionId) || !snowflake(context?.discordUserId)) return null;
  const beforeState = safeSkuAuditItems(previous?.items);
  const afterState = safeSkuAuditItems(updated?.items);
  const oldItems = new Map(beforeState.map(item => [identity(item),item]));
  const newItems = new Map(afterState.map(item => [identity(item),item]));
  const events = [];
  const keys = new Set([...oldItems.keys(),...newItems.keys()]);
  for (const key of keys) {
    const before = oldItems.get(key), after = newItems.get(key);
    if (before?.quantity === after?.quantity) continue;
    const item = after || before;
    const action = !before ? "select" : !after ? "deselect" :
      after.quantity > before.quantity ? "increase" : "decrease";
    events.push({
      action,sku:item.sku,productName:item.productName,retailer:item.retailer,
      channelId:item.channelId,sourceMessageId:item.sourceMessageId,
      beforeQuantity:before?.quantity || 0,afterQuantity:after?.quantity || 0
    });
  }
  const previouslySkipped=skipIds(previous), currentlySkipped=skipIds(updated);
  const oldTonight = clean(previous?.skipTonightDate,20);
  const newTonight = clean(updated?.skipTonightDate,20);
  const newOptOut = (newTonight && newTonight !== oldTonight) ||
    currentlySkipped.some(key => !previouslySkipped.includes(key));
  const resumed = (oldTonight && !newTonight) ||
    previouslySkipped.some(key => !currentlySkipped.includes(key));
  if (newOptOut || resumed) {
    events.push({
      action:newOptOut ? "opt_out" : "run_all",
      sku:null,productName:null,retailer:null,
      channelId:clean(context.channelId,32)||null,
      sourceMessageId:clean(context.messageId,32)||null,
      beforeQuantity:0,afterQuantity:0
    });
  }
  if (!events.length) return null;
  const interactionId = String(context.interactionId);
  return {
    interactionId,batchId:interactionId,
    discordUserId:String(context.discordUserId),
    discordDisplayName:clean(context.displayName,100),
    guildId:snowflake(context.guildId) ? String(context.guildId) : null,
    interactionChannelId:snowflake(context.channelId) ? String(context.channelId) : null,
    interactionMessageId:snowflake(context.messageId) ? String(context.messageId) : null,
    source:"discord_gateway",createdAt:new Date(now).toISOString(),
    events:events.map((event,index) => ({eventId:interactionId+":"+index,...event})),
    beforeState,afterState
  };
}
