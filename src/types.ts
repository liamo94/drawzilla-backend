type RateLimit = {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export type Env = {
  DB: D1Database
  STORAGE: R2Bucket
  CLERK_SECRET_KEY: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  CLERK_WEBHOOK_SECRET: string
  ENVIRONMENT: string
  STRIPE_PRICE_ID: string
  RATE_LIMITER: RateLimit
  SENTRY_DSN: string
  ADMIN_SECRET: string
}

export type DBUser = {
  clerk_id: string
  email: string
  stripe_customer_id: string | null
  plan: 'free' | 'pro'
  created_at: number
}

export type DBWorkspace = {
  id: string
  user_id: string
  name: string
  position: number
  share_token: string | null
  share_enabled: number
  share_expires_at: number | null
  share_password_hash: string | null
  view_count: number
  is_pinned: number
  is_favourite: number
  created_at: number
  slides_json: string | null
  presentation_share_token: string | null
  presentation_share_enabled: number
}

export type DBCanvas = {
  id: string
  workspace_id: string
  name: string
  r2_key: string
  position: number
  updated_at: number
  created_at: number
}

export type DBShare = {
  token: string
  canvas_id: string
  type: 'frozen' | 'live'
  r2_key: string | null
  expires_at: number | null
  password_hash: string | null
  view_count: number
  created_at: number
}

export type CanvasData = {
  strokes: unknown[]
  view: { x: number; y: number; scale: number }
  savedDark?: boolean
  images?: Record<string, string>
}
