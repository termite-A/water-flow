import bcrypt from 'bcryptjs'
import cors from 'cors'
import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import { Pool, type PoolClient } from 'pg'
import { z } from 'zod'
import {
  findAdminSession,
} from './auth.js'
import { classifyWaterLevel, type LevelThresholds } from './water-level.js'
import { RealtimeHub } from './realtime.js'
import type { ApiContext } from './routes/context.js'
import { createAuthRouter, createHealthRouter } from './routes/auth.routes.js'
import { createGatewayRouter } from './routes/gateway.routes.js'
import { createMonitoringRouter } from './routes/monitoring.routes.js'
import { createSettingsRouter } from './routes/settings.routes.js'
import { createTelemetryRouter } from './routes/telemetry.routes.js'

const app = express()
const port = Number(process.env.PORT ?? 4000)
const database = process.env.DATABASE_URL
const pool = database ? new Pool({ connectionString: database, max: 10 }) : null
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173'
let realtime: RealtimeHub | null = null

app.disable('x-powered-by')
app.use(cors({ origin: frontendOrigin, credentials: true }))
app.use(express.json({ limit: '32kb' }))

const telemetrySchema = z.object({
  deviceId: z.string().trim().min(1).max(80),
  messageId: z.string().trim().min(1).max(120).optional(),
  commandId: z.string().uuid().optional(),
  sensorValue: z.number().int().min(0).max(65535).optional(),
  rawSensorValue: z.number().int().min(0).max(65535).optional(),
  waterLevel: z.number().finite().min(0).max(100).optional(),
  waterLevelPct: z.number().finite().min(0).max(100).optional(),
  waterLevelM: z.number().finite().min(-10).max(100).optional(),
  gatePositionPct: z.number().finite().min(0).max(100).optional(),
  gatewayStatus: z.enum(['OPEN', 'CLOSED', 'MOVING', 'ERROR', 'OFFLINE']).optional(),
  servoAngle: z.number().int().min(0).max(180).optional(),
  controlMode: z.enum(['AUTOMATIC', 'MANUAL']).optional(),
  measuredAt: z.iso.datetime({ offset: true }).optional(),
  readingValid: z.boolean().default(true),
}).refine((reading) => reading.sensorValue !== undefined || reading.rawSensorValue !== undefined ||
  reading.waterLevel !== undefined || reading.waterLevelPct !== undefined || reading.waterLevelM !== undefined,
  'A raw sensor value or calibrated water level is required.')

function databaseRequired(_request: Parameters<RequestHandler>[0], response: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) {
  if (!pool) {
    response.status(503).json({ error: 'Database is not configured. No live data is available.' })
    return
  }
  next()
}

const requireAdmin: RequestHandler = async (request, response, next) => {
  if (!pool) {
    response.status(503).json({ error: 'Database is not configured. Administrator sessions are unavailable.' })
    return
  }
  try {
    const admin = await findAdminSession(pool, request.header('cookie'))
    if (!admin) {
      response.status(401).json({ error: 'Administrator authentication is required.' })
      return
    }
    response.locals.admin = admin
    next()
  } catch (error) {
    next(error)
  }
}

const requireSameOrigin: RequestHandler = (request, response, next) => {
  const origin = request.header('origin')
  if (origin && origin !== frontendOrigin) {
    response.status(403).json({ error: 'Request origin is not allowed.' })
    return
  }
  next()
}

async function logEvent(
  databasePool: Pool | PoolClient,
  eventType: string,
  message: string,
  options: { adminId?: string | null; deviceId?: string | null; severity?: string; details?: unknown } = {},
) {
  await databasePool.query(
    `INSERT INTO system_events (admin_id, device_id, event_type, severity, message, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [options.adminId ?? null, options.deviceId ?? null, eventType,
      options.severity ?? 'info', message, JSON.stringify(options.details ?? {})],
  )
}

function getThresholds(row?: Record<string, unknown> | null): LevelThresholds | null {
  if (!row) return null
  return {
    lowMaxPct: row.low_max_pct === null ? null : Number(row.low_max_pct),
    normalMaxPct: row.normal_max_pct === null ? null : Number(row.normal_max_pct),
    highMaxPct: row.high_max_pct === null ? null : Number(row.high_max_pct),
  }
}

async function bootstrapAdmin() {
  if (!pool) return
  const username = process.env.ADMIN_USERNAME?.trim()
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD
  if (!username || !email || !password) return
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.')

  const passwordHash = await bcrypt.hash(password, 12)
  const inserted = await pool.query<{ admin_id: string }>(
    `INSERT INTO admins (username, email, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING admin_id`,
    [username, email, passwordHash],
  )
  if (inserted.rowCount) {
    await logEvent(pool, 'ADMIN_CREATED', 'Initial administrator account created from environment configuration.', {
      adminId: inserted.rows[0].admin_id,
    })
  }
}

async function sendGatewayCommand(
  databasePool: Pool,
  deviceCode: string,
  deviceId: string,
  action: 'OPEN_GATE' | 'CLOSE_GATE',
  controlMode: 'AUTOMATIC' | 'MANUAL',
  triggerSource: 'ADMIN' | 'AUTOMATION',
  adminId?: string,
) {
  const servoAngle = action === 'OPEN_GATE' ? 135 : 0
  const targetPosition = action === 'OPEN_GATE' ? 100 : 0
  const result = await databasePool.query<{ command_id: string }>(
    `INSERT INTO gate_commands
       (device_id, target_position_pct, status, command_action, control_mode,
        trigger_source, servo_angle, issued_by)
     VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7)
     RETURNING command_id`,
    [deviceId, targetPosition, action, controlMode, triggerSource, servoAngle, adminId ?? null],
  )
  const commandId = result.rows[0].command_id
  const payload = { commandId, command: action, mode: controlMode, servoAngle, issuedAt: new Date().toISOString() }
  try {
    if (realtime?.mqttStatus !== 'connected') {
      await logEvent(databasePool, 'GATEWAY_COMMAND_QUEUED', 'Gateway command queued for the device HTTP poll.', {
        adminId, deviceId, details: { commandId, action, controlMode, triggerSource, servoAngle },
      })
      realtime?.broadcast({ type: 'command', commandId, status: 'queued', deviceCode })
      return { commandId, status: 'queued' as const }
    }
    const sent = await realtime?.publishCommand(deviceCode, payload)
    if (!sent) {
      await logEvent(databasePool, 'GATEWAY_COMMAND_QUEUED', 'Gateway command queued after MQTT became unavailable.', {
        adminId, deviceId, severity: 'error', details: { commandId, action },
      })
      realtime?.broadcast({ type: 'command', commandId, status: 'queued', deviceCode })
      return { commandId, status: 'queued' as const }
    }
    await databasePool.query("UPDATE gate_commands SET status = 'sent' WHERE command_id = $1", [commandId])
    await logEvent(databasePool, 'GATEWAY_COMMAND_SENT', `Gateway ${action === 'OPEN_GATE' ? 'open' : 'close'} command sent.`, {
      adminId, deviceId, details: { commandId, action, controlMode, triggerSource, servoAngle },
    })
    realtime?.broadcast({ type: 'command', commandId, status: 'sent', deviceCode })
    return { commandId, status: 'sent' as const }
  } catch (error) {
    await databasePool.query(
      "UPDATE gate_commands SET status = 'failed', failure_reason = $2 WHERE command_id = $1",
      [commandId, error instanceof Error ? error.message : 'MQTT publish failed.'],
    )
    throw error
  }
}

async function persistTelemetry(input: unknown, deviceCodeFromTopic?: string) {
  if (!pool) throw new Error('Database is not configured.')
  const body = deviceCodeFromTopic && typeof input === 'object' && input !== null
    ? { ...input, deviceId: deviceCodeFromTopic }
    : input
  const parsed = telemetrySchema.safeParse(body)
    if (!parsed.success) {
      throw new Error(`Invalid telemetry: ${parsed.error.message}`)
    }
  const reading = parsed.data
  const rawSensorValue = reading.rawSensorValue ?? reading.sensorValue ?? null
  const waterLevelM = reading.waterLevelM ?? null
  const client = await pool.connect()
  let automaticCommand: { deviceCode: string; deviceId: string; action: 'OPEN_GATE' | 'CLOSE_GATE' } | null = null
  let resultEvent: Record<string, unknown>

  try {
    await client.query('BEGIN')
    const deviceResult = await client.query(
      `SELECT d.device_id, d.device_code, d.status, d.gateway_status, d.control_mode,
              s.raw_at_low_level, s.raw_at_high_level, s.low_max_pct,
              s.normal_max_pct, s.high_max_pct,
              s.automatic_open_below_pct, s.automatic_close_above_pct
       FROM devices d
       LEFT JOIN device_level_settings s ON s.device_id = d.device_id
       WHERE d.device_code = $1 FOR UPDATE OF d`,
      [reading.deviceId],
    )
    if (deviceResult.rowCount === 0) throw new Error(`Unknown device: ${reading.deviceId}`)
    const device = deviceResult.rows[0] as Record<string, unknown>
    if (device.status === 'maintenance') throw new Error('Device is in maintenance mode.')

    let waterLevelPct = reading.waterLevel ?? reading.waterLevelPct ?? null
    if (waterLevelPct === null && rawSensorValue !== null &&
        device.raw_at_low_level !== null && device.raw_at_high_level !== null) {
      const rawLow = Number(device.raw_at_low_level)
      const rawHigh = Number(device.raw_at_high_level)
      waterLevelPct = Math.max(0, Math.min(100, ((rawSensorValue - rawLow) / (rawHigh - rawLow)) * 100))
    }
    const thresholds = getThresholds(device)
    const waterLevelStatus = reading.readingValid
      ? classifyWaterLevel(waterLevelPct, thresholds)
      : 'INVALID'
    const measuredAt = reading.measuredAt ?? new Date().toISOString()
    const previousReading = await client.query<{ water_level_status: string | null }>(
      `SELECT water_level_status FROM water_readings
       WHERE device_id = $1 AND reading_valid = TRUE
       ORDER BY measured_at DESC LIMIT 1`,
      [device.device_id],
    )
    const previousGatewayStatus = String(device.gateway_status)
    const newGatewayStatus = reading.gatewayStatus ?? previousGatewayStatus
    const previousControlMode = String(device.control_mode)
    const newControlMode = reading.controlMode ?? previousControlMode

    const inserted = await client.query<{ reading_id: string }>(
      `INSERT INTO water_readings
         (device_id, device_message_id, distance_m, water_level_m, gate_position_pct,
         reading_valid, measured_at, raw_sensor_value, water_level_pct, water_level_status,
         gateway_status, control_mode)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (device_id, device_message_id)
         WHERE device_message_id IS NOT NULL DO NOTHING
       RETURNING reading_id`,
      [device.device_id, reading.messageId ?? null, waterLevelM, reading.gatePositionPct ?? null,
        reading.readingValid, measuredAt, rawSensorValue, waterLevelPct, waterLevelStatus,
        newGatewayStatus, reading.controlMode ?? previousControlMode],
    )
    if (!inserted.rowCount) {
      await client.query(
        "UPDATE devices SET status = 'online', last_seen_at = NOW(), last_communication = NOW() WHERE device_id = $1",
        [device.device_id],
      )
      await client.query('COMMIT')
      return { type: 'duplicate', deviceCode: device.device_code, messageId: reading.messageId }
    }
    await client.query(
      `UPDATE devices SET status = 'online', last_seen_at = NOW(), last_communication = NOW(),
         gateway_status = $2, servo_angle = COALESCE($3, servo_angle),
         control_mode = COALESCE($4, control_mode), updated_at = NOW()
       WHERE device_id = $1`,
      [device.device_id, newGatewayStatus, reading.servoAngle ?? null, reading.controlMode ?? null],
    )
    if (reading.controlMode && reading.controlMode !== previousControlMode) {
      await logEvent(client, 'CONTROL_MODE_CONFIRMED', `Device confirmed ${reading.controlMode} control mode.`, {
        deviceId: String(device.device_id),
        details: { previous: previousControlMode, current: reading.controlMode },
      })
    }
    if (reading.controlMode) {
      await client.query(
        `UPDATE device_control_commands SET status = 'confirmed', confirmed_at = NOW()
         WHERE control_command_id = COALESCE(
           $3::UUID,
           (SELECT control_command_id FROM device_control_commands
            WHERE device_id = $1 AND requested_mode = $2 AND status IN ('pending', 'sent')
            ORDER BY issued_at DESC LIMIT 1)
         ) AND device_id = $1 AND requested_mode = $2 AND status IN ('pending', 'sent')`,
        [device.device_id, reading.controlMode, reading.commandId ?? null],
      )
    }
    await logEvent(client, 'WATER_LEVEL_UPDATE', 'Water-level measurement received.', {
      deviceId: String(device.device_id),
      details: { readingId: inserted.rows[0].reading_id, rawSensorValue, waterLevelPct, waterLevelM, waterLevelStatus },
    })

    if (previousReading.rows[0]?.water_level_status !== waterLevelStatus) {
      await logEvent(client, 'WATER_LEVEL_STATUS_CHANGED', `Water-level condition changed to ${waterLevelStatus}.`, {
        deviceId: String(device.device_id),
        severity: waterLevelStatus === 'CRITICAL' ? 'critical' : waterLevelStatus === 'UNCONFIGURED' ? 'warning' : 'info',
        details: { previous: previousReading.rows[0]?.water_level_status ?? null, current: waterLevelStatus },
      })
      if (['LOW', 'HIGH', 'CRITICAL'].includes(waterLevelStatus)) {
        await client.query(
          `INSERT INTO alerts (device_id, alert_type, severity, message)
           VALUES ($1, $2, $3, $4)`,
          [device.device_id, waterLevelStatus,
            waterLevelStatus === 'CRITICAL' ? 'critical' : 'warning',
            `Water level status changed to ${waterLevelStatus}.`],
        )
      }
    }

    const gatewayChanged = Boolean(reading.gatewayStatus && reading.gatewayStatus !== previousGatewayStatus)
    if (gatewayChanged && reading.gatewayStatus) {
      const controlMode = reading.controlMode ?? String(device.control_mode)
      await client.query(
        `INSERT INTO gateway_activity
           (device_id, previous_status, new_status, servo_angle, control_mode, trigger_source)
         VALUES ($1, $2, $3, $4, $5, 'DEVICE')`,
        [device.device_id, previousGatewayStatus, reading.gatewayStatus, reading.servoAngle ?? null, controlMode],
      )
      await logEvent(client, 'GATEWAY_STATUS_CHANGED', `Gateway status changed to ${reading.gatewayStatus}.`, {
        deviceId: String(device.device_id), details: { previous: previousGatewayStatus, current: reading.gatewayStatus },
      })
    }

    let confirmedCommandId: string | null = null
    if (reading.gatewayStatus === 'OPEN' || reading.gatewayStatus === 'CLOSED') {
      const confirmedCommand = await client.query<{ command_id: string }>(
        `UPDATE gate_commands SET status = 'confirmed', observed_position_pct = $2,
           completed_at = NOW()
         WHERE command_id = COALESCE(
           $4::UUID,
           (SELECT command_id FROM gate_commands
            WHERE device_id = $1 AND status IN ('sent', 'accepted')
              AND command_action = CASE WHEN $3 = 'OPEN' THEN 'OPEN_GATE' ELSE 'CLOSE_GATE' END
            ORDER BY issued_at DESC LIMIT 1)
         ) AND device_id = $1 AND status IN ('sent', 'accepted')
           AND command_action = CASE WHEN $3 = 'OPEN' THEN 'OPEN_GATE' ELSE 'CLOSE_GATE' END
         RETURNING command_id`,
        [device.device_id, reading.gatePositionPct ?? null, reading.gatewayStatus, reading.commandId ?? null],
      )
      confirmedCommandId = confirmedCommand.rows[0]?.command_id ?? null
      if (confirmedCommandId) {
        await logEvent(client, 'GATEWAY_COMMAND_CONFIRMED', `Device confirmed gateway ${reading.gatewayStatus}.`, {
          deviceId: String(device.device_id), details: { commandId: confirmedCommandId, servoAngle: reading.servoAngle ?? null },
        })
        if (gatewayChanged) {
          await client.query(
            `UPDATE gateway_activity SET command_id = $2
             WHERE activity_id = (SELECT MAX(activity_id) FROM gateway_activity WHERE device_id = $1)`,
            [device.device_id, confirmedCommandId],
          )
        }
      }
    }

    const mode = String(reading.controlMode ?? device.control_mode)
    const level = waterLevelPct
    if (mode === 'AUTOMATIC' && reading.readingValid && device.status === 'online' && level !== null) {
      const openBelow = device.automatic_open_below_pct === null ? null : Number(device.automatic_open_below_pct)
      const closeAbove = device.automatic_close_above_pct === null ? null : Number(device.automatic_close_above_pct)
      const gateway = String(newGatewayStatus)
      const action = gateway === 'OPEN' && closeAbove !== null && level > closeAbove
        ? 'CLOSE_GATE'
        : gateway === 'CLOSED' && openBelow !== null && level < openBelow
          ? 'OPEN_GATE'
          : null
      if (action) {
        const outstanding = await client.query(
          `SELECT 1 FROM gate_commands
           WHERE device_id = $1 AND command_action = $2
             AND status IN ('pending', 'sent', 'accepted') LIMIT 1`,
          [device.device_id, action],
        )
        if (!outstanding.rowCount) {
          automaticCommand = {
            deviceCode: String(device.device_code),
            deviceId: String(device.device_id),
            action,
          }
        }
      }
    }

    resultEvent = {
      type: 'measurement',
      deviceCode: device.device_code,
      rawSensorValue,
      waterLevelPct,
      waterLevelM,
      waterLevelStatus,
      gatewayStatus: newGatewayStatus,
      servoAngle: reading.servoAngle ?? device.servo_angle,
      measuredAt,
      readingId: inserted.rows[0].reading_id,
      confirmedCommandId,
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  realtime?.broadcast(resultEvent!)
  if (automaticCommand) {
    await sendGatewayCommand(pool, automaticCommand.deviceCode, automaticCommand.deviceId,
      automaticCommand.action, 'AUTOMATIC', 'AUTOMATION')
  }
  return resultEvent!
}

const gatewayReportSchema = z.object({
  commandId: z.string().uuid().optional(),
  gatewayStatus: z.enum(['OPEN', 'CLOSED', 'MOVING', 'ERROR', 'OFFLINE']),
  servoAngle: z.number().int().min(0).max(180).optional(),
  gatePositionPct: z.number().min(0).max(100).optional(),
  controlMode: z.enum(['AUTOMATIC', 'MANUAL']).optional(),
})

async function persistGatewayReport(deviceCode: string, payload: unknown) {
  if (!pool) throw new Error('Database is not configured.')
  const parsed = gatewayReportSchema.safeParse(payload)
  if (!parsed.success) throw new Error(`Invalid gateway report: ${parsed.error.message}`)
  const report = parsed.data
  const client = await pool.connect()
  let resultEvent: Record<string, unknown>
  try {
    await client.query('BEGIN')
    const found = await client.query(
      `SELECT device_id, gateway_status, control_mode FROM devices
       WHERE device_code = $1 FOR UPDATE`,
      [deviceCode],
    )
    if (!found.rowCount) throw new Error(`Unknown device: ${deviceCode}`)
    const device = found.rows[0] as { device_id: string; gateway_status: string; control_mode: string }
    const changed = device.gateway_status !== report.gatewayStatus
    await client.query(
      `UPDATE devices SET status = 'online', last_seen_at = NOW(), last_communication = NOW(),
         gateway_status = $2, servo_angle = COALESCE($3, servo_angle),
         control_mode = COALESCE($4, control_mode), updated_at = NOW()
       WHERE device_id = $1`,
      [device.device_id, report.gatewayStatus, report.servoAngle ?? null, report.controlMode ?? null],
    )

    let confirmedCommand: { command_id: string; trigger_source: string } | undefined
    if (report.gatewayStatus === 'OPEN' || report.gatewayStatus === 'CLOSED') {
      const confirmed = await client.query<{ command_id: string; trigger_source: string }>(
        `UPDATE gate_commands SET status = 'confirmed', observed_position_pct = $2, completed_at = NOW()
         WHERE command_id = COALESCE(
           $4::UUID,
           (SELECT command_id FROM gate_commands
            WHERE device_id = $1 AND status IN ('sent', 'accepted')
              AND command_action = CASE WHEN $3 = 'OPEN' THEN 'OPEN_GATE' ELSE 'CLOSE_GATE' END
            ORDER BY issued_at DESC LIMIT 1)
         ) AND device_id = $1 AND status IN ('sent', 'accepted')
           AND command_action = CASE WHEN $3 = 'OPEN' THEN 'OPEN_GATE' ELSE 'CLOSE_GATE' END
         RETURNING command_id, trigger_source`,
        [device.device_id, report.gatePositionPct ?? null, report.gatewayStatus, report.commandId ?? null],
      )
      confirmedCommand = confirmed.rows[0]
    }

    if (changed || confirmedCommand) {
      await client.query(
        `INSERT INTO gateway_activity
           (device_id, command_id, previous_status, new_status, servo_angle,
            control_mode, trigger_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [device.device_id, confirmedCommand?.command_id ?? null, device.gateway_status,
          report.gatewayStatus, report.servoAngle ?? null, report.controlMode ?? device.control_mode,
          confirmedCommand?.trigger_source ?? 'DEVICE'],
      )
    }
    if (changed) {
      await logEvent(client, 'GATEWAY_STATUS_CHANGED', `Gateway status changed to ${report.gatewayStatus}.`, {
        deviceId: device.device_id,
        details: { previous: device.gateway_status, current: report.gatewayStatus, servoAngle: report.servoAngle ?? null },
      })
    }
    if (report.controlMode && report.controlMode !== device.control_mode) {
      await logEvent(client, 'CONTROL_MODE_CONFIRMED', `Device confirmed ${report.controlMode} control mode.`, {
        deviceId: device.device_id, details: { previous: device.control_mode, current: report.controlMode },
      })
    }
    if (report.controlMode) {
      await client.query(
        `UPDATE device_control_commands SET status = 'confirmed', confirmed_at = NOW()
         WHERE control_command_id = COALESCE(
           $3::UUID,
           (SELECT control_command_id FROM device_control_commands
            WHERE device_id = $1 AND requested_mode = $2 AND status IN ('pending', 'sent')
            ORDER BY issued_at DESC LIMIT 1)
         ) AND device_id = $1 AND requested_mode = $2 AND status IN ('pending', 'sent')`,
        [device.device_id, report.controlMode, report.commandId ?? null],
      )
    }
    if (confirmedCommand) {
      await logEvent(client, 'GATEWAY_COMMAND_CONFIRMED', `Device confirmed gateway ${report.gatewayStatus}.`, {
        deviceId: device.device_id,
        details: { commandId: confirmedCommand.command_id, servoAngle: report.servoAngle ?? null },
      })
    }
    resultEvent = {
      type: 'gateway', deviceCode, gatewayStatus: report.gatewayStatus,
      servoAngle: report.servoAngle ?? null, controlMode: report.controlMode ?? device.control_mode,
      commandId: confirmedCommand?.command_id ?? null, reportedAt: new Date().toISOString(),
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  realtime?.broadcast(resultEvent!)
  return resultEvent!
}

const deviceEventSchema = z.object({
  eventType: z.string().trim().min(1).max(80),
  severity: z.enum(['info', 'warning', 'error', 'critical']).default('info'),
  message: z.string().trim().min(1).max(500),
  details: z.record(z.string(), z.unknown()).default({}),
})

async function persistDeviceEvent(deviceCode: string, payload: unknown) {
  if (!pool) throw new Error('Database is not configured.')
  const parsed = deviceEventSchema.safeParse(payload)
  if (!parsed.success) throw new Error(`Invalid device event: ${parsed.error.message}`)
  const device = await pool.query<{ device_id: string }>(
    `UPDATE devices SET status = 'online', last_seen_at = NOW(), last_communication = NOW(), updated_at = NOW()
     WHERE device_code = $1 RETURNING device_id`,
    [deviceCode],
  )
  if (!device.rowCount) throw new Error(`Unknown device: ${deviceCode}`)
  await logEvent(pool, parsed.data.eventType, parsed.data.message, {
    deviceId: device.rows[0].device_id,
    severity: parsed.data.severity,
    details: parsed.data.details,
  })
  const event = { type: 'device-event', deviceCode, ...parsed.data, occurredAt: new Date().toISOString() }
  realtime?.broadcast(event)
  return event
}

const routeContext: ApiContext = {
  pool, databaseRequired, requireAdmin, requireSameOrigin,
  getRealtime: () => realtime,
  logEvent, sendGatewayCommand, persistTelemetry, persistGatewayReport, persistDeviceEvent,
}
app.use('/api', createHealthRouter(routeContext))
app.use('/api/auth', createAuthRouter(routeContext))
app.use('/api', createMonitoringRouter(routeContext))
app.use('/api/settings', createSettingsRouter(routeContext))
app.use('/api', createGatewayRouter(routeContext))
app.use('/api', createTelemetryRouter(routeContext))
app.use((_request, response) => response.status(404).json({ error: 'Route not found.' }))
const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error('Request failed:', error instanceof Error ? error.message : error)
  response.status(500).json({ error: 'The request could not be completed.' })
}
app.use(errorHandler)

export default app
if (!process.env.VERCEL) {
const server = app.listen(port, () => {

if (pool) {
  realtime = new RealtimeHub(server, pool, async (topic, payload) => {
    const parts = topic.split('/')
    const deviceCode = parts[2]
    if (!deviceCode) return
    const data = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
    if (parts[3] === 'events') {
      await persistDeviceEvent(deviceCode, payload)
      return
    }
    if (parts[3] === 'gateway' ||
        (parts[3] === 'status' && 'gatewayStatus' in data &&
          !('sensorValue' in data) && !('rawSensorValue' in data) && !('waterLevel' in data) && !('waterLevelPct' in data))) {
      await persistGatewayReport(deviceCode, payload)
      return
    }
    if (parts[3] === 'status' && !('sensorValue' in data) && !('rawSensorValue' in data) &&
        !('waterLevel' in data) && !('waterLevelPct' in data) && !('waterLevelM' in data)) {
      const online = Boolean((payload as { online?: unknown }).online)
      const result = await pool.query(
        `UPDATE devices SET status = $2, last_seen_at = NOW(), last_communication = NOW(), updated_at = NOW()
         WHERE device_code = $1 RETURNING device_id, gateway_status`,
        [deviceCode, online ? 'online' : 'offline'],
      )
      if (result.rowCount) {
        await logEvent(pool, online ? 'DEVICE_CONNECTED' : 'DEVICE_DISCONNECTED',
          `IoT device ${online ? 'connected' : 'disconnected'}.`, { deviceId: String(result.rows[0].device_id) })
        realtime?.broadcast({ type: 'device-status', deviceCode, deviceStatus: online ? 'ONLINE' : 'OFFLINE' })
      }
      return
    }
    await persistTelemetry(payload, deviceCode)
  })

  const offlineCheck = setInterval(async () => {
    try {
      const result = await pool.query(
        `UPDATE devices SET status = 'offline', updated_at = NOW()
         WHERE status = 'online' AND (last_communication IS NULL OR last_communication < NOW() - INTERVAL '90 seconds')
         RETURNING device_id, device_code`,
      )
      for (const device of result.rows) {
        await logEvent(pool, 'DEVICE_DISCONNECTED', 'IoT device stopped communicating.', {
          deviceId: String(device.device_id), severity: 'warning',
        })
        realtime?.broadcast({ type: 'device-status', deviceCode: device.device_code, deviceStatus: 'OFFLINE' })
      }
    } catch (error) {
      console.error('Device offline check failed:', error)
    }
  }, 30000)
  offlineCheck.unref()

  void pool.query('SELECT 1').then(() => bootstrapAdmin()).catch((error) => {
    console.error('Database unavailable or schema not applied:', error instanceof Error ? error.message : error)
  })
}

})
}