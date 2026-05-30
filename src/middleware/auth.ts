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
        // user.created webhook was missed — auto-provision as fallback
        console.warn('[requireAuth] fallback provision for clerk_id', payload.sub)
        const workspaceId = crypto.randomUUID()
        await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO users (clerk_id, plan, created_at) VALUES (?, 'free', ?)`
          ).bind(payload.sub, Math.floor(Date.now() / 1000)),
          c.env.DB.prepare(
            'INSERT INTO workspaces (id, user_id, name, position) VALUES (?, ?, ?, ?)'
          ).bind(workspaceId, payload.sub, 'My Workspace', 0),
        ])
      }
      await next()
    } catch {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }
)
