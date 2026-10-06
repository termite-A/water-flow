import bcrypt from 'bcryptjs'
import cors from 'cors'
import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import { Pool, type PoolClient } from 'pg'
import { z } from 'zod'
import {
  clearSessionCookie,
  createAdminSession,
  findAdminSession,
  revokeAdminSession,
  setSessionCookie,
  type Admin,
} from './auth.js'
import { classifyWaterLevel, type LevelThresholds } from './water-level.js'
import { RealtimeHub } from './realtime.js'

const app = express()
const port = Number(process.env.PORT ?? 4000)
const database = process.env.DATABASE_URL
const pool = database ? new Pool({ connectionString: database, max: 10 }) : null
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173'
let realtime: RealtimeHub | null = null

app.disable('x-powered-by')
app.use(cors({ origin: frontendOrigin, credentials: true }))
app.use(express.json({ limit: '32kb' }))

const adminRateLimits = new Map<string, { count: number; resetAt: number }>()
const loginSchema = z.object({
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
})
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
const commandSchema = z.object({
  deviceCode: z.string().trim().min(1).max(80),
  command: z.enum(['OPEN_GATE', 'CLOSE_GATE']),
})
const modeSchema = z.object({ controlMode: z.enum(['AUTOMATIC', 'MANUAL']) })
const settingsSchema = z.object({
  rawAtLowLevel: z.number().int().min(0).max(65535).nullable(),
  rawAtHighLevel: z.number().int().min(0).max(65535).nullable(),
  lowMaxPct: z.number().min(0).max(100).nullable(),
  normalMaxPct: z.number().min(0).max(100).nullable(),
  highMaxPct: z.number().min(0).max(100).nullable(),
  automaticOpenBelowPct: z.number().min(0).max(100).nullable(),
  automaticCloseAbovePct: z.number().min(0).max(100).nullable(),
}).refine((settings) => {
  const values = [settings.lowMaxPct, settings.normalMaxPct, settings.highMaxPct]
  return values.every((value) => value === null) ||
    (values.every((value) => value !== null) && settings.lowMaxPct! < settings.normalMaxPct! && settings.normalMaxPct! < settings.highMaxPct!)
}, 'Set all three level thresholds in increasing order, or clear all three.').refine((settings) =>
  (settings.automaticOpenBelowPct === null && settings.automaticCloseAbovePct === null) ||
  (settings.automaticOpenBelowPct !== null && settings.automaticCloseAbovePct !== null &&
    settings.automaticOpenBelowPct < settings.automaticCloseAbovePct),
'Set both automatic-control thresholds in increasing order, or clear both.')

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

function isAllowedLoginAttempt(ip: string) {
  const now = Date.now()
  const current = adminRateLimits.get(ip)
  if (!current || current.resetAt <= now) {
    adminRateLimits.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return true
  }
  if (current.count >= 5) return false
  current.count += 1
  return true
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
      if (realtime?.mqttStatus !== 'connected') { 
        waterLevelPct = Math.max(0, Math.min(100, ((rawSensorValue - rawLow) / (rawHigh - rawLow)) * 100))
      }
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

app.get('/api/health', async (_request, response) => {
  if (!pool) {
    response.status(503).json({ status: 'offline', database: 'not-configured', mqtt: 'not-configured' })
    return
  }
  try {
    await pool.query('SELECT 1')
    response.json({ status: 'ok', database: 'connected', mqtt: realtime?.mqttStatus ?? 'not-configured' })
  } catch {
    response.status(503).json({ status: 'offline', database: 'unavailable', mqtt: realtime?.mqttStatus ?? 'not-configured' })
  }
})

app.post('/api/auth/login', databaseRequired, requireSameOrigin, async (request, response) => {
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
    adminRateLimits.delete(ip)
    response.setHeader('Set-Cookie', setSessionCookie(session.token, session.maxAge))
    response.json({ admin: { adminId: admin.adminId, username: admin.username, email: admin.email } })
  } catch (error) {
    response.status(503).json({ error: 'Administrator sign-in is temporarily unavailable.' })
  }
})

app.get('/api/auth/session', databaseRequired, requireAdmin, (request, response) => {
  response.json({ admin: response.locals.admin as Admin })
})

app.post('/api/auth/logout', databaseRequired, requireAdmin, requireSameOrigin, async (request, response, next) => {
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

app.get('/api/dashboard', databaseRequired, requireAdmin, async (_request, response, next) => {
  try {
    const result = await pool!.query(
      `SELECT d.device_id AS "deviceId", d.device_code AS "deviceCode",
              COALESCE(d.device_name, d.device_code) AS "deviceName",
              d.device_type AS "deviceType", c.name AS "canalName", c.barangay,
              CASE WHEN d.last_communication IS NULL OR d.last_communication < NOW() - INTERVAL '90 seconds'
                   THEN 'OFFLINE' ELSE 'ONLINE' END AS "deviceStatus",
              CASE WHEN d.last_communication IS NULL OR d.last_communication < NOW() - INTERVAL '90 seconds'
                   THEN 'OFFLINE' ELSE d.gateway_status END AS "gatewayStatus",
              d.servo_angle AS "servoAngle", d.control_mode AS "controlMode",
              d.last_communication AS "lastCommunication",
              r.raw_sensor_value AS "rawSensorValue", r.water_level_pct::DOUBLE PRECISION AS "waterLevelPct",
              r.water_level_m::DOUBLE PRECISION AS "waterLevelM", r.water_level_status AS "waterLevelStatus",
              r.measured_at AS "measuredAt",
              (r.measured_at IS NULL OR r.measured_at < NOW() - INTERVAL '90 seconds') AS "readingStale"
       FROM devices d JOIN canals c ON c.canal_id = d.canal_id
       LEFT JOIN LATERAL (
         SELECT raw_sensor_value, water_level_pct, water_level_m, water_level_status, measured_at
         FROM water_readings WHERE device_id = d.device_id AND reading_valid = TRUE
         ORDER BY measured_at DESC LIMIT 1
       ) r ON TRUE
       WHERE c.is_active = TRUE ORDER BY d.device_code`,
    )
    response.json({ devices: result.rows, mqttStatus: realtime?.mqttStatus ?? 'not-configured' })
  } catch (error) { next(error) }
})

app.get('/api/devices', databaseRequired, requireAdmin, async (_request, response, next) => {
  try {
    const result = await pool!.query(
      `SELECT d.device_id AS "deviceId", d.device_code AS "deviceCode",
              COALESCE(d.device_name, d.device_code) AS "deviceName",
              d.device_type AS "deviceType", d.status,
              d.last_communication AS "lastCommunication", d.gateway_status AS "gatewayStatus",
              d.servo_angle AS "servoAngle", d.control_mode AS "controlMode",
              c.name AS "canalName", c.barangay
       FROM devices d JOIN canals c ON c.canal_id = d.canal_id
       WHERE c.is_active = TRUE ORDER BY d.device_code`,
    )
    response.json({ devices: result.rows, mqttStatus: realtime?.mqttStatus ?? 'not-configured' })
  } catch (error) { next(error) }
})

app.get('/api/history', databaseRequired, requireAdmin, async (request, response, next) => {
  const page = Math.max(1, Number(request.query.page ?? 1) || 1)
  const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 25) || 25))
  const conditions: string[] = []
  const values: unknown[] = []
  const add = (condition: (parameter: string) => string, value: unknown) => {
    values.push(value)
    conditions.push(condition(`$${values.length}`))
  }
  if (typeof request.query.deviceCode === 'string') add((p) => `d.device_code = ${p}`, request.query.deviceCode)
  if (typeof request.query.status === 'string') add((p) => `r.water_level_status = ${p}`, request.query.status)
  if (typeof request.query.gatewayStatus === 'string') add((p) => `r.gateway_status = ${p}`, request.query.gatewayStatus)
  if (typeof request.query.controlMode === 'string') add((p) => `r.control_mode = ${p}`, request.query.controlMode)
  if (typeof request.query.search === 'string' && request.query.search.trim()) {
    add((p) => `(d.device_code ILIKE ${p} OR r.raw_sensor_value::TEXT ILIKE ${p})`, `%${request.query.search.trim()}%`)
  }
  if (typeof request.query.from === 'string') add((p) => `r.measured_at >= ${p}::timestamptz`, request.query.from)
  if (typeof request.query.to === 'string') add((p) => `r.measured_at <= ${p}::timestamptz`, request.query.to)
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  try {
    const count = await pool!.query<{ total: string }>(
      `SELECT COUNT(*)::TEXT AS total
       FROM water_readings r JOIN devices d ON d.device_id = r.device_id ${where}`,
      values,
    )
    const result = await pool!.query(
      `SELECT r.reading_id AS "measurementId", d.device_code AS "deviceId",
              r.raw_sensor_value AS "rawSensorValue", r.water_level_m::DOUBLE PRECISION AS "waterLevelM",
              r.water_level_pct::DOUBLE PRECISION AS "waterLevelPct", r.water_level_status AS "waterLevelStatus",
              r.gate_position_pct::DOUBLE PRECISION AS "gatePositionPct",
              r.gateway_status AS "gatewayStatus", r.control_mode AS "controlMode",
              r.reading_valid AS "readingValid", r.measured_at AS "measuredAt"
       FROM water_readings r JOIN devices d ON d.device_id = r.device_id
       ${where} ORDER BY r.measured_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, (page - 1) * limit],
    )
    response.json({ measurements: result.rows, page, limit, total: Number(count.rows[0].total) })
  } catch (error) { next(error) }
})

app.get('/api/activities', databaseRequired, requireAdmin, async (request, response, next) => {
  const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 50) || 50))
  try {
    const result = await pool!.query(
      `SELECT * FROM (
         SELECT e.event_id::TEXT AS id, e.event_type AS type, e.severity, e.message,
                e.occurred_at AS "occurredAt", d.device_code AS "deviceCode",
                a.username AS actor, e.details
         FROM system_events e
         LEFT JOIN devices d ON d.device_id = e.device_id
         LEFT JOIN admins a ON a.admin_id = e.admin_id
         UNION ALL
         SELECT g.activity_id::TEXT AS id, 'GATEWAY_STATUS_CHANGED' AS type, 'info' AS severity,
                'Gateway changed to ' || g.new_status AS message,
                g.occurred_at AS "occurredAt", d.device_code AS "deviceCode",
                a.username AS actor,
                jsonb_build_object('previousStatus', g.previous_status, 'newStatus', g.new_status,
                  'servoAngle', g.servo_angle, 'controlMode', g.control_mode,
                  'triggerSource', g.trigger_source) AS details
         FROM gateway_activity g JOIN devices d ON d.device_id = g.device_id
         LEFT JOIN admins a ON a.admin_id = g.admin_id
       ) events ORDER BY "occurredAt" DESC LIMIT $1`,
      [limit],
    )
    response.json({ events: result.rows })
  } catch (error) { next(error) }
})

app.get('/api/settings', databaseRequired, requireAdmin, async (_request, response, next) => {
  try {
    const result = await pool!.query(
      `SELECT d.device_code AS "deviceCode", COALESCE(d.device_name, d.device_code) AS "deviceName",
              d.control_mode AS "controlMode", s.raw_at_low_level AS "rawAtLowLevel",
              s.raw_at_high_level AS "rawAtHighLevel", s.low_max_pct::DOUBLE PRECISION AS "lowMaxPct",
              s.normal_max_pct::DOUBLE PRECISION AS "normalMaxPct", s.high_max_pct::DOUBLE PRECISION AS "highMaxPct",
              s.automatic_open_below_pct::DOUBLE PRECISION AS "automaticOpenBelowPct",
              s.automatic_close_above_pct::DOUBLE PRECISION AS "automaticCloseAbovePct", s.updated_at AS "updatedAt"
       FROM devices d LEFT JOIN device_level_settings s ON s.device_id = d.device_id
       ORDER BY d.device_code`,
    )
    response.json({ settings: result.rows })
  } catch (error) { next(error) }
})

app.put('/api/settings/:deviceCode', databaseRequired, requireAdmin, requireSameOrigin, async (request, response, next) => {
  const parsed = settingsSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid level configuration.', details: parsed.error.flatten().fieldErrors })
    return
  }
  const settings = parsed.data
  if ((settings.rawAtLowLevel === null) !== (settings.rawAtHighLevel === null) ||
      (settings.rawAtLowLevel !== null && settings.rawAtLowLevel === settings.rawAtHighLevel)) {
    response.status(400).json({ error: 'Set two distinct raw values for calibration, or clear both.' })
    return
  }
  try {
    const admin = response.locals.admin as Admin
    const result = await pool!.query(
      `INSERT INTO device_level_settings
         (device_id, raw_at_low_level, raw_at_high_level, low_max_pct, normal_max_pct,
          high_max_pct, automatic_open_below_pct, automatic_close_above_pct, updated_by, updated_at)
       SELECT device_id, $2, $3, $4, $5, $6, $7, $8, $9, NOW()
       FROM devices WHERE device_code = $1
       ON CONFLICT (device_id) DO UPDATE SET
         raw_at_low_level = EXCLUDED.raw_at_low_level,
         raw_at_high_level = EXCLUDED.raw_at_high_level,
         low_max_pct = EXCLUDED.low_max_pct, normal_max_pct = EXCLUDED.normal_max_pct,
         high_max_pct = EXCLUDED.high_max_pct,
         automatic_open_below_pct = EXCLUDED.automatic_open_below_pct,
         automatic_close_above_pct = EXCLUDED.automatic_close_above_pct,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING device_id`,
      [request.params.deviceCode, settings.rawAtLowLevel, settings.rawAtHighLevel,
        settings.lowMaxPct, settings.normalMaxPct, settings.highMaxPct,
        settings.automaticOpenBelowPct, settings.automaticCloseAbovePct, admin.adminId],
    )
    if (!result.rowCount) {
      response.status(404).json({ error: 'Device not found.' })
      return
    }
    await logEvent(pool!, 'DEVICE_SETTINGS_UPDATED', 'Water-level calibration or thresholds updated.', {
      adminId: admin.adminId, deviceId: String(result.rows[0].device_id), details: settings,
    })
    realtime?.broadcast({ type: 'settings', deviceCode: request.params.deviceCode })
    response.json({ saved: true })
  } catch (error) { next(error) }
})

app.patch('/api/devices/:deviceCode/mode', databaseRequired, requireAdmin, requireSameOrigin, async (request, response, next) => {
  const parsed = modeSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: 'Control mode must be AUTOMATIC or MANUAL.' })
    return
  }
  try {
    const admin = response.locals.admin as Admin
    const deviceCode = String(request.params.deviceCode)
    const device = await pool!.query<{ device_id: string; status: string; control_mode: string; recently_seen: boolean }>(
      `SELECT device_id, status, control_mode,
              last_communication >= NOW() - INTERVAL '90 seconds' AS recently_seen
       FROM devices WHERE device_code = $1`,
      [deviceCode],
    )
    if (!device.rowCount) {
      response.status(404).json({ error: 'Device not found.' })
      return
    }
    if (device.rows[0].status !== 'online' || !device.rows[0].recently_seen) {
      response.status(409).json({ error: 'Device is offline; control mode was not changed.' })
      return
    }
    if (parsed.data.controlMode === 'AUTOMATIC') {
      const calibration = await pool!.query(
        `SELECT s.low_max_pct, s.normal_max_pct, s.high_max_pct,
                s.automatic_open_below_pct, s.automatic_close_above_pct
         FROM devices d LEFT JOIN device_level_settings s ON s.device_id = d.device_id
         WHERE d.device_code = $1`,
        [deviceCode],
      )
      const config = calibration.rows[0]
      if (!config || config.low_max_pct === null || config.normal_max_pct === null ||
          config.high_max_pct === null || config.automatic_open_below_pct === null ||
          config.automatic_close_above_pct === null) {
        response.status(409).json({ error: 'Configure calibrated water-level status limits and automatic open/close thresholds before enabling automatic mode.' })
        return
      }
    }
    const inserted = await pool!.query<{ control_command_id: string }>(
      `INSERT INTO device_control_commands (device_id, requested_mode, issued_by)
       VALUES ($1, $2, $3) RETURNING control_command_id`,
      [device.rows[0].device_id, parsed.data.controlMode, admin.adminId],
    )
    const commandId = inserted.rows[0].control_command_id
    const message = { commandId, command: 'SET_CONTROL_MODE', controlMode: parsed.data.controlMode,
      issuedAt: new Date().toISOString() }
    const sent = realtime?.mqttStatus === 'connected'
      ? await realtime.publishCommand(deviceCode, message)
      : false
    if (sent) {
      await pool!.query(
        "UPDATE device_control_commands SET status = 'sent', last_delivery_at = NOW() WHERE control_command_id = $1",
        [commandId],
      )
    }
    const status = sent ? 'sent' : 'queued'
    await logEvent(pool!, sent ? 'CONTROL_MODE_COMMAND_SENT' : 'CONTROL_MODE_COMMAND_QUEUED',
      `Control mode ${parsed.data.controlMode} command ${sent ? 'sent' : 'queued for device HTTP polling'}.`, {
      adminId: admin.adminId, deviceId: device.rows[0].device_id,
      details: { commandId, previousMode: device.rows[0].control_mode, requestedMode: parsed.data.controlMode },
    })
    realtime?.broadcast({ type: 'control-mode-command', commandId, deviceCode, status })
    response.status(202).json({ commandId, status, message: sent
      ? 'Mode command sent; the displayed mode changes after device confirmation.'
      : 'Mode command queued; waiting for the device HTTP poll.' })
  } catch (error) { next(error) }
})

app.post('/api/gateway/commands', databaseRequired, requireAdmin, requireSameOrigin, async (request, response, next) => {
  const parsed = commandSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: 'Select a device and a valid gateway command.' })
    return
  }
  try {
    const admin = response.locals.admin as Admin
    const device = await pool!.query<{ device_id: string; status: string; control_mode: 'AUTOMATIC' | 'MANUAL'; recently_seen: boolean }>(
      `SELECT device_id, status, control_mode,
              last_communication >= NOW() - INTERVAL '90 seconds' AS recently_seen
       FROM devices WHERE device_code = $1`,
      [parsed.data.deviceCode],
    )
    if (!device.rowCount) {
      response.status(404).json({ error: 'Device not found.' })
      return
    }
    if (device.rows[0].status !== 'online' || !device.rows[0].recently_seen) {
      response.status(409).json({ error: 'Device is offline or stale. No command was sent.' })
      return
    }
    if (device.rows[0].control_mode !== 'MANUAL') {
      response.status(409).json({ error: 'Switch the device to MANUAL mode before issuing a manual command.' })
      return
    }
    const command = await sendGatewayCommand(pool!, parsed.data.deviceCode,
      device.rows[0].device_id, parsed.data.command, 'MANUAL', 'ADMIN', admin.adminId)
    response.status(202).json({ ...command, message: command.status === 'queued'
      ? 'Command queued; waiting for the device HTTP poll.'
      : 'Command sent; waiting for physical gateway confirmation.' })
  } catch (error) { next(error) }
})

app.get('/api/device/commands', databaseRequired, async (request, response, next) => {
  const expectedKey = process.env.DEVICE_API_KEY
  const suppliedKey = request.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (!expectedKey || suppliedKey !== expectedKey) {
    response.status(401).json({ error: 'Device authentication failed.' })
    return
  }
  const deviceCode = z.string().trim().min(1).max(80).safeParse(request.query.deviceId)
  if (!deviceCode.success) {
    response.status(400).json({ error: 'A valid deviceId query parameter is required.' })
    return
  }

  const client = await pool!.connect()
  try {
    await client.query('BEGIN')
    const device = await client.query<{ device_id: string }>(
      `UPDATE devices SET status = 'online', last_seen_at = NOW(), last_communication = NOW(), updated_at = NOW()
       WHERE device_code = $1 AND status <> 'maintenance' RETURNING device_id`,
      [deviceCode.data],
    )
    if (!device.rowCount) {
      await client.query('ROLLBACK')
      response.status(404).json({ error: 'Device not found or unavailable.' })
      return
    }
    const deviceId = device.rows[0].device_id
    await client.query(
      `UPDATE gate_commands SET status = 'expired', failure_reason = 'Device command expired before confirmation.'
       WHERE device_id = $1 AND status IN ('pending', 'sent')
         AND issued_at < NOW() - INTERVAL '15 minutes'`,
      [deviceId],
    )
    await client.query(
      `UPDATE device_control_commands SET status = 'failed', failure_reason = 'Mode command expired before confirmation.'
       WHERE device_id = $1 AND status IN ('pending', 'sent')
         AND issued_at < NOW() - INTERVAL '15 minutes'`,
      [deviceId],
    )

    const gateCommand = await client.query<{
      command_id: string; command_action: string; servo_angle: number; control_mode: string; trigger_source: string
    }>(
      `SELECT command_id, command_action, servo_angle, control_mode, trigger_source
       FROM gate_commands
       WHERE device_id = $1 AND status IN ('pending', 'sent')
         AND (status = 'pending' OR last_delivery_at IS NULL OR last_delivery_at < NOW() - INTERVAL '30 seconds')
       ORDER BY issued_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [deviceId],
    )
    if (gateCommand.rowCount) {
      const command = gateCommand.rows[0]
      await client.query(
        "UPDATE gate_commands SET status = 'sent', last_delivery_at = NOW() WHERE command_id = $1",
        [command.command_id],
      )
      await client.query('COMMIT')
      response.json({ command: {
        commandId: command.command_id,
        command: command.command_action,
        servoAngle: command.servo_angle,
        controlMode: command.control_mode,
        triggerSource: command.trigger_source,
      } })
      return
    }

    const modeCommand = await client.query<{ control_command_id: string; requested_mode: string }>(
      `SELECT control_command_id, requested_mode
       FROM device_control_commands
       WHERE device_id = $1 AND status IN ('pending', 'sent')
         AND (status = 'pending' OR last_delivery_at IS NULL OR last_delivery_at < NOW() - INTERVAL '30 seconds')
       ORDER BY issued_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [deviceId],
    )
    if (modeCommand.rowCount) {
      const command = modeCommand.rows[0]
      await client.query(
        "UPDATE device_control_commands SET status = 'sent', last_delivery_at = NOW() WHERE control_command_id = $1",
        [command.control_command_id],
      )
      await client.query('COMMIT')
      response.json({ command: {
        commandId: command.control_command_id,
        command: 'SET_CONTROL_MODE',
        controlMode: command.requested_mode,
      } })
      return
    }

    await client.query('COMMIT')
    response.json({ command: null })
  } catch (error) {
    await client.query('ROLLBACK')
    next(error)
  } finally {
    client.release()
  }
})

app.post('/api/telemetry', databaseRequired, async (request, response, next) => {
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
    if (error instanceof Error && (error.message.startsWith('Invalid telemetry:') || error.message.startsWith('Unknown device:') || error.message.includes('maintenance'))) {
      response.status(error.message.startsWith('Unknown device:') ? 404 : 400).json({ error: error.message })
      return
    }
    next(error)
  }
})

app.use((_request, response) => response.status(404).json({ error: 'Route not found.' }))
const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error('Request failed:', error instanceof Error ? error.message : error)
  response.status(500).json({ error: 'The request could not be completed.' })
}
app.use(errorHandler)

const server = app.listen(port, () => {
  console.log(`Water Flow Controller API listening on http://localhost:${port}`)
  if (!pool) console.warn('DATABASE_URL is missing; all protected application routes are unavailable.')
})

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

export async function shutdown() {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await realtime?.close()
  await pool?.end()
}

process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
