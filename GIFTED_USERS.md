# Gifted Pro Users

How to give someone permanent Pro access without a Stripe subscription.

Gifted users have `gifted = 1` in the `users` table. This flag:
- Prevents Stripe webhooks from overwriting their `plan` field (subscriptions they cancel or never had don't downgrade them)
- Prevents the daily cron from cleaning up their data on subscription expiry

## Gift an account

```bash
curl -X POST https://drawzilla-backend.lleeum.workers.dev/admin/gift \
  -H "X-Admin-Secret: <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

## Revoke gifted access

```bash
curl -X DELETE https://drawzilla-backend.lleeum.workers.dev/admin/gift \
  -H "X-Admin-Secret: <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

This sets `gifted = 0` and `plan = 'free'` immediately.

## List all gifted users

```bash
curl https://drawzilla-backend.lleeum.workers.dev/admin/users \
  -H "X-Admin-Secret: <ADMIN_SECRET>"
```

## ADMIN_SECRET

Stored as a Cloudflare Worker secret. To rotate it:

```bash
echo "new-secret-here" | npx wrangler secret put ADMIN_SECRET
```

The current secret is in 1Password / wherever you store credentials — not committed to the repo.
