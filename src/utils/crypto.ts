function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// SHA-256(salt + ":" + password) — simple, fast, reliable in all Workers environments
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const saltHex = toHex(salt.buffer)
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saltHex + ':' + password))
  return `${saltHex}:${toHex(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const sep = stored.indexOf(':')
  if (sep === -1) return false
  const saltHex = stored.slice(0, sep)
  const hashHex = stored.slice(sep + 1)
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saltHex + ':' + password))
  return toHex(hash) === hashHex
}

const DEV_FALLBACK = 'dev-fallback-secret-not-for-production'

// Access token: HMAC-SHA256 signed, valid 1 hour
export async function generateAccessToken(shareToken: string, secret: string): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + 3600
  const message = `${shareToken}:${expiry}`
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret || DEV_FALLBACK),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `${expiry}:${sigHex}`
}

export async function verifyAccessToken(shareToken: string, accessToken: string, secret: string): Promise<boolean> {
  const colonIdx = accessToken.indexOf(':')
  if (colonIdx === -1) return false
  const expiryStr = accessToken.slice(0, colonIdx)
  const sigHex = accessToken.slice(colonIdx + 1)
  const expiry = parseInt(expiryStr)
  if (isNaN(expiry) || expiry < Math.floor(Date.now() / 1000)) return false
  const message = `${shareToken}:${expiry}`
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret || DEV_FALLBACK),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  )
  const sigBytes = new Uint8Array((sigHex.match(/../g) ?? []).map(h => parseInt(h, 16)))
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(message))
}
