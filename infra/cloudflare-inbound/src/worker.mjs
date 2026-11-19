/*
 * SLABSNGRABSACO staged inbound mail receiver.
 * Deploying this Worker does NOT change any routing rule. The catch-all
 * must be explicitly cut over after separate end-to-end verification.
 * R2 holds private original MIME; Queues carries metadata only.
 */
const MAX_MESSAGE_SIZE = 25 * 1024 * 1024;
const TEST_MARKER = /ACO Studio forwarding test [0-9a-f]{24}/i;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: JSON_HEADERS});
}
function aliasOf(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@sng\.sarl$/.test(email)) return '';
  return email;
}
function markerOf(headers) {
  for (const value of [headers.get('x-aco-test-id'), headers.get('subject')]) {
    const found = TEST_MARKER.exec(String(value || ''));
    if (found) return found[0].toLowerCase();
  }
  return '';
}
function tokenEqual(a, b) {
  const actual = String(a || ''), expected = String(b || '');
  let diff = actual.length ^ expected.length;
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) diff |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return diff === 0;
}
function resourcesReady(env) {
  return !!(env.RAW_MAIL && env.INBOUND_QUEUE && env.RECEIPTS);
}
async function email(message, env) {
  if (!resourcesReady(env)) throw Error('Inbound mail infrastructure is not configured');
  const alias = aliasOf(message.to);
  if (!alias) {
    message.setReject('Recipient is not allowed');
    return;
  }
  if (!Number.isFinite(message.rawSize) || message.rawSize < 0 || message.rawSize > MAX_MESSAGE_SIZE) {
    message.setReject('Message size is not allowed');
    return;
  }
  const timestamp = Date.now(), id = crypto.randomUUID();
  const key = 'incoming/' + new Date(timestamp).toISOString().slice(0,10) + '/' + id + '.eml';
  // Durably store MIME before acknowledging delivery. No personal data in logs.
  await env.RAW_MAIL.put(key, message.raw, {
    httpMetadata: {contentType:'message/rfc822'},
  });
  const notification = {
    version:1, id, key, alias,
    marker:markerOf(message.headers),
    receivedMs:timestamp,
    sizeBytes:message.rawSize,
  };
  // If enqueue fails, throw rather than silently marking mail as received.
  // The stored orphan remains available for an R2 reconciliation job.
  await env.INBOUND_QUEUE.send(notification);
}
async function queue(batch, env) {
  if (!resourcesReady(env)) throw Error('Inbound mail infrastructure is not configured');
  for (const msg of batch.messages) {
    try {
      const event = msg.body;
      if (!event || event.version !== 1 ||
          !/^[0-9a-f-]{36}$/i.test(String(event.id || '')) ||
          !String(event.key || '').startsWith('incoming/') ||
          !aliasOf(event.alias)) throw Error('Invalid inbound queue event');
      const stored = await env.RAW_MAIL.head(event.key);
      if (!stored) throw Error('Missing raw email in R2');
      await env.RECEIPTS.prepare(
        'INSERT OR IGNORE INTO inbound_receipts '+
        '(id,alias,marker,received_ms,size_bytes,r2_key) VALUES (?,?,?,?,?,?)'
      ).bind(event.id, event.alias, event.marker || '', event.receivedMs,
             event.sizeBytes, event.key).run();
      msg.ack();
    } catch (_) {
      // Cloudflare retries; exhausted failures go to the configured DLQ.
      msg.retry();
    }
  }
}
async function fetchHandler(request, env) {
  // Receipt metadata only; never raw MIME. Set ADMIN_API_TOKEN as a secret.
  if (!env.ADMIN_API_TOKEN || env.ADMIN_API_TOKEN.length < 32)
    return reply({error:'Admin API is not configured'}, 503);
  const header = request.headers.get('authorization') || '';
  if (!tokenEqual(header, 'Bearer ' + env.ADMIN_API_TOKEN))
    return reply({error:'Unauthorized'}, 401);
  if (!resourcesReady(env)) return reply({error:'Storage is not configured'}, 503);
  const url = new URL(request.url);
  if (request.method !== 'GET') return reply({error:'Method not allowed'}, 405);
  if (url.pathname === '/v1/health') {
    const since = Date.now() - 60*60*1000;
    const result = await env.RECEIPTS.prepare(
      'SELECT COUNT(*) AS total FROM inbound_receipts WHERE received_ms >= ?'
    ).bind(since).first();
    return reply({ok:true,receivedLastHour:Number(result?.total || 0)});
  }
  if (url.pathname === '/v1/receipt') {
    const alias = aliasOf(url.searchParams.get('alias'));
    const marker = markerOf(new Headers({'subject':url.searchParams.get('marker') || ''}));
    const since = Number(url.searchParams.get('sinceMs') || Date.now()-10*60*1000);
    if (!alias || !marker || !Number.isSafeInteger(since) ||
        since < Date.now()-30*24*60*60*1000 || since > Date.now()+60*1000)
      return reply({error:'Valid alias, exact test marker, and recent timestamp required'}, 400);
    const result = await env.RECEIPTS.prepare(
      'SELECT received_ms AS receivedMs FROM inbound_receipts '+
      'WHERE alias = ? AND marker = ? AND received_ms >= ? '+
      'ORDER BY received_ms DESC LIMIT 1'
    ).bind(alias, marker, since).first();
    return reply({verified:!!result,receivedMs:result?.receivedMs || null});
  }
  return reply({error:'Not found'}, 404);
}
export default {email,queue,fetch:fetchHandler};
export {aliasOf,markerOf,tokenEqual};
