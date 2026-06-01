import { Hono } from 'hono'
import Stripe from 'stripe'
import { requireAuth, type AuthVariables } from '../middleware/auth'
import type { Env } from '../types'
import { cleanupUserData } from '../utils/cleanup'

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

app.use('*', requireAuth)

const ALLOWED_ORIGINS = [
  'https://drawzil.la',
  'https://unleash.drawzil.la',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
]

function isAllowedUrl(url: string): boolean {
  try {
    const { origin } = new URL(url)
    return ALLOWED_ORIGINS.includes(origin)
  } catch {
    return false
  }
}

app.get('/status', async (c) => {
  const clerkId = c.get('clerkId')
  const user = await c.env.DB.prepare(
    `SELECT u.plan, s.status, s.cancel_at, s.started_at
     FROM users u
     LEFT JOIN subscriptions s ON s.user_id = u.clerk_id AND s.status != 'expired'
     WHERE u.clerk_id = ?`
  ).bind(clerkId).first<{ plan: string; status: string | null; cancel_at: number | null; started_at: number | null }>()

  if (!user) return c.json({ plan: 'free', subscription: null, startedAt: null })
  return c.json({
    plan: user.plan,
    subscription: user.status ? { status: user.status, cancelAt: user.cancel_at } : null,
    startedAt: user.started_at ?? null,
  })
})

app.post('/checkout', async (c) => {
  const clerkId = c.get('clerkId')
  const { successUrl, cancelUrl } = await c.req.json<{ successUrl: string; cancelUrl: string }>()
  if (!isAllowedUrl(successUrl) || !isAllowedUrl(cancelUrl)) return c.json({ error: 'Invalid redirect URL' }, 400)

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY)

  const user = await c.env.DB.prepare(
    'SELECT email, stripe_customer_id FROM users WHERE clerk_id = ?'
  ).bind(clerkId).first<{ email: string | null; stripe_customer_id: string | null }>()

  if (!user) return c.json({ error: 'User not found' }, 404)

  // Reuse existing Stripe customer or create one
  let customerId = user.stripe_customer_id
  if (!customerId) {
    const customer = await stripe.customers.create({
      ...(user.email ? { email: user.email } : {}),
      metadata: { clerk_id: clerkId },
    })
    customerId = customer.id
    await c.env.DB.prepare(
      'UPDATE users SET stripe_customer_id = ? WHERE clerk_id = ?'
    ).bind(customerId, clerkId).run()
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: c.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
  })

  return c.json({ url: session.url })
})

app.post('/portal', async (c) => {
  const clerkId = c.get('clerkId')
  const { returnUrl } = await c.req.json<{ returnUrl: string }>()
  if (!isAllowedUrl(returnUrl)) return c.json({ error: 'Invalid redirect URL' }, 400)

  const user = await c.env.DB.prepare(
    'SELECT stripe_customer_id FROM users WHERE clerk_id = ?'
  ).bind(clerkId).first<{ stripe_customer_id: string | null }>()

  if (!user?.stripe_customer_id) return c.json({ error: 'No billing account found' }, 404)

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY)
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: returnUrl,
  })

  return c.json({ url: session.url })
})

// ── Dev-only test endpoints ───────────────────────────────────────────────────
// Only active when ENVIRONMENT !== 'production'. Set ENVIRONMENT=development in
// .dev.vars to enable these locally.

app.post('/dev/cancel', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'Not available' }, 404)
  const clerkId = c.get('clerkId')
  const body = await c.req.json<{ daysUntilCancel?: number }>().catch(() => ({ daysUntilCancel: undefined }))
  const days = body.daysUntilCancel ?? 30
  const cancelAt = Math.floor(Date.now() / 1000) + days * 86400

  await c.env.DB.prepare(`UPDATE users SET plan = 'pro' WHERE clerk_id = ?`).bind(clerkId).run()
  await c.env.DB.prepare(
    `INSERT INTO subscriptions (id, user_id, stripe_sub_id, status, current_period_end, cancel_at)
     VALUES (?, ?, ?, 'cancelling', ?, ?)
     ON CONFLICT(stripe_sub_id) DO UPDATE SET status = 'cancelling', cancel_at = excluded.cancel_at`
  ).bind(crypto.randomUUID(), clerkId, `dev_${clerkId}`, cancelAt, cancelAt).run()

  return c.json({ ok: true, cancelAt, cancelAtDate: new Date(cancelAt * 1000).toISOString() })
})

app.post('/dev/expire', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'Not available' }, 404)
  const clerkId = c.get('clerkId')

  // Set cancel_at to the past so the user is treated as expired
  await c.env.DB.prepare(
    `UPDATE subscriptions SET cancel_at = 1 WHERE user_id = ?`
  ).bind(clerkId).run()

  // Run cleanup immediately for this user
  await cleanupUserData(c.env, [clerkId])

  return c.json({ ok: true })
})

app.post('/dev/reset', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'Not available' }, 404)
  const clerkId = c.get('clerkId')

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET plan = 'free' WHERE clerk_id = ?`).bind(clerkId),
    c.env.DB.prepare(`DELETE FROM subscriptions WHERE user_id = ?`).bind(clerkId),
  ])

  return c.json({ ok: true })
})

export default app
