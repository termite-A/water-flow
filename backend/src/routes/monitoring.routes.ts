import { Router } from 'express'
import type { ApiContext } from './context.js'

export function createMonitoringRouter({ pool, databaseRequired, requireAdmin, getRealtime }: ApiContext) {
  const router = Router()

  router.get('/dashboard', databaseRequired, requireAdmin, async (_request, response, next) => {
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
      response.json({ devices: result.rows, mqttStatus: getRealtime()?.mqttStatus ?? 'not-configured' })
    } catch (error) { next(error) }
  })

  router.get('/devices', databaseRequired, requireAdmin, async (_request, response, next) => {
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
      response.json({ devices: result.rows, mqttStatus: getRealtime()?.mqttStatus ?? 'not-configured' })
    } catch (error) { next(error) }
  })

  router.get('/history', databaseRequired, requireAdmin, async (request, response, next) => {
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

  router.get('/activities', databaseRequired, requireAdmin, async (request, response, next) => {
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

  return router
}
