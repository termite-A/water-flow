import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

export type Admin = { adminId: string; username: string; email: string }

const cookieName = 'water_admin'
const sessionLifetimeSeconds = 60 * 60 * 12

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function readSessionToken(cookieHeader?: string) {
  const cookie = cookieHeader?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
  return cookie?.slice(cookieName.length + 1)
}

export async function findAdminSession(pool: Pool, cookieHeader?: string): Promise<Admin | null> {
  const token = readSessionToken(cookieHeader)
  if (!token) return null

  const result = await pool.query<Admin>(
    `SELECT a.admin_id AS "adminId", a.username, a.email
     FROM admin_sessions s
     JOIN admins a ON a.admin_id = s.admin_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL
       AND s.expires_at > NOW() AND a.account_status = 'active'
     LIMIT 1`,
    [hashToken(token)],
  )
  return result.rows[0] ?? null
}

export async function createAdminSession(pool: Pool, adminId: string) {
  const token = randomBytes(48).toString('base64url')
  const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000)
  await pool.query(
    `INSERT INTO admin_sessions (admin_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [adminId, hashToken(token), expiresAt],
  )
  return { token, maxAge: sessionLifetimeSeconds }
}

export async function revokeAdminSession(pool: Pool, cookieHeader?: string) {
  const token = readSessionToken(cookieHeader)
  if (!token) return
  await pool.query(
    'UPDATE admin_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)],
  )
}

export function setSessionCookie(token: string, maxAge: number) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`
}

export function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
}
