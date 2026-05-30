import { Hono } from 'hono'
import { requireAuth, type AuthVariables } from '../middleware/auth'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

app.use('*', requireAuth)

const MAX_STASH_BYTES = 5_000_000

function stashKey(clerkId: string) {
  return `stash/${clerkId}.json`
}

app.get('/', async (c) => {
  const clerkId = c.get('clerkId')

  const user = await c.env.DB.prepare(
    'SELECT plan FROM users WHERE clerk_id = ?'
  ).bind(clerkId).first<{ plan: string }>()
  if (user?.plan !== 'pro') return c.json({ error: 'Pro required' }, 403)

  const obj = await c.env.STORAGE.get(stashKey(clerkId))
  if (!obj) return c.json([])

  const text = await obj.text()
  return new Response(text, { headers: { 'Content-Type': 'application/json' } })
})

app.put('/', async (c) => {
  const clerkId = c.get('clerkId')

  const user = await c.env.DB.prepare(
    'SELECT plan FROM users WHERE clerk_id = ?'
  ).bind(clerkId).first<{ plan: string }>()
  if (user?.plan !== 'pro') return c.json({ error: 'Pro required' }, 403)

  const body = await c.req.text()
  if (body.length > MAX_STASH_BYTES) return c.json({ error: 'Stash too large' }, 413)

  try {
    const parsed = JSON.parse(body)
    if (!Array.isArray(parsed)) throw new Error('Not an array')
  } catch {
    return c.json({ error: 'Invalid stash data' }, 400)
  }

  await c.env.STORAGE.put(stashKey(clerkId), body, {
    httpMetadata: { contentType: 'application/json' },
  })

  return c.json({ ok: true })
})

export { stashKey }
export default app
