import type { Env } from '../types'

const BACKUP_PREFIX = 'backups/'
const KEEP_DAYS = 7

export async function backupDatabase(env: Env) {
  const [users, workspaces, canvases, subscriptions, shares] = await Promise.all([
    env.DB.prepare('SELECT * FROM users').all(),
    env.DB.prepare('SELECT * FROM workspaces').all(),
    env.DB.prepare('SELECT * FROM canvases').all(),
    env.DB.prepare('SELECT * FROM subscriptions').all(),
    env.DB.prepare('SELECT * FROM shares').all(),
  ])

  const snapshot = {
    createdAt: new Date().toISOString(),
    tables: {
      users: users.results,
      workspaces: workspaces.results,
      canvases: canvases.results,
      subscriptions: subscriptions.results,
      shares: shares.results,
    },
  }

  const date = new Date().toISOString().slice(0, 10)
  await env.STORAGE.put(
    `${BACKUP_PREFIX}${date}.json`,
    JSON.stringify(snapshot),
    { httpMetadata: { contentType: 'application/json' } }
  )

  // Prune backups older than KEEP_DAYS
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS)

  const toDelete: string[] = []
  let cursor: string | undefined
  do {
    const list = await env.STORAGE.list({ prefix: BACKUP_PREFIX, cursor })
    for (const obj of list.objects) {
      if (new Date(obj.uploaded) < cutoff) toDelete.push(obj.key)
    }
    cursor = list.truncated ? list.cursor : undefined
  } while (cursor)

  await Promise.all(toDelete.map(key => env.STORAGE.delete(key)))
}
