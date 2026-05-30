import { Hono } from 'hono'
import { requireAuth, type AuthVariables } from '../middleware/auth'
import type { Env, CanvasData } from '../types'

type LocalCanvas = {
  name: string
  data: CanvasData
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

app.use('*', requireAuth)

const MAX_CANVAS_BYTES = 20_000_000
const MAX_NAME_LENGTH = 200

app.post('/', async (c) => {
  const clerkId = c.get('clerkId')
  const body = await c.req.json<{ canvases: LocalCanvas[] }>().catch(() => null)
  if (!body || !Array.isArray(body.canvases) || body.canvases.length === 0) {
    return c.json({ error: 'No canvases provided' }, 400)
  }
  const { canvases } = body

  let workspace = await c.env.DB.prepare(
    'SELECT id FROM workspaces WHERE user_id = ? ORDER BY position ASC LIMIT 1'
  ).bind(clerkId).first<{ id: string }>()

  if (!workspace) {
    const workspaceId = crypto.randomUUID()
    await c.env.DB.prepare(
      'INSERT INTO workspaces (id, user_id, name, position) VALUES (?, ?, ?, ?)'
    ).bind(workspaceId, clerkId, 'My Workspace', 0).run()
    workspace = { id: workspaceId }
  }

  const user = await c.env.DB.prepare(
    'SELECT plan FROM users WHERE clerk_id = ?'
  ).bind(clerkId).first<{ plan: string }>()
  const cloudLimit = user?.plan === 'pro' ? 9 : 3

  const { results: existing } = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM canvases WHERE workspace_id = ?'
  ).bind(workspace.id).all<{ count: number }>()
  let position = existing[0]?.count ?? 0

  const remaining = Math.max(0, cloudLimit - position)
  for (const canvas of canvases.slice(0, remaining)) {
    if (typeof canvas.name !== 'string' || typeof canvas.data !== 'object' || !canvas.data) continue
    const name = canvas.name.slice(0, MAX_NAME_LENGTH)
    const serialised = JSON.stringify(canvas.data)
    if (serialised.length > MAX_CANVAS_BYTES) continue

    const id = crypto.randomUUID()
    const r2_key = `canvases/${id}.json`
    await c.env.STORAGE.put(r2_key, serialised, {
      httpMetadata: { contentType: 'application/json' },
    })
    await c.env.DB.prepare(
      'INSERT INTO canvases (id, workspace_id, name, r2_key, position, is_empty) VALUES (?, ?, ?, ?, ?, 0)'
    ).bind(id, workspace.id, name, r2_key, position).run()
    position++
  }

  return c.json({ ok: true, workspaceId: workspace.id })
})

export default app
