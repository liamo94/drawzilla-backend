-- Track whether a canvas has ever had content saved to it.
-- Default 1 (empty). Set to 0 by PUT /canvases/:id and POST /migrate.
ALTER TABLE canvases ADD COLUMN is_empty INTEGER NOT NULL DEFAULT 1;

-- Backfill: canvases that have been saved at least once have updated_at > created_at.
UPDATE canvases SET is_empty = 0 WHERE updated_at > created_at;
