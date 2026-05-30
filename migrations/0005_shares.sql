CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'live',
  r2_key TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_shares_canvas_id ON shares(canvas_id);
CREATE INDEX IF NOT EXISTS idx_shares_expires_at ON shares(expires_at) WHERE expires_at IS NOT NULL;

-- Migrate existing live canvas shares to the new table
INSERT OR IGNORE INTO shares (token, canvas_id, type, r2_key, expires_at)
SELECT share_token, id, 'live', NULL, NULL
FROM canvases
WHERE share_token IS NOT NULL AND share_enabled = 1;
