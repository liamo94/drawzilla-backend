import { Hono } from 'hono'
import { requireAuth, type AuthVariables } from '../middleware/auth'
import type { Env, DBShare, DBCanvas, DBWorkspace, CanvasData } from '../types'

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const TOKEN_RE = /^[0-9a-f]{16}$/

// GET /share/:token — single canvas (frozen snapshot or live)
app.get('/:token', async (c) => {
  const { token } = c.req.param()
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404)

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.RATE_LIMITER.limit({ key: `share-read:${ip}` })
  if (!success) return c.json({ error: 'Too many requests' }, 429)

  const now = Math.floor(Date.now() / 1000)

  const share = await c.env.DB.prepare(
    'SELECT * FROM shares WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)'
  ).bind(token, now).first<DBShare>()
  if (!share) return c.json({ error: 'Not found' }, 404)

  const expiresAt = share.expires_at ?? null

  let canvasData: CanvasData
  let canvasName: string

  if (share.type === 'frozen') {
    const obj = await c.env.STORAGE.get(share.r2_key!)
    if (!obj) return c.json({ error: 'Canvas data missing' }, 404)
    canvasData = await obj.json<CanvasData>()
    const row = await c.env.DB.prepare('SELECT name FROM canvases WHERE id = ?')
      .bind(share.canvas_id).first<{ name: string }>()
    canvasName = row?.name ?? 'Canvas'
  } else {
    const canvas = await c.env.DB.prepare('SELECT name, r2_key FROM canvases WHERE id = ?')
      .bind(share.canvas_id).first<DBCanvas>()
    if (!canvas) return c.json({ error: 'Not found' }, 404)
    const obj = await c.env.STORAGE.get(canvas.r2_key)
    if (!obj) return c.json({ error: 'Canvas data missing' }, 404)
    canvasData = await obj.json<CanvasData>()
    canvasName = canvas.name
  }

  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE shares SET view_count = view_count + 1 WHERE token = ?').bind(token).run()
  )

  if (share.type === 'frozen') {
    c.header('Cache-Control', 'public, max-age=3600')
  } else {
    c.header('Cache-Control', 'no-store')
  }
  return c.json({ type: 'canvas', name: canvasName, data: canvasData, expires_at: expiresAt })
})

// GET /share/workspace/:token — all canvases in a workspace (Pro live link)
app.get('/workspace/:token', async (c) => {
  const { token } = c.req.param()
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404)

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.RATE_LIMITER.limit({ key: `share-read:${ip}` })
  if (!success) return c.json({ error: 'Too many requests' }, 429)

  const workspace = await c.env.DB.prepare(
    'SELECT * FROM workspaces WHERE share_token = ? AND share_enabled = 1'
  ).bind(token).first<DBWorkspace>()
  if (!workspace) return c.json({ error: 'Not found' }, 404)

  const { results: canvases } = await c.env.DB.prepare(
    'SELECT id, name, r2_key, position FROM canvases WHERE workspace_id = ? ORDER BY position ASC'
  ).bind(workspace.id).all<Pick<DBCanvas, 'id' | 'name' | 'r2_key' | 'position'>>()

  const canvasData = await Promise.all(
    canvases.map(async canvas => {
      const obj = await c.env.STORAGE.get(canvas.r2_key)
      const data = obj ? await obj.json<CanvasData>() : { strokes: [], view: { x: 0, y: 0, scale: 1 } }
      return { id: canvas.id, name: canvas.name, position: canvas.position, data }
    })
  )

  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE workspaces SET view_count = view_count + 1 WHERE id = ?').bind(workspace.id).run()
  )

  c.header('Cache-Control', 'no-store')
  return c.json({ type: 'workspace', name: workspace.name, canvases: canvasData })
})

// DELETE /share/:token — revoke a share (auth required, must own the canvas)
app.delete('/:token', requireAuth, async (c) => {
  const clerkId = c.get('clerkId')
  const { token } = c.req.param()
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404)

  const share = await c.env.DB.prepare(
    `SELECT s.token, s.r2_key, s.type FROM shares s
     JOIN canvases c ON c.id = s.canvas_id
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE s.token = ? AND w.user_id = ?`
  ).bind(token, clerkId).first<{ token: string; r2_key: string | null; type: string }>()
  if (!share) return c.json({ error: 'Not found' }, 404)

  if (share.type === 'frozen' && share.r2_key) {
    await c.env.STORAGE.delete(share.r2_key)
  }
  await c.env.DB.prepare('DELETE FROM shares WHERE token = ?').bind(token).run()
  return c.json({ ok: true })
})

export default app
