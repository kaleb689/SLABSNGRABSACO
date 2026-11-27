/*
 * SLABSNGRABSACO staged inbound mail receiver.
 * Deploying this Worker does NOT change any routing rule. The catch-all
 * must be explicitly cut over after separate end-to-end verification.
 * R2 holds private original MIME; Queues carries metadata only.
 */
const MAX_MESSAGE_SIZE = 25 * 1024 * 1024;
// Store generated aliases indefinitely, but expire the received MIME messages.
// Codes expire after 24h by default. All other new email is retained for
// at least 14 days, with 30 days as the default for orders and shipping.
// Both settings can change without changing any generated email addresses.
const HOUR_MS = 60 * 60 * 1000;
const CODE_OPTIONS = new Set([1, 6, 12, 24, 48, 72, 168]);
const OTHER_OPTIONS = new Set([336, 504, 720, 1080, 1440, 2160]);
const LEGACY_MAX_AGE = 720 * HOUR_MS;
const MAX_RETENTION_AGE = 2160 * HOUR_MS;
const OPERATIONAL_SUBJECT = /\b(order|purchase|invoice|receipt|shipment|shipping|shipped|tracking|delivery|delivered|out for delivery|backorder|preorder|pre-order|cancelled|canceled|refund|return|payment|fulfill(?:ed|ment)?)\b/i;
const CLEANUP_PAGE_SIZE = 100;
const CLEANUP_PAGE_LIMIT = 10;
const CODE_SUBJECT = /(?:verif(?:y|ication)|one[ -]?time|\botp\b|(?:sign[ -]?in|log[ -]?in|security|auth(?:entication|orization)?|access|confirm(?:ation)?)\s+(?:code|pin|token)|(?:code|pin|token)\s+(?:for\s+)?(?:sign[ -]?in|log[ -]?in|security|auth(?:entication)?|access|confirm(?:ation)?))/i;
const DEFINITE_CODE_SUBJECT = /\b(?:otp|one[ -]?time(?:\s+(?:password|code))?|(?:verification|verify|security|login|log[ -]?in|sign[ -]?in|authentication)\s+(?:code|pin|token)|(?:code|pin|token)\s+(?:for\s+)?(?:verification|login|log[ -]?in|sign[ -]?in|security|authentication))\b/i;
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
function retentionHours(value, fallback, allowed) {
  const number = Number(value);
  return Number.isInteger(number) && allowed.has(number) ? number : fallback;
}
function retentionSettings(env) {
  return {codeHours:retentionHours(env.CODE_RETENTION_HOURS, 24, CODE_OPTIONS),
    otherHours:retentionHours(env.OTHER_RETENTION_HOURS, 720, OTHER_OPTIONS)};
}
function retentionFor(headers, env, now = Date.now()) {
  const subject = String(headers?.get?.('subject') || '').slice(0,512);
  // An order confirmation/shipping notice must not expire in a day merely
  // because its subject also contains the word "verification".
  const isCode = !!markerOf(headers) || DEFINITE_CODE_SUBJECT.test(subject) ||
    (CODE_SUBJECT.test(subject) && !OPERATIONAL_SUBJECT.test(subject));
  const settings = retentionSettings(env);
  const hours = isCode ? settings.codeHours : settings.otherHours;
  return {kind:isCode?'verification':'other', expiresMs:now + hours * HOUR_MS};
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
  const retention = retentionFor(message.headers, env, timestamp);
  const notification = {
    version:1, id, key, alias,
    marker:markerOf(message.headers),
    receivedMs:timestamp,
    sizeBytes:message.rawSize,
    kind:retention.kind, expiresMs:retention.expiresMs,
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
      // Idempotent: if the queue retries after one successful write, this
      // inserts the missing expiration policy without rewriting the receipt.
      const isCodeEvent = event.kind==='verification';
      const validExpires = Number.isSafeInteger(event.expiresMs) &&
        event.expiresMs >= event.receivedMs + (isCodeEvent ? HOUR_MS : 336*HOUR_MS) &&
        event.expiresMs <= event.receivedMs + (isCodeEvent ? 168*HOUR_MS : MAX_RETENTION_AGE);
      const policy = validExpires && ['verification','other'].includes(event.kind)
        ? {kind:event.kind, expiresMs:event.expiresMs}
        : {kind:'other',expiresMs:event.receivedMs+LEGACY_MAX_AGE};
      await env.RECEIPTS.prepare(
        'INSERT OR IGNORE INTO inbound_retention (id,kind,expires_ms) VALUES (?,?,?)'
      ).bind(event.id,policy.kind,policy.expiresMs).run();
      msg.ack();
    } catch (_) {
      // Cloudflare retries; exhausted failures go to the configured DLQ.
      msg.retry();
    }
  }
}
async function deleteOne(env, row) {
  if (!row || !/^[0-9a-f-]{36}$/i.test(String(row.id || '')) ||
      !String(row.r2_key || '').startsWith('incoming/'))
    throw Error('Invalid mail deletion candidate');
  // Never delete the index first: a failed R2 write must remain retryable.
  await env.RAW_MAIL.delete(row.r2_key);
  await env.RECEIPTS.prepare('DELETE FROM inbound_retention WHERE id = ?').bind(row.id).run();
  await env.RECEIPTS.prepare('DELETE FROM inbound_receipts WHERE id = ?').bind(row.id).run();
}
async function expireBatch(env, now = Date.now()) {
  if (!resourcesReady(env)) throw Error('Inbound retention infrastructure is unavailable');
  let deleted=0,failed=0;
  for (let page=0;page<CLEANUP_PAGE_LIMIT;page++) {
    const result=await env.RECEIPTS.prepare(
      'SELECT r.id,r.r2_key FROM inbound_receipts r '+
      'LEFT JOIN inbound_retention t ON t.id=r.id '+
      'WHERE COALESCE(t.expires_ms,r.received_ms + ?) <= ? '+
      'ORDER BY r.received_ms ASC LIMIT ?'
    ).bind(LEGACY_MAX_AGE,now,CLEANUP_PAGE_SIZE).all();
    const rows=Array.isArray(result?.results)?result.results:[];
    if (!rows.length) break;
    for (const row of rows) {
      try {await deleteOne(env,row);deleted++;}
      catch {failed++;}
    }
    // A consistently failed object must not be retried repeatedly in one
    // invocation; the following hourly Cron run retries it.
    if (failed || rows.length < CLEANUP_PAGE_SIZE) break;
  }
  return {deleted,failed};
}
async function scheduled(_controller,env) {
  // UTC hourly cleanup removes both raw R2 messages and their D1 index.
  // A separate 91-day R2 lifecycle policy covers orphaned MIME not indexed.
  return expireBatch(env);
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
  if (!['GET','DELETE'].includes(request.method)) return reply({error:'Method not allowed'}, 405);
  if (url.pathname === '/v1/retention' && request.method === 'GET') {
    return reply({...retentionSettings(env),cleanup:'hourly',minOtherHours:336,maxOtherHours:2160,
      note:'Generated addresses are not deleted; only delivered messages expire.'});
  }
  // Owner-only mailbox APIs expose metadata or the original .eml on demand.
  // They do not publish messages, render untrusted HTML or log security codes.
  if (url.pathname === '/v1/inbox' && request.method === 'GET') {
    const alias=aliasOf(url.searchParams.get('alias'));
    if (!alias) return reply({error:'A full @sng.sarl address is required'},400);
    const rows=await env.RECEIPTS.prepare(
      'SELECT r.id,r.alias,r.received_ms AS receivedMs,r.size_bytes AS sizeBytes, '+
      "COALESCE(t.kind,'other') AS kind, "+
      'COALESCE(t.expires_ms,r.received_ms + ?) AS expiresMs '+
      'FROM inbound_receipts r LEFT JOIN inbound_retention t ON t.id=r.id '+
      'WHERE r.alias=? AND COALESCE(t.expires_ms,r.received_ms + ?) > ? '+
      'ORDER BY r.received_ms DESC LIMIT 50'
    ).bind(LEGACY_MAX_AGE,alias,LEGACY_MAX_AGE,Date.now()).all();
    return reply({alias,messages:rows?.results||[]});
  }
  if (url.pathname === '/v1/message' && ['GET','DELETE'].includes(request.method)) {
    const id=String(url.searchParams.get('id')||'');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply({error:'Valid message ID required'},400);
    const row=await env.RECEIPTS.prepare(
      'SELECT r.id,r.r2_key FROM inbound_receipts r '+
      'LEFT JOIN inbound_retention t ON t.id=r.id '+
      'WHERE r.id=? AND COALESCE(t.expires_ms,r.received_ms + ?) > ?'
    ).bind(id,LEGACY_MAX_AGE,Date.now()).first();
    if (!row) return reply({error:'Message was deleted or expired'},404);
    if (request.method === 'DELETE') {await deleteOne(env,row);return reply({deleted:true});}
    const object=await env.RAW_MAIL.get(row.r2_key);
    if (!object) return reply({error:'Message content has expired'},404);
    return new Response(object.body,{headers:{
      'content-type':'message/rfc822','content-disposition':'attachment; filename="mail-'+id+'.eml"',
      'cache-control':'no-store','x-content-type-options':'nosniff'}});
  }
  if (request.method !== 'GET') return reply({error:'Method not allowed'},405);
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
export default {email,queue,fetch:fetchHandler,scheduled};
export {aliasOf,markerOf,tokenEqual,retentionFor,retentionSettings,expireBatch};
