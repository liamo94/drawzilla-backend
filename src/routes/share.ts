import { Hono } from 'hono'
import { requireAuth, type AuthVariables } from '../middleware/auth'
import type { Env, DBShare, DBCanvas, DBWorkspace, CanvasData } from '../types'
import { verifyPassword, generateAccessToken, verifyAccessToken } from '../utils/crypto'

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const TOKEN_RE = /^[0-9a-f]{16}$/

async function checkAccessToken(c: { req: { header: (k: string) => string | undefined } }, shareToken: string, secret: string): Promise<boolean> {
  const token = c.req.header('X-Access-Token')
  if (!token) return false
  return verifyAccessToken(shareToken, token, secret)
}

// GET /share/:token — single canvas (frozen snapshot or live)
app.get('/:token', async (c) => {
  const { token } = c.req.param()
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404)

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.RATE_LIMITER.limit({ key: `share-read:${ip}` })
  if (!success) return c.json({ error: 'Too many requests' }, 429)

  const now = Math.floor(Date.now() / 1000)

  // Query without expiry filter so we can distinguish not-found vs expired
  const share = await c.env.DB.prepare(
    'SELECT * FROM shares WHERE token = ?'
  ).bind(token).first<DBShare>()

  if (!share) return c.json({ error: 'Not found' }, 404)

  if (share.expires_at !== null && share.expires_at <= now) {
    return c.json({ error: 'Expired', expired: true }, 410)
  }

  if (share.password_hash) {
    const ok = await checkAccessToken(c, token, c.env.ADMIN_SECRET)
    if (!ok) return c.json({ error: 'Password required', password_required: true }, 401)
  }

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

// POST /share/:token/unlock — verify password, return access token
app.post('/:token/unlock', async (c) => {
  const { token } = c.req.param()
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404)

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.RATE_LIMITER.limit({ key: `share-unlock:${ip}` })
  if (!success) return c.json({ error: 'Too many requests' }, 429)

  const now = Math.floor(Date.now() / 1000)

  const share = await c.env.DB.prepare(
    'SELECT token, expires_at, password_hash FROM shares WHERE token = ?'
  ).bind(token).first<Pick<DBShare, 'token' | 'expires_at' | 'password_hash'>>()

  if (!share) return c.json({ error: 'Not found' }, 404)
  if (share.expires_at !== null && share.expires_at <= now) {
    return c.json({ error: 'Expired', expired: true }, 410)
  }
  if (!share.password_hash) return c.json({ error: 'No password set' }, 400)

  const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }))
  if (!body.password) return c.json({ error: 'Password required' }, 400)

  const valid = await verifyPassword(body.password, share.password_hash)
  if (!valid) return c.json({ error: 'Incorrect password' }, 401)

  const accessToken = await generateAccessToken(token, c.env.ADMIN_SECRET)
  return c.json({ access_token: accessToken })
})

// GET /share/workspace/:token — all canvases in a workspace (Pro live link)
app.get('/workspace/:token', async (c) => {
  const { token } = c.req.param()
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404)

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.RATE_LIMITER.limit({ key: `share-read:${ip}` })
  if (!success) return c.json({ error: 'Too many requests' }, 429)

  const now = Math.floor(Date.now() / 1000)

  const workspace = await c.env.DB.prepare(
    'SELECT * FROM workspaces WHERE share_token = ? AND share_enabled = 1'
  ).bind(token).first<DBWorkspace>()
  if (!workspace) return c.json({ error: 'Not found' }, 404)

  if (workspace.share_expires_at !== null && workspace.share_expires_at <= now) {
    return c.json({ error: 'Expired', expired: true }, 410)
  }

  if (workspace.share_password_hash) {
    const ok = await checkAccessToken(c, token, c.env.ADMIN_SECRET)
    if (!ok) return c.json({ error: 'Password required', password_required: true }, 401)
  }

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
  return c.json({
    type: 'workspace',
    name: workspace.name,
    canvases: canvasData,
    slides: workspace.slides_json ? JSON.parse(workspace.slides_json) : undefined,
    expires_at: workspace.share_expires_at,
    has_password: workspace.share_password_hash !== null,
  })
})

// POST /share/workspace/:token/unlock — verify password for workspace share
app.post('/workspace/:token/unlock', async (c) => {
  const { token } = c.req.param()
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404)

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.RATE_LIMITER.limit({ key: `share-unlock:${ip}` })
  if (!success) return c.json({ error: 'Too many requests' }, 429)

  const now = Math.floor(Date.now() / 1000)

  const workspace = await c.env.DB.prepare(
    'SELECT share_token, share_expires_at, share_password_hash FROM workspaces WHERE share_token = ? AND share_enabled = 1'
  ).bind(token).first<{ share_token: string; share_expires_at: number | null; share_password_hash: string | null }>()

  if (!workspace) return c.json({ error: 'Not found' }, 404)
  if (workspace.share_expires_at !== null && workspace.share_expires_at <= now) {
    return c.json({ error: 'Expired', expired: true }, 410)
  }
  if (!workspace.share_password_hash) return c.json({ error: 'No password set' }, 400)

  const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }))
  if (!body.password) return c.json({ error: 'Password required' }, 400)

  const valid = await verifyPassword(body.password, workspace.share_password_hash)
  if (!valid) return c.json({ error: 'Incorrect password' }, 401)

  const accessToken = await generateAccessToken(token, c.env.ADMIN_SECRET)
  return c.json({ access_token: accessToken })
})

// POST /share/presentation/:token/unlock — verify password for presentation share
app.post('/presentation/:token/unlock', async (c) => {
  const { token } = c.req.param()
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404)

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.RATE_LIMITER.limit({ key: `share-unlock:${ip}` })
  if (!success) return c.json({ error: 'Too many requests' }, 429)

  const workspace = await c.env.DB.prepare(
    'SELECT presentation_share_password_hash FROM workspaces WHERE presentation_share_token = ? AND presentation_share_enabled = 1'
  ).bind(token).first<{ presentation_share_password_hash: string | null }>()

  if (!workspace) return c.json({ error: 'Not found' }, 404)
  if (!workspace.presentation_share_password_hash) return c.json({ error: 'No password set' }, 400)

  const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }))
  if (!body.password) return c.json({ error: 'Password required' }, 400)

  const valid = await verifyPassword(body.password, workspace.presentation_share_password_hash)
  if (!valid) return c.json({ error: 'Incorrect password' }, 401)

  const accessToken = await generateAccessToken(token, c.env.ADMIN_SECRET)
  return c.json({ access_token: accessToken })
})

// GET /share/presentation/:token — slides only, just the canvases referenced by slides
app.get('/presentation/:token', async (c) => {
  const { token } = c.req.param()
  if (!TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404)

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.RATE_LIMITER.limit({ key: `share-read:${ip}` })
  if (!success) return c.json({ error: 'Too many requests' }, 429)

  const workspace = await c.env.DB.prepare(
    'SELECT id, name, slides_json, presentation_share_password_hash FROM workspaces WHERE presentation_share_token = ? AND presentation_share_enabled = 1'
  ).bind(token).first<{ id: string; name: string; slides_json: string | null; presentation_share_password_hash: string | null }>()
  if (!workspace) return c.json({ error: 'Not found' }, 404)

  if (workspace.presentation_share_password_hash) {
    const ok = await checkAccessToken(c, token, c.env.ADMIN_SECRET)
    if (!ok) return c.json({ error: 'Password required', password_required: true }, 401)
  }

  const slides: { canvasId?: string }[] = workspace.slides_json ? JSON.parse(workspace.slides_json) : []
  if (slides.length === 0) return c.json({ error: 'No slides' }, 404)

  const canvasIds = [...new Set(slides.map(s => s.canvasId).filter((id): id is string => !!id))].slice(0, 20)

  let canvasData: { id: string; name: string; position: number; data: CanvasData }[] = []
  if (canvasIds.length > 0) {
    const placeholders = canvasIds.map(() => '?').join(',')
    const { results: canvases } = await c.env.DB.prepare(
      `SELECT id, name, r2_key, position FROM canvases WHERE id IN (${placeholders}) AND workspace_id = ?`
    ).bind(...canvasIds, workspace.id).all<Pick<DBCanvas, 'id' | 'name' | 'r2_key' | 'position'>>()

    canvasData = await Promise.all(
      canvases.map(async canvas => {
        const obj = await c.env.STORAGE.get(canvas.r2_key)
        const data = obj ? await obj.json<CanvasData>() : { strokes: [], view: { x: 0, y: 0, scale: 1 } }
        return { id: canvas.id, name: canvas.name, position: canvas.position, data }
      })
    )
  }

  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE workspaces SET view_count = view_count + 1 WHERE id = ?').bind(workspace.id).run()
  )

  c.header('Cache-Control', 'no-store')
  return c.json({ type: 'presentation', name: workspace.name, slides, canvases: canvasData })
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
