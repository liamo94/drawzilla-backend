-- Idempotency table: prevents Stripe webhooks from processing the same event twice
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

-- Indexes used by daily cron queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_cancel_at ON subscriptions (cancel_at);
CREATE INDEX IF NOT EXISTS idx_shares_expires_at ON shares (expires_at);
