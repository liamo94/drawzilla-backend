import { Hono } from 'hono'
import Stripe from 'stripe'
import * as Sentry from '@sentry/cloudflare'
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

  // Idempotency: if we've already processed this event, skip silently
  const { meta } = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO webhook_events (id, processed_at) VALUES (?, ?)'
  ).bind(event.id, Math.floor(Date.now() / 1000)).run()
  if (meta.changes === 0) return c.json({ ok: true })

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const customerId = sub.customer as string
        const periodEnd = sub.current_period_end ?? null
        Sentry.setContext('stripe_event', { type: event.type, customerId, subId: sub.id, status: sub.status })
        const isActive = sub.status === 'active' || sub.status === 'trialing'
        if (isActive) {
          await c.env.DB.batch([
            c.env.DB.prepare(
              `INSERT INTO subscriptions (id, user_id, stripe_sub_id, status, current_period_end, started_at)
               VALUES (?, (SELECT clerk_id FROM users WHERE stripe_customer_id = ?), ?, 'active', ?, ?)
               ON CONFLICT(stripe_sub_id) DO UPDATE SET status = 'active', current_period_end = ?, cancel_at = NULL`
            ).bind(crypto.randomUUID(), customerId, sub.id, periodEnd, sub.start_date ?? sub.created ?? null, periodEnd),
            c.env.DB.prepare(
              `DELETE FROM subscriptions
               WHERE user_id = (SELECT clerk_id FROM users WHERE stripe_customer_id = ?)
               AND status = 'cancelling' AND stripe_sub_id != ?`
            ).bind(customerId, sub.id),
            c.env.DB.prepare(
              'UPDATE users SET plan = ? WHERE stripe_customer_id = ? AND gifted = 0'
            ).bind('pro', customerId),
          ])
        } else if (sub.status === 'past_due') {
          // Pro access preserved during Stripe's retry window; status tracked for UI
          await c.env.DB.prepare(
            `UPDATE subscriptions SET status = 'past_due', current_period_end = ?
             WHERE stripe_sub_id = ?`
          ).bind(periodEnd, sub.id).run()
        } else {
          await c.env.DB.batch([
            c.env.DB.prepare(
              `UPDATE subscriptions SET status = ?, current_period_end = ?
               WHERE stripe_sub_id = ?`
            ).bind(sub.status, periodEnd, sub.id),
            c.env.DB.prepare(
              'UPDATE users SET plan = ? WHERE stripe_customer_id = ? AND gifted = 0'
            ).bind('free', customerId),
          ])
        }
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        Sentry.setContext('stripe_event', { type: event.type, subId: sub.id })
        const cancelAt = Math.floor(Date.now() / 1000) + THIRTY_DAYS_S
        await c.env.DB.prepare(
          `UPDATE subscriptions SET status = 'cancelling', cancel_at = ?
           WHERE stripe_sub_id = ?`
        ).bind(cancelAt, sub.id).run()
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string
        const subId = typeof invoice.subscription === 'string' ? invoice.subscription : null
        // Log for visibility — plan downgrade (if needed) is handled by subscription.updated → past_due/unpaid
        Sentry.captureMessage('[stripe-webhook] invoice.payment_failed', {
          level: 'warning',
          extra: { customerId, subId, invoiceId: invoice.id, attemptCount: invoice.attempt_count },
        })
        break
      }
    }
  } catch (err) {
    Sentry.captureException(err)
    console.error('[stripe-webhook] D1 write failed', { type: event.type }, err)
    return c.json({ error: 'internal' }, 500)
  }

  return c.json({ ok: true })
})

export default app
