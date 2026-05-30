import { Hono } from 'hono'
import { requireAuth, type AuthVariables } from '../middleware/auth'
import type { Env, DBWorkspace, CanvasData } from '../types'
import { generateShareToken } from '../utils/token'

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

app.use('*', requireAuth)

app.get('/shared', async (c) => {
  const clerkId = c.get('clerkId')
  const now = Math.floor(Date.now() / 1000)

  const { results: workspaces } = await c.env.DB.prepare(
    `SELECT id, name, share_token as token FROM workspaces
     WHERE user_id = ? AND share_enabled = 1 ORDER BY position ASC`
  ).bind(clerkId).all<{ id: string; name: string; token: string }>()

  const { results: canvases } = await c.env.DB.prepare(
    `SELECT s.token, s.type, c.id as canvas_id, c.name as canvas_name,
            w.id as workspace_id, w.name as workspace_name
     FROM shares s
     JOIN canvases c ON c.id = s.canvas_id
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE w.user_id = ? AND (s.expires_at IS NULL OR s.expires_at > ?)
     ORDER BY s.created_at DESC`
  ).bind(clerkId, now).all<{
    token: string; type: string;
    canvas_id: string; canvas_name: string;
    workspace_id: string; workspace_name: string;
  }>()

  return c.json({ workspaces, canvases })
})

app.get('/', async (c) => {
  const clerkId = c.get('clerkId')
  const { results: workspaces } = await c.env.DB.prepare(
    'SELECT id, user_id, name, position, share_token, share_enabled, created_at FROM workspaces WHERE user_id = ? ORDER BY position ASC'
  ).bind(clerkId).all<DBWorkspace>()

  if (workspaces.length === 0) return c.json([])

  const placeholders = workspaces.map(() => '?').join(',')
  const { results: canvases } = await c.env.DB.prepare(
    `SELECT id, workspace_id, name, position, updated_at, is_empty, stroke_count FROM canvases
     WHERE workspace_id IN (${placeholders}) ORDER BY position ASC`
  ).bind(...workspaces.map(w => w.id)).all<{
    id: string; workspace_id: string; name: string; position: number; updated_at: number; is_empty: number; stroke_count: number
  }>()

  return c.json(workspaces.map(w => ({
    ...w,
    canvases: canvases.filter(c => c.workspace_id === w.id),
  })))
})

const EXPORT_CANVAS_CAP = 50

app.get('/export', async (c) => {
  const clerkId = c.get('clerkId')

  const { results: workspaces } = await c.env.DB.prepare(
    'SELECT id, name FROM workspaces WHERE user_id = ? ORDER BY position ASC'
  ).bind(clerkId).all<{ id: string; name: string }>()

  if (workspaces.length === 0) return c.json({ workspaces: [] })

  const placeholders = workspaces.map(() => '?').join(',')
  const { results: canvases } = await c.env.DB.prepare(
    `SELECT id, workspace_id, name, r2_key FROM canvases
     WHERE workspace_id IN (${placeholders}) ORDER BY position ASC
     LIMIT ${EXPORT_CANVAS_CAP}`
  ).bind(...workspaces.map(w => w.id)).all<{ id: string; workspace_id: string; name: string; r2_key: string }>()

  const blobs = await Promise.all(canvases.map(canvas => c.env.STORAGE.get(canvas.r2_key)))

  const canvasData = await Promise.all(canvases.map(async (canvas, i) => {
    const data: CanvasData = blobs[i]
      ? await blobs[i]!.json<CanvasData>()
      : { strokes: [], view: { x: 0, y: 0, scale: 1 } }
    return { ...canvas, data }
  }))

  return c.json({
    workspaces: workspaces.map(ws => ({
      name: ws.name,
      canvases: canvasData
        .filter(c => c.workspace_id === ws.id)
        .map(({ name, data }) => ({ name, ...data })),
    })),
  })
})

app.post('/', async (c) => {
  const clerkId = c.get('clerkId')

  const user = await c.env.DB.prepare(
    'SELECT plan FROM users WHERE clerk_id = ?'
  ).bind(clerkId).first<{ plan: string }>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  if (user.plan === 'free') {
    const { results } = await c.env.DB.prepare(
      'SELECT id FROM workspaces WHERE user_id = ?'
    ).bind(clerkId).all()
    if (results.length >= 1) return c.json({ error: 'Pro required for multiple workspaces' }, 403)
  }

  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }))
  const { results: existing } = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM workspaces WHERE user_id = ?'
  ).bind(clerkId).all<{ count: number }>()
  const count = existing[0]?.count ?? 0

  const id = crypto.randomUUID()
  const workspaceName = name ?? `Workspace ${count + 1}`

  await c.env.DB.prepare(
    'INSERT INTO workspaces (id, user_id, name, position) VALUES (?, ?, ?, ?)'
  ).bind(id, clerkId, workspaceName, count).run()

  return c.json({ id, name: workspaceName }, 201)
})

app.patch('/:id', async (c) => {
  const clerkId = c.get('clerkId')
  const { id } = c.req.param()
  const { name } = await c.req.json<{ name: string }>()
  if (typeof name !== 'string') return c.json({ error: 'Invalid name' }, 400)

  const result = await c.env.DB.prepare(
    'UPDATE workspaces SET name = ? WHERE id = ? AND user_id = ?'
  ).bind(name.slice(0, 200), id, clerkId).run()

  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

app.delete('/:id', async (c) => {
  const clerkId = c.get('clerkId')
  const { id } = c.req.param()

  // Verify ownership before touching R2
  const workspace = await c.env.DB.prepare(
    'SELECT id FROM workspaces WHERE id = ? AND user_id = ?'
  ).bind(id, clerkId).first<{ id: string }>()
  if (!workspace) return c.json({ error: 'Not found' }, 404)

  const [{ results: canvases }, { results: frozenShares }] = await Promise.all([
    c.env.DB.prepare('SELECT r2_key FROM canvases WHERE workspace_id = ?').bind(id).all<{ r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT sh.r2_key FROM shares sh
       JOIN canvases c ON c.id = sh.canvas_id
       WHERE c.workspace_id = ? AND sh.type = 'frozen' AND sh.r2_key IS NOT NULL`
    ).bind(id).all<{ r2_key: string }>(),
  ])
  await Promise.all([
    ...canvases.map(r => c.env.STORAGE.delete(r.r2_key)),
    ...frozenShares.map(s => c.env.STORAGE.delete(s.r2_key)),
  ])

  await c.env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(id).run()

  return c.json({ ok: true })
})

app.post('/:id/share', async (c) => {
  const clerkId = c.get('clerkId')
  const { id } = c.req.param()

  const { success } = await c.env.RATE_LIMITER.limit({ key: `${clerkId}:share` })
  if (!success) return c.json({ error: 'Too many requests' }, 429)

  const user = await c.env.DB.prepare(
    'SELECT plan FROM users WHERE clerk_id = ?'
  ).bind(clerkId).first<{ plan: string }>()
  if (user?.plan !== 'pro') return c.json({ error: 'Pro required' }, 403)

  const workspace = await c.env.DB.prepare(
    'SELECT id, share_token FROM workspaces WHERE id = ? AND user_id = ?'
  ).bind(id, clerkId).first<{ id: string; share_token: string | null }>()
  if (!workspace) return c.json({ error: 'Not found' }, 404)

  const token = workspace.share_token ?? generateShareToken()
  await c.env.DB.prepare(
    'UPDATE workspaces SET share_token = ?, share_enabled = 1 WHERE id = ?'
  ).bind(token, id).run()

  return c.json({ token, url: `https://drawzil.la/s/w/${token}` })
})

app.delete('/:id/share', async (c) => {
  const clerkId = c.get('clerkId')
  const { id } = c.req.param()

  const result = await c.env.DB.prepare(
    'UPDATE workspaces SET share_enabled = 0 WHERE id = ? AND user_id = ?'
  ).bind(id, clerkId).run()

  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

export default app
