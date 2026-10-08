import bcrypt from 'bcryptjs'
import { Router, type RequestHandler } from 'express'
import {
  clearSessionCookie,
  createAdminSession,
  revokeAdminSession,
  setSessionCookie,
  type Admin,
} from '../auth.js'
import type { ApiContext } from './context.js'
import { z } from 'zod'

const loginSchema = z.object({
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
})

const loginRateLimits = new Map<string, { count: number; resetAt: number }>()

function isAllowedLoginAttempt(ip: string) {
  const now = Date.now()
  const current = loginRateLimits.get(ip)
  if (!current || current.resetAt <= now) {
    loginRateLimits.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return true
  }
  if (current.count >= 5) return false
  current.count += 1
  return true
}

export function createHealthRouter({ pool, getRealtime }: ApiContext) {
  const router = Router()
  router.get('/health', async (_request, response) => {
    if (!pool) {
      response.status(503).json({ status: 'offline', database: 'not-configured', mqtt: 'not-configured' })
      return
    }
    try {
      await pool.query('SELECT 1')
      response.json({ status: 'ok', database: 'connected', mqtt: getRealtime()?.mqttStatus ?? 'not-configured' })
    } catch {
      response.status(503).json({ status: 'offline', database: 'unavailable', mqtt: getRealtime()?.mqttStatus ?? 'not-configured' })
    }
  })
  return router
}

export function createAuthRouter({ pool, databaseRequired, requireAdmin, requireSameOrigin, logEvent }: ApiContext) {
  const router = Router()

  router.post('/login', databaseRequired, requireSameOrigin, async (request, response) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({ error: 'Enter your administrator email or username and password.' })
      return
    }
    const ip = request.ip ?? 'unknown'
    if (!isAllowedLoginAttempt(ip)) {
      response.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' })
      return
    }
    try {
      const adminResult = await pool!.query<Admin & { password_hash: string; account_status: string }>(
        `SELECT admin_id AS "adminId", username, email, password_hash, account_status
         FROM admins WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1`,
        [parsed.data.username],
      )
      const admin = adminResult.rows[0]
      const passwordHash = admin?.password_hash ?? await bcrypt.hash('invalid-administrator-password', 12)
      const validPassword = await bcrypt.compare(parsed.data.password, passwordHash)
      if (!admin || admin.account_status !== 'active' || !validPassword) {
        await logEvent(pool!, 'ADMIN_LOGIN_FAILED', 'Administrator login failed.', {
          severity: 'warning', details: { identifier: parsed.data.username.slice(0, 100), ip },
        })
        response.status(401).json({ error: 'Invalid administrator credentials.' })
        return
      }

      const session = await createAdminSession(pool!, admin.adminId)
      await pool!.query('UPDATE admins SET last_login = NOW(), updated_at = NOW() WHERE admin_id = $1', [admin.adminId])
      await logEvent(pool!, 'ADMIN_LOGIN', 'Administrator logged in.', { adminId: admin.adminId })
      loginRateLimits.delete(ip)
      response.setHeader('Set-Cookie', setSessionCookie(session.token, session.maxAge))
      response.json({ admin: { adminId: admin.adminId, username: admin.username, email: admin.email } })
    } catch {
      response.status(503).json({ error: 'Administrator sign-in is temporarily unavailable.' })
    }
  })

  router.get('/session', databaseRequired, requireAdmin, (_request, response) => {
    response.json({ admin: response.locals.admin as Admin })
  })

  router.post('/logout', databaseRequired, requireAdmin, requireSameOrigin, async (request, response, next) => {
    try {
      const admin = response.locals.admin as Admin
      await revokeAdminSession(pool!, request.header('cookie'))
      await logEvent(pool!, 'ADMIN_LOGOUT', 'Administrator logged out.', { adminId: admin.adminId })
      response.setHeader('Set-Cookie', clearSessionCookie())
      response.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  return router
}
