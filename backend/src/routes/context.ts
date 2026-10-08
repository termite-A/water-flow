import type { RequestHandler } from 'express'
import type { Pool, PoolClient } from 'pg'
import type { Admin } from '../auth.js'
import type { RealtimeHub } from '../realtime.js'

export type EventOptions = {
  adminId?: string | null
  deviceId?: string | null
  severity?: string
  details?: unknown
}

export type ApiContext = {
  pool: Pool | null
  databaseRequired: RequestHandler
  requireAdmin: RequestHandler
  requireSameOrigin: RequestHandler
  getRealtime: () => RealtimeHub | null
  logEvent: (database: Pool | PoolClient, eventType: string, message: string, options?: EventOptions) => Promise<void>
  sendGatewayCommand: (
    database: Pool,
    deviceCode: string,
    deviceId: string,
    action: 'OPEN_GATE' | 'CLOSE_GATE',
    controlMode: 'AUTOMATIC' | 'MANUAL',
    triggerSource: 'ADMIN' | 'AUTOMATION',
    adminId?: string,
  ) => Promise<{ commandId: string; status: 'sent' | 'queued' }>
  persistTelemetry: (payload: unknown) => Promise<unknown>
  persistGatewayReport: (deviceCode: string, payload: unknown) => Promise<unknown>
  persistDeviceEvent: (deviceCode: string, payload: unknown) => Promise<unknown>
}

export type AuthenticatedAdmin = Admin
