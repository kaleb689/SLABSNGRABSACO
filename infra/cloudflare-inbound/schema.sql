-- Minimal receipt index. Original MIME remains private in R2.
-- Do not store CVVs, messages, email bodies, or account passwords in D1.
CREATE TABLE IF NOT EXISTS inbound_receipts (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  marker TEXT NOT NULL DEFAULT '',
  received_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inbound_receipts_lookup
  ON inbound_receipts(alias, marker, received_ms DESC);
CREATE INDEX IF NOT EXISTS inbound_receipts_hour
  ON inbound_receipts(received_ms);

-- Per-message expiry is separate so already-provisioned D1 databases migrate
-- without ALTER TABLE or destructive schema changes.
CREATE TABLE IF NOT EXISTS inbound_retention (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('verification','other')),
  expires_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbound_retention_due ON inbound_retention(expires_ms);

-- Preserve previously received regular mail when upgrading from the old
-- 7-day default to the new 30-day default. This does not touch code mail,
-- change existing alias strings, or restore previously deleted R2 objects.
UPDATE inbound_retention
SET expires_ms = MAX(expires_ms,
  (SELECT r.received_ms FROM inbound_receipts r WHERE r.id=inbound_retention.id) + 2592000000)
WHERE kind='other' AND EXISTS (
  SELECT 1 FROM inbound_receipts r WHERE r.id=inbound_retention.id
);
