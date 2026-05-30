ALTER TABLE workspaces ADD COLUMN share_token TEXT;
ALTER TABLE workspaces ADD COLUMN share_enabled INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_share_token ON workspaces(share_token) WHERE share_token IS NOT NULL;
