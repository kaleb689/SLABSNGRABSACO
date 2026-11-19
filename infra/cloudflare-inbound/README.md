# SLABSNGRABSACO inbound mail: private inbox and automatic expiry

This is the **isolated staging** Cloudflare Email Worker. No production `sng.sarl` Email Routing rule, DNS entry, or catch-all is modified by deployment.

## What exists

- Every generated `@sng.sarl` alias is a permanent address in the owner Email Bank. **Expiry deletes messages, not aliases.**
- Inbound raw MIME is stored in a private R2 bucket `sng-inbound-raw`, under `incoming/YYYY-MM-DD/<random-id>.eml`.
- A queue indexes delivery metadata in `sng-inbound-index` D1, including expiration category and timestamp, without storing message body or verification code in D1.
- Staging Worker's authenticated admin API can list recent messages by alias and return the original `.eml` on request; its URL is **not public and is not yet connected to the ACO Studio inbox UI**.

## Automatic deletion and configurable retention

Default: **verification/security-code email = 24 hours**; other messages (receipts, notifications) = **7 days**.

Supported values for the two Worker variables:

| Setting | Default | Allowed values (hours) |
| --- | --- | --- |
| `CODE_RETENTION_HOURS` | `24` | `1, 6, 12, 24, 48, 72, 168` |
| `OTHER_RETENTION_HOURS` | `168` | `1, 6, 12, 24, 48, 72, 168` |

Change these in `wrangler.example.toml` before staging deployment; changing the variable applies to **newly received messages**, not stored messages. Verification classification uses the message's subject (and exact ACO test headers). Incorrectly classified messages may follow the other-email policy; the fallback is 7 days.

Hourly Cron deletes expired `incoming/` objects **and their D1 rows**, with a small bounded batch and retry on failure. It never wipes the bucket and never touches unrelated objects. An independent R2 object lifecycle rule with the exact prefix `incoming/` and an **8-day** expiry backs up the hourly cleanup when storage succeeds but queue indexing fails. These are approximate retention targets, not immediate hard deadlines; Cloudflare Cron or lifecycle execution can be delayed.

An existing D1 database gets the new `inbound_retention` table via idempotent `CREATE TABLE IF NOT EXISTS`; no existing receipts are altered. Pre-existing messages without a retention row get the conservative 7-day maximum.

## Owner-only message access (staging API, not yet an app inbox)

The Worker requires an administrator bearer token stored as a Cloudflare secret (`ADMIN_API_TOKEN`). It does not accept public/unauthenticated access. Do not place this token in a browser URL or a repo.

- `GET /v1/retention`: sanitized hour settings and cleanup cadence
- `GET /v1/inbox?alias=<full-address@sng.sarl>`: up to 50 newest, non-expired messages; metadata only
- `GET /v1/message?id=<UUID>`: download original email as `message/rfc822`; do not render untrusted HTML
- `DELETE /v1/message?id=<UUID>`: optional manual delete of a specific message
- Existing `GET /v1/health` and `GET /v1/receipt` remain unchanged

These API routes **do not mean the owner can already click an Inbox tab**. To make inbox reading available from ACO Studio, create an authenticated admin route (protected with Cloudflare Access or another server-side proxy), connect the app to it, and run an actual verification-message delivery and retrieval test before cutover. The staging Worker remains closed to the public.

## Costs and limitations

R2 Standard includes Cloudflare's free monthly storage and operation allowances. Deletion reduces ongoing storage, but **does not promise $0 billing**: object writes, reads, deletes, D1 operations, Queues and Worker usage can still incur charges beyond their own plan allowances. Monitor the Cloudflare dashboard, preferably with billing usage alerts.

The Worker does not delete or modify existing Gmail IMAP mail, outgoing messages, retailer profiles, or Email Bank aliases. If live routing still forwards to Gmail, Gmail retains its own messages according to Gmail's settings.

## Verification plan before production routing changes

1. Confirm staging R2, Queues, D1 and hourly Cron are healthy.
2. Inspect the object lifecycle rule `sng-inbound-eight-day-safety` and its `incoming/` prefix.
3. Send a real verification-code email to a **staging-tested alias** and verify D1 and private R2 delivery.
4. Test owner access to the message and verify exact code readability.
5. Validate time-based deletion in staging, failure retry, and retention of Email Bank aliases.
6. Only then review and separately authorize production `sng.sarl` catch-all cutover with rollback.

The worker, queue and storage are not intended to capture unsolicited email or bypass rate limits of external providers.
