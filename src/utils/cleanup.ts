import type { Env } from '../types'
import { stashKey } from '../routes/stash'

export async function deleteUserCompletely(env: Env, clerkId: string) {
  const [{ results: canvases }, { results: frozenShares }] = await Promise.all([
    env.DB.prepare(
      `SELECT c.r2_key FROM canvases c
       JOIN workspaces w ON w.id = c.workspace_id
       WHERE w.user_id = ?`
    ).bind(clerkId).all<{ r2_key: string }>(),
    env.DB.prepare(
      `SELECT sh.r2_key FROM shares sh
       JOIN canvases c ON c.id = sh.canvas_id
       JOIN workspaces w ON w.id = c.workspace_id
       WHERE sh.type = 'frozen' AND sh.r2_key IS NOT NULL AND w.user_id = ?`
    ).bind(clerkId).all<{ r2_key: string }>(),
  ])

  await Promise.all([
    ...canvases.map(c => env.STORAGE.delete(c.r2_key)),
    ...frozenShares.map(s => env.STORAGE.delete(s.r2_key)),
    env.STORAGE.delete(stashKey(clerkId)),
  ])

  await env.DB.batch([
    env.DB.prepare('DELETE FROM workspaces WHERE user_id = ?').bind(clerkId),
    env.DB.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(clerkId),
    env.DB.prepare('DELETE FROM users WHERE clerk_id = ?').bind(clerkId),
  ])
}

export async function cleanupExpiredShares(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  const { results: expired } = await env.DB.prepare(
    'SELECT token, r2_key FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?'
  ).bind(now).all<{ token: string; r2_key: string | null }>()

  if (expired.length === 0) return

  const r2Keys = expired.filter(s => s.r2_key).map(s => s.r2_key!)
  const tokens = expired.map(s => s.token)
  const placeholders = tokens.map(() => '?').join(',')

  await Promise.all(r2Keys.map(key => env.STORAGE.delete(key)))
  await env.DB.prepare(`DELETE FROM shares WHERE token IN (${placeholders})`).bind(...tokens).run()
}

export async function cleanupUserData(env: Env, userIds: string[]) {
  if (userIds.length === 0) return

  const placeholders = userIds.map(() => '?').join(',')

  const [{ results: canvases }, { results: frozenShares }] = await Promise.all([
    env.DB.prepare(
      `SELECT c.r2_key FROM canvases c
       JOIN workspaces w ON w.id = c.workspace_id
       WHERE w.user_id IN (${placeholders})`
    ).bind(...userIds).all<{ r2_key: string }>(),
    env.DB.prepare(
      `SELECT sh.r2_key FROM shares sh
       JOIN canvases c ON c.id = sh.canvas_id
       JOIN workspaces w ON w.id = c.workspace_id
       WHERE sh.type = 'frozen' AND sh.r2_key IS NOT NULL
       AND w.user_id IN (${placeholders})`
    ).bind(...userIds).all<{ r2_key: string }>(),
  ])

  await Promise.all([
    ...canvases.map(c => env.STORAGE.delete(c.r2_key)),
    ...frozenShares.map(s => env.STORAGE.delete(s.r2_key)),
    ...userIds.map(id => env.STORAGE.delete(stashKey(id))),
  ])

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM workspaces WHERE user_id IN (${placeholders})`).bind(...userIds),
    env.DB.prepare(`DELETE FROM subscriptions WHERE user_id IN (${placeholders})`).bind(...userIds),
    env.DB.prepare(`UPDATE users SET plan = 'free' WHERE clerk_id IN (${placeholders})`).bind(...userIds),
  ])

  await env.DB.batch(
    userIds.map(id =>
      env.DB.prepare('INSERT INTO workspaces (id, user_id, name, position) VALUES (?, ?, ?, ?)')
        .bind(crypto.randomUUID(), id, 'My Workspace', 0)
    )
  )
}

export async function cleanupExpiredSubscriptions(env: Env) {
  const now = Math.floor(Date.now() / 1000)
  const { results: expired } = await env.DB.prepare(
    `SELECT s.user_id FROM subscriptions s
     JOIN users u ON u.clerk_id = s.user_id
     WHERE s.status = 'cancelling' AND s.cancel_at < ? AND u.gifted = 0`
  ).bind(now).all<{ user_id: string }>()

  await cleanupUserData(env, expired.map(r => r.user_id))
}
