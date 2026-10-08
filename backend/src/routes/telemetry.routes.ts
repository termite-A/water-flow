import { Router } from 'express'
import type { ApiContext } from './context.js'

export function createTelemetryRouter({ databaseRequired, persistTelemetry }: ApiContext) {
  const router = Router()

  router.post('/telemetry', databaseRequired, async (request, response, next) => {
    const expectedKey = process.env.DEVICE_API_KEY
    const suppliedKey = request.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (!expectedKey || suppliedKey !== expectedKey) {
      response.status(401).json({ error: 'Device authentication failed.' })
      return
    }
    try {
      const event = await persistTelemetry(request.body)
      response.status(201).json({ accepted: true, event })
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('Invalid telemetry:') ||
          error.message.startsWith('Unknown device:') || error.message.includes('maintenance'))) {
        response.status(error.message.startsWith('Unknown device:') ? 404 : 400).json({ error: error.message })
        return
      }
      next(error)
    }
  })

  return router
}
