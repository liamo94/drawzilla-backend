CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_presentation_share_token ON workspaces(presentation_share_token) WHERE presentation_share_token IS NOT NULL;
