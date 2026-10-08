import type { Request } from 'express'
import app from './app.js'
import { normalizeApiPath } from './vercel-path.js'

export default function handleVercelRequest(
  request: Parameters<typeof app>[0],
  response: Parameters<typeof app>[1],
) {
  normalizeApiPath(request)
  return app(request, response)
}
