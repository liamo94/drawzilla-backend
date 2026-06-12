import { Hono } from 'hono'
import type { Env } from '../types'

const app = new Hono<{ Bindings: Env }>()

const POSTHOG_HOST = 'https://eu.i.posthog.com'
const MAX_POSTHOG_BYTES = 256_000 // 256 KB

app.all('/*', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  const { success } = await c.env.RATE_LIMITER.limit({ key: `posthog:${ip}` })
  if (!success) return new Response('Too many requests', { status: 429 })

  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const contentLength = parseInt(c.req.header('content-length') ?? '0')
    if (contentLength > MAX_POSTHOG_BYTES) return new Response('Payload too large', { status: 413 })
  }

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
