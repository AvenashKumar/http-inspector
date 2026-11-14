CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  status_text TEXT,
  created_at INTEGER NOT NULL,
  total_ms INTEGER,
  ttfb_ms INTEGER,
  size_bytes INTEGER,
  content_type TEXT,
  headers_json TEXT,
  body_text TEXT,
  redirects_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_inspections_created ON inspections(created_at DESC);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS webhook_requests (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  method TEXT NOT NULL,
  path TEXT,
  query TEXT,
  headers_json TEXT,
  body_text TEXT,
  received_at INTEGER NOT NULL,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_requests ON webhook_requests(webhook_id, received_at DESC);
