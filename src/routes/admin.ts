import { Hono } from 'hono'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()

app.use('*', async (c, next) => {
  const secret = c.req.header('X-Admin-Secret')
  if (!secret || secret !== c.env.ADMIN_SECRET) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
})

// POST /admin/gift  { email: string }   → set gifted=1, plan='pro'
// DELETE /admin/gift { email: string }  → set gifted=0, plan='free'
app.post('/gift', async (c) => {
  const { email } = await c.req.json<{ email: string }>()
  if (!email) return c.json({ error: 'email required' }, 400)

  const result = await c.env.DB.prepare(
    `UPDATE users SET gifted = 1, plan = 'pro' WHERE email = ?`
  ).bind(email).run()

  if (result.meta.changes === 0) return c.json({ error: 'User not found' }, 404)
  return c.json({ ok: true, email, gifted: true })
})

app.delete('/gift', async (c) => {
  const { email } = await c.req.json<{ email: string }>()
  if (!email) return c.json({ error: 'email required' }, 400)

  const result = await c.env.DB.prepare(
    `UPDATE users SET gifted = 0, plan = 'free' WHERE email = ?`
  ).bind(email).run()

  if (result.meta.changes === 0) return c.json({ error: 'User not found' }, 404)
  return c.json({ ok: true, email, gifted: false })
})

app.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT email, plan, gifted FROM users WHERE gifted = 1`
  ).all<{ email: string; plan: string; gifted: number }>()

  return c.json({ gifted: results })
})

export default app
