import { Hono } from 'hono'
import { requireAuth, type AuthVariables } from '../middleware/auth'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

app.use('*', requireAuth)

app.get('/', async (c) => {
  const clerkId = c.get('clerkId')
  const row = await c.env.DB.prepare(
    'SELECT preferences FROM users WHERE clerk_id = ?'
  ).bind(clerkId).first<{ preferences: string | null }>()

  if (!row) return c.json({ error: 'User not found' }, 404)
  if (!row.preferences) return c.json(null)

  try {
    return c.json(JSON.parse(row.preferences))
  } catch {
    return c.json(null)
  }
})

const MAX_PREFS_BYTES = 65_536 // 64 KB — preferences are a small settings object

app.put('/', async (c) => {
  const clerkId = c.get('clerkId')
  const contentLength = parseInt(c.req.header('content-length') ?? '0')
  if (contentLength > MAX_PREFS_BYTES) return c.json({ error: 'Payload too large' }, 413)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  await c.env.DB.prepare(
    'UPDATE users SET preferences = ? WHERE clerk_id = ?'
  ).bind(JSON.stringify(body), clerkId).run()

  return c.json({ ok: true })
})

export default app
