import { Hono } from 'hono'
import { requireAuth, type AuthVariables } from '../middleware/auth'
import type { Env, DBCanvas, CanvasData } from '../types'
import { generateShareToken } from '../utils/token'

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

app.use('*', requireAuth)

const MAX_CANVAS_BYTES = 20_000_000 // 20 MB — accommodates embedded base64 images
const CANVAS_HARD_CAP = 9

app.post('/', async (c) => {
  const clerkId = c.get('clerkId')
  const { workspaceId, name } = await c.req.json<{ workspaceId: string; name?: string }>()

  const [workspaceResult, countResult, userResult] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id FROM workspaces WHERE id = ? AND user_id = ?').bind(workspaceId, clerkId),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM canvases WHERE workspace_id = ?').bind(workspaceId),
    c.env.DB.prepare('SELECT plan FROM users WHERE clerk_id = ?').bind(clerkId),
  ])

  if (!workspaceResult.results[0]) return c.json({ error: 'Workspace not found' }, 404)
  const count = (countResult.results[0] as { count: number } | undefined)?.count ?? 0
  const isPro = (userResult.results[0] as { plan: string } | undefined)?.plan === 'pro'

  if (!isPro && count >= 3) return c.json({ error: 'Pro required for more than 3 cloud canvases' }, 403)
  if (count >= CANVAS_HARD_CAP) return c.json({ error: 'Canvas limit reached' }, 403)

  const id = crypto.randomUUID()
  const r2_key = `canvases/${id}.json`
  const canvasName = name ?? `Canvas ${count + 1}`
  const empty: CanvasData = { strokes: [], view: { x: 0, y: 0, scale: 1 } }

  await c.env.STORAGE.put(r2_key, JSON.stringify(empty), {
    httpMetadata: { contentType: 'application/json' },
  })
  await c.env.DB.prepare(
    'INSERT INTO canvases (id, workspace_id, name, r2_key, position) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, workspaceId, canvasName, r2_key, count).run()

  return c.json({ id, name: canvasName }, 201)
})

app.post('/reorder', async (c) => {
  const clerkId = c.get('clerkId')
  const { ids } = await c.req.json<{ ids: string[] }>()
  if (!Array.isArray(ids) || ids.length === 0) return c.json({ error: 'ids required' }, 400)
  if (ids.length > CANVAS_HARD_CAP) return c.json({ error: 'Too many ids' }, 400)

  const placeholders = ids.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.workspace_id FROM canvases c
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id IN (${placeholders}) AND w.user_id = ?`
  ).bind(...ids, clerkId).all<{ id: string; workspace_id: string }>()

  if (results.length !== ids.length) return c.json({ error: 'Not found' }, 404)

  const workspaceIds = new Set(results.map(r => r.workspace_id))
  if (workspaceIds.size > 1) return c.json({ error: 'All canvases must belong to the same workspace' }, 400)

  await c.env.DB.batch(
    ids.map((id, i) => c.env.DB.prepare('UPDATE canvases SET position = ? WHERE id = ?').bind(i, id))
  )

  return c.json({ ok: true })
})

app.get('/:id/shares', async (c) => {
  const clerkId = c.get('clerkId')
  const { id } = c.req.param()
  const now = Math.floor(Date.now() / 1000)

  const canvas = await c.env.DB.prepare(
    `SELECT c.id FROM canvases c
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ? AND w.user_id = ?`
  ).bind(id, clerkId).first()
  if (!canvas) return c.json({ error: 'Not found' }, 404)

  const { results } = await c.env.DB.prepare(
    'SELECT token, type, expires_at, created_at FROM shares WHERE canvas_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC'
  ).bind(id, now).all<{ token: string; type: string; expires_at: number | null; created_at: number }>()

  return c.json(results)
})

app.get('/:id', async (c) => {
  const clerkId = c.get('clerkId')
  const { id } = c.req.param()

  const canvas = await c.env.DB.prepare(
    `SELECT c.* FROM canvases c
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ? AND w.user_id = ?`
  ).bind(id, clerkId).first<DBCanvas>()
  if (!canvas) return c.json({ error: 'Not found' }, 404)

  const obj = await c.env.STORAGE.get(canvas.r2_key)
  if (!obj) return c.json({ error: 'Canvas data missing' }, 404)

  const data = await obj.json<CanvasData>()
  const { r2_key: _, workspace_id: __, ...meta } = canvas
  return c.json({ ...meta, data })
})

app.put('/:id', async (c) => {
  const clerkId = c.get('clerkId')
  const { id } = c.req.param()

  const contentLength = parseInt(c.req.header('content-length') ?? '0')
  if (contentLength > MAX_CANVAS_BYTES) return c.json({ error: 'Payload too large' }, 413)

  const canvas = await c.env.DB.prepare(
    `SELECT c.r2_key FROM canvases c
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ? AND w.user_id = ?`
  ).bind(id, clerkId).first<{ r2_key: string }>()
  if (!canvas) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.text()
  if (body.length > MAX_CANVAS_BYTES) return c.json({ error: 'Payload too large' }, 413)

  let strokeCount = 0
  try { strokeCount = (JSON.parse(body) as CanvasData).strokes.length } catch {}

  await c.env.STORAGE.put(canvas.r2_key, body, {
    httpMetadata: { contentType: 'application/json' },
  })
  await c.env.DB.prepare(
    'UPDATE canvases SET updated_at = ?, is_empty = 0, stroke_count = ? WHERE id = ?'
  ).bind(Math.floor(Date.now() / 1000), strokeCount, id).run()

  return c.json({ ok: true })
})

app.patch('/:id', async (c) => {
  const clerkId = c.get('clerkId')
  const { id } = c.req.param()
  const { name } = await c.req.json<{ name: string }>()
  if (typeof name !== 'string') return c.json({ error: 'Invalid name' }, 400)

  const result = await c.env.DB.prepare(
    `UPDATE canvases SET name = ?
     WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id = ?)`
  ).bind(name.slice(0, 200), id, clerkId).run()

  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

app.delete('/:id', async (c) => {
  const clerkId = c.get('clerkId')
  const { id } = c.req.param()

  const canvas = await c.env.DB.prepare(
    `SELECT c.r2_key FROM canvases c
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ? AND w.user_id = ?`
  ).bind(id, clerkId).first<{ r2_key: string }>()
  if (!canvas) return c.json({ error: 'Not found' }, 404)

  const { results: frozenShares } = await c.env.DB.prepare(
    `SELECT r2_key FROM shares WHERE canvas_id = ? AND type = 'frozen' AND r2_key IS NOT NULL`
  ).bind(id).all<{ r2_key: string }>()

  await Promise.all([
    c.env.STORAGE.delete(canvas.r2_key),
    ...frozenShares.map(s => c.env.STORAGE.delete(s.r2_key)),
  ])
  await c.env.DB.prepare('DELETE FROM canvases WHERE id = ?').bind(id).run()

  return c.json({ ok: true })
})

app.post('/:id/share', async (c) => {
  const clerkId = c.get('clerkId')
  const { id } = c.req.param()
  const now = Math.floor(Date.now() / 1000)

  const canvas = await c.env.DB.prepare(
    `SELECT c.id, c.r2_key FROM canvases c
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ? AND w.user_id = ?`
  ).bind(id, clerkId).first<{ id: string; r2_key: string }>()
  if (!canvas) return c.json({ error: 'Not found' }, 404)

  const user = await c.env.DB.prepare(
    'SELECT plan FROM users WHERE clerk_id = ?'
  ).bind(clerkId).first<{ plan: string }>()
  const isPro = user?.plan === 'pro'

  if (isPro) {
    // Upsert — reuse existing live share for this canvas if one exists
    const existing = await c.env.DB.prepare(
      "SELECT token FROM shares WHERE canvas_id = ? AND type = 'live'"
    ).bind(id).first<{ token: string }>()

    const token = existing?.token ?? generateShareToken()
    if (!existing) {
      await c.env.DB.prepare('INSERT INTO shares (token, canvas_id, type) VALUES (?, ?, ?)')
        .bind(token, id, 'live').run()
    }
    return c.json({ token, url: `https://drawzil.la/s/${token}`, type: 'live', expires_at: null, created_at: now })
  } else {
    // Free: frozen snapshot, expires in 7 days, hard cap of 100 active per canvas
    const countRow = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM shares WHERE canvas_id = ? AND (expires_at IS NULL OR expires_at > ?)'
    ).bind(id, now).first<{ count: number }>()
    if ((countRow?.count ?? 0) >= 100) return c.json({ error: 'Share limit reached' }, 429)

    const obj = await c.env.STORAGE.get(canvas.r2_key)
    if (!obj) return c.json({ error: 'Canvas data missing' }, 404)
    const canvasData = await obj.text()

    const token = generateShareToken()
    const shareR2Key = `shares/${token}.json`
    const expiresAt = now + 7 * 24 * 60 * 60

    await c.env.STORAGE.put(shareR2Key, canvasData, {
      httpMetadata: { contentType: 'application/json' },
    })
    await c.env.DB.prepare(
      'INSERT INTO shares (token, canvas_id, type, r2_key, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(token, id, 'frozen', shareR2Key, expiresAt).run()

    return c.json({ token, url: `https://drawzil.la/s/${token}`, type: 'frozen', expires_at: expiresAt, created_at: now })
  }
})

app.delete('/:id/share/:token', async (c) => {
  const clerkId = c.get('clerkId')
  const { id, token } = c.req.param()

  const share = await c.env.DB.prepare(
    `SELECT s.token, s.r2_key, s.type FROM shares s
     JOIN canvases c ON c.id = s.canvas_id
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE s.token = ? AND s.canvas_id = ? AND w.user_id = ?`
  ).bind(token, id, clerkId).first<{ token: string; r2_key: string | null; type: string }>()
  if (!share) return c.json({ error: 'Not found' }, 404)

  if (share.type === 'frozen' && share.r2_key) {
    await c.env.STORAGE.delete(share.r2_key)
  }
  await c.env.DB.prepare('DELETE FROM shares WHERE token = ?').bind(token).run()
  return c.json({ ok: true })
})

export default app
