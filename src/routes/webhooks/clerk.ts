import { Hono } from 'hono'
import { Webhook } from 'svix'
import type { Env } from '../../types'
import { deleteUserCompletely } from '../../utils/cleanup'

type ClerkEvent =
  | {
      type: 'user.created'
      data: {
        id: string
        email_addresses: Array<{ email_address: string; id: string }>
        primary_email_address_id: string
      }
    }
  | { type: 'user.deleted'; data: { id: string } }

const app = new Hono<{ Bindings: Env }>()

app.post('/webhook', async (c) => {
  const svixId = c.req.header('svix-id')
  const svixTs = c.req.header('svix-timestamp')
  const svixSig = c.req.header('svix-signature')

  if (!svixId || !svixTs || !svixSig) {
    return c.json({ error: 'Missing svix headers' }, 400)
  }

  const body = await c.req.text()
  const wh = new Webhook(c.env.CLERK_WEBHOOK_SECRET)

  let event: ClerkEvent
  try {
    event = wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTs,
      'svix-signature': svixSig,
    }) as ClerkEvent
  } catch {
    return c.json({ error: 'Invalid signature' }, 400)
  }

  if (event.type === 'user.created') {
    const { id, email_addresses, primary_email_address_id } = event.data
    const email = email_addresses.find(e => e.id === primary_email_address_id)?.email_address ?? ''

    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO users (clerk_id, email, plan) VALUES (?, ?, ?)'
    ).bind(id, email, 'free').run()

    const workspaceId = crypto.randomUUID()
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO workspaces (id, user_id, name, position) VALUES (?, ?, ?, ?)'
    ).bind(workspaceId, id, 'My Workspace', 0).run()
  } else if (event.type === 'user.deleted') {
    await deleteUserCompletely(c.env, event.data.id)
  }

  return c.json({ ok: true })
})

export default app
