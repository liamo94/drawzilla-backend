import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { withSentry } from '@sentry/cloudflare'
import type { Env } from './types'
import workspacesRoute from './routes/workspaces'
import canvasesRoute from './routes/canvases'
import shareRoute from './routes/share'
import migrateRoute from './routes/migrate'
import stripeWebhook from './routes/webhooks/stripe'
import clerkWebhook from './routes/webhooks/clerk'
import stripeRoutes from './routes/stripe'
import stashRoute from './routes/stash'
import preferencesRoute from './routes/preferences'
import adminRoute from './routes/admin'
import { cleanupExpiredShares, cleanupExpiredSubscriptions } from './utils/cleanup'
import { backupDatabase } from './utils/backup'

const app = new Hono<{ Bindings: Env }>()

app.use(
  '*',
  cors({
    origin: origin => {
      const allowed = [
        'https://drawzil.la',
        'https://www.drawzil.la',
        'https://unleash.drawzil.la',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
      ]
      return allowed.includes(origin) ? origin : null
    },
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
)

app.route('/workspaces', workspacesRoute)
app.route('/canvases', canvasesRoute)
app.route('/share', shareRoute)
app.route('/migrate', migrateRoute)
app.route('/stripe', stripeWebhook)
app.route('/stripe', stripeRoutes)
app.route('/stash', stashRoute)
app.route('/preferences', preferencesRoute)
app.route('/clerk', clerkWebhook)
app.route('/admin', adminRoute)


export default withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0,
  }),
  {
    fetch: app.fetch,
    async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
      await Promise.all([
        cleanupExpiredShares(env),
        cleanupExpiredSubscriptions(env),
      ])
      await backupDatabase(env)
    },
  }
)
