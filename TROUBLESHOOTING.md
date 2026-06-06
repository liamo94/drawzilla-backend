# Troubleshooting Guide

Quick reference for diagnosing and fixing customer issues in production.

All `wrangler d1 execute` commands run against the live database. Double-check queries before running writes.

---

## Look up a user

Always start here — get the clerk ID, Stripe customer ID, current plan, and subscription status.

```bash
npx wrangler d1 execute drawzilla-db --remote --command \
  "SELECT u.clerk_id, u.email, u.stripe_customer_id, u.plan, u.gifted,
          s.stripe_sub_id, s.status, s.cancel_at, s.current_period_end, s.started_at
   FROM users u
   LEFT JOIN subscriptions s ON s.user_id = u.clerk_id AND s.status != 'expired'
   WHERE u.email = 'user@example.com'"
```

Replace `email =` with `clerk_id =` if you have the Clerk user ID instead.

---

## Customer paid but Pro has not been set

**Cause:** Stripe webhook failed to deliver or was not processed (e.g. signature mismatch, D1 write error, or the event was received before the user row existed).

**Step 1 — check if the webhook event was received:**

```bash
npx wrangler d1 execute drawzilla-db --remote --command \
  "SELECT id, processed_at FROM webhook_events
   WHERE id LIKE 'evt_%'
   ORDER BY processed_at DESC LIMIT 20"
```

Find the relevant `customer.subscription.created` or `customer.subscription.updated` event in the [Stripe dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks). If it shows failed or was never delivered, re-deliver it from the dashboard — the webhook handler is idempotent and will process it correctly.

**Step 2 — if re-delivery isn't possible, fix manually:**

Find the Stripe customer ID and subscription ID from the Stripe dashboard, then run:

```bash
# Set plan to pro
npx wrangler d1 execute drawzilla-db --remote --command \
  "UPDATE users SET plan = 'pro' WHERE email = 'user@example.com' AND gifted = 0"

# Upsert the subscription row (fill in real values)
npx wrangler d1 execute drawzilla-db --remote --command \
  "INSERT INTO subscriptions (id, user_id, stripe_sub_id, status, current_period_end, started_at)
   VALUES (
     lower(hex(randomblob(16))),
     (SELECT clerk_id FROM users WHERE email = 'user@example.com'),
     'sub_XXXXXXXXXXXX',
     'active',
     UNIXEPOCH('now', '+30 days'),
     UNIXEPOCH('now')
   )
   ON CONFLICT(stripe_sub_id) DO UPDATE SET
     status = 'active', current_period_end = excluded.current_period_end, cancel_at = NULL"
```

> Prefer re-delivering the webhook over manual SQL — the webhook path is tested and handles edge cases.

---

## Customer cancelled but still shows as Pro (or vice versa)

**Check the subscription row:**

```bash
npx wrangler d1 execute drawzilla-db --remote --command \
  "SELECT s.*, datetime(s.cancel_at, 'unixepoch') AS cancel_at_date,
          datetime(s.current_period_end, 'unixepoch') AS period_end_date
   FROM subscriptions s
   JOIN users u ON u.clerk_id = s.user_id
   WHERE u.email = 'user@example.com'"
```

- `status = 'cancelling'` with `cancel_at` in the future → correct, they keep Pro until that date.
- `status = 'cancelling'` with `cancel_at` in the past → cron hasn't run yet or failed. Run it manually (see below), or fix directly:

```bash
npx wrangler d1 execute drawzilla-db --remote --command \
  "UPDATE users SET plan = 'free'
   WHERE email = 'user@example.com' AND gifted = 0"
```

- `status = 'active'` but Stripe shows cancelled → re-deliver the `customer.subscription.deleted` event from the Stripe dashboard.

---

## Subscription shows `past_due`

The user's payment failed but Stripe is still retrying. They keep Pro access during the retry window. No action needed unless the customer asks — direct them to update their payment method via the billing portal (`/stripe/portal`).

If Stripe eventually marks the subscription as `unpaid` or `canceled`, the webhook will handle the downgrade automatically.

---

## Force-expire a subscription (manual downgrade)

Use this if a refund was issued or you need to immediately remove Pro access.

```bash
# 1. Set cancel_at to the past so the next cron run cleans up
npx wrangler d1 execute drawzilla-db --remote --command \
  "UPDATE subscriptions SET status = 'cancelling', cancel_at = 1
   WHERE user_id = (SELECT clerk_id FROM users WHERE email = 'user@example.com')"

# 2. Downgrade the plan immediately (cron normally does this, but do it now)
npx wrangler d1 execute drawzilla-db --remote --command \
  "UPDATE users SET plan = 'free'
   WHERE email = 'user@example.com' AND gifted = 0"
```

> This does NOT delete their canvases — that happens on the next nightly cron run (2am UTC). If you want to trigger cleanup immediately, re-deliver a recent `customer.subscription.deleted` Stripe event so the full cleanup path runs.

---

## Gift permanent Pro access

See [GIFTED_USERS.md](./GIFTED_USERS.md) for the full gifting workflow. Short version:

```bash
curl -X POST https://drawzilla-backend.lleeum.workers.dev/admin/gift \
  -H "X-Admin-Secret: <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

Gifted users are immune to webhook downgrades and the nightly cleanup cron.

---

## Check recent webhook events

```bash
npx wrangler d1 execute drawzilla-db --remote --command \
  "SELECT id, datetime(processed_at, 'unixepoch') AS processed_at
   FROM webhook_events
   ORDER BY processed_at DESC LIMIT 30"
```

Cross-reference event IDs with the Stripe dashboard to find missed or failed deliveries.

---

## Nightly cron

The cleanup cron runs at **2am UTC** every day. It:
1. Downgrades users whose `subscriptions.cancel_at` has passed (and `gifted = 0`).
2. Deletes their workspaces, canvases, and R2 data, then recreates a blank workspace.
3. Cleans up expired frozen shares.

If a user reports unexpected data loss, check whether the cron ran around 2am UTC and whether their `cancel_at` had passed. The `webhook_events` table only tracks Stripe events, not cron runs — check Cloudflare Workers logs for cron execution history.

---

## Useful one-liners

**All pro users:**
```bash
npx wrangler d1 execute drawzilla-db --remote --command \
  "SELECT email, plan, gifted FROM users WHERE plan = 'pro' ORDER BY email"
```

**Active subscriptions:**
```bash
npx wrangler d1 execute drawzilla-db --remote --command \
  "SELECT u.email, s.status, s.stripe_sub_id,
          datetime(s.cancel_at, 'unixepoch') AS cancel_at,
          datetime(s.current_period_end, 'unixepoch') AS period_end
   FROM subscriptions s JOIN users u ON u.clerk_id = s.user_id
   ORDER BY s.status"
```

**Subscriptions expiring in the next 7 days:**
```bash
npx wrangler d1 execute drawzilla-db --remote --command \
  "SELECT u.email, s.status, datetime(s.cancel_at, 'unixepoch') AS cancel_at
   FROM subscriptions s JOIN users u ON u.clerk_id = s.user_id
   WHERE s.cancel_at BETWEEN UNIXEPOCH('now') AND UNIXEPOCH('now', '+7 days')"
```
