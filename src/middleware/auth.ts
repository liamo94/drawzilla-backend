import { createMiddleware } from 'hono/factory'
import { verifyToken } from '@clerk/backend'
import type { Env } from '../types'

export type AuthVariables = {
  clerkId: string
}

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    const token = authHeader.slice(7)
    try {
      const payload = await verifyToken(token, { secretKey: c.env.CLERK_SECRET_KEY })
      c.set('clerkId', payload.sub)
      const existing = await c.env.DB.prepare(
        'SELECT 1 FROM users WHERE clerk_id = ?'
      ).bind(payload.sub).first()
      if (!existing) {
        await c.env.DB.prepare(
          `INSERT INTO users (clerk_id, plan, created_at) VALUES (?, 'free', ?)`
        ).bind(payload.sub, Math.floor(Date.now() / 1000)).run()
      }
      await next()
    } catch {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }
)
