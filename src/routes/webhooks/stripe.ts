import { Hono } from 'hono'
import Stripe from 'stripe'
import type { Env } from '../../types'

const app = new Hono<{ Bindings: Env }>()

const THIRTY_DAYS_S = 30 * 24 * 60 * 60

app.post('/webhook', async (c) => {
  const signature = c.req.header('stripe-signature')
  if (!signature) return c.json({ error: 'Missing signature' }, 400)

  const body = await c.req.text()
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY)

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider()
    )
  } catch {
    return c.json({ error: 'Invalid signature' }, 400)
  }

  const sub = event.data.object as Stripe.Subscription
  const customerId = sub.customer as string

  switch (event.type) {
    case 'customer.subscription.created': {
      // Clear any pending cancellation for this user before creating new sub
      await c.env.DB.prepare(
        `DELETE FROM subscriptions
         WHERE user_id = (SELECT clerk_id FROM users WHERE stripe_customer_id = ?)
         AND status = 'cancelling'`
      ).bind(customerId).run()

      await c.env.DB.prepare(
        `INSERT INTO subscriptions (id, user_id, stripe_sub_id, status, current_period_end, started_at)
         VALUES (?, (SELECT clerk_id FROM users WHERE stripe_customer_id = ?), ?, 'active', ?, ?)
         ON CONFLICT(stripe_sub_id) DO UPDATE SET status = 'active', current_period_end = ?, cancel_at = NULL`
      ).bind(crypto.randomUUID(), customerId, sub.id, sub.current_period_end, sub.start_date, sub.current_period_end).run()

      await c.env.DB.prepare(
        'UPDATE users SET plan = ? WHERE stripe_customer_id = ?'
      ).bind('pro', customerId).run()
      break
    }

    case 'customer.subscription.updated': {
      const isActive = sub.status === 'active' || sub.status === 'trialing'
      if (isActive) {
        await c.env.DB.prepare(
          `UPDATE subscriptions SET status = 'active', current_period_end = ?, cancel_at = NULL
           WHERE stripe_sub_id = ?`
        ).bind(sub.current_period_end, sub.id).run()

        await c.env.DB.prepare(
          'UPDATE users SET plan = ? WHERE stripe_customer_id = ?'
        ).bind('pro', customerId).run()
      } else if (sub.status === 'past_due') {
        // Payment failed but Stripe will retry — preserve Pro access during the retry window.
        // If all retries succeed the next 'active' update restores normal state.
        // If all retries fail Stripe marks 'unpaid' or 'canceled', handled below.
        await c.env.DB.prepare(
          `UPDATE subscriptions SET status = 'past_due', current_period_end = ?
           WHERE stripe_sub_id = ?`
        ).bind(sub.current_period_end, sub.id).run()
      } else {
        // unpaid (all retries exhausted), paused, etc. — revoke Pro immediately.
        await c.env.DB.prepare(
          `UPDATE subscriptions SET status = ?, current_period_end = ?
           WHERE stripe_sub_id = ?`
        ).bind(sub.status, sub.current_period_end, sub.id).run()

        await c.env.DB.prepare(
          'UPDATE users SET plan = ? WHERE stripe_customer_id = ?'
        ).bind('free', customerId).run()
      }
      break
    }

    case 'customer.subscription.deleted': {
      // Start 30-day grace period — plan stays 'pro' until cron job runs
      const cancelAt = Math.floor(Date.now() / 1000) + THIRTY_DAYS_S
      await c.env.DB.prepare(
        `UPDATE subscriptions SET status = 'cancelling', cancel_at = ?
         WHERE stripe_sub_id = ?`
      ).bind(cancelAt, sub.id).run()
      break
    }
  }

  return c.json({ ok: true })
})

export default app
