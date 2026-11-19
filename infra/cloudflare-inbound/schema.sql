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
