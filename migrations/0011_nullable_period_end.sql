-- SQLite can't DROP NOT NULL directly; recreate the table without the constraint
CREATE TABLE subscriptions_new (
  id                TEXT PRIMARY KEY,
  user_id           TEXT,
  stripe_sub_id     TEXT UNIQUE,
  status            TEXT,
  current_period_end INTEGER,
  cancel_at         INTEGER,
  started_at        INTEGER
);

INSERT INTO subscriptions_new SELECT id, user_id, stripe_sub_id, status, current_period_end, cancel_at, started_at FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;
