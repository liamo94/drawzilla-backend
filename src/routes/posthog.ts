import { Hono } from 'hono'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()

const POSTHOG_HOST = 'https://eu.i.posthog.com'

app.all('/*', async (c) => {
  const url = new URL(c.req.url)
  const target = `${POSTHOG_HOST}${c.req.path}${url.search}`
  const res = await fetch(target, {
    method: c.req.method,
    headers: { 'Content-Type': c.req.header('Content-Type') ?? 'application/json' },
    body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? await c.req.arrayBuffer() : undefined,
  })
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  })
})

export default app
