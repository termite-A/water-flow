import { Router } from 'express'
import { z } from 'zod'
import type { Admin } from '../auth.js'
import type { ApiContext } from './context.js'

const modeSchema = z.object({ controlMode: z.enum(['AUTOMATIC', 'MANUAL']) })
const commandSchema = z.object({
  deviceCode: z.string().trim().min(1).max(80),
  command: z.enum(['OPEN_GATE', 'CLOSE_GATE']),
})

export function createGatewayRouter({ pool, databaseRequired, requireAdmin, requireSameOrigin, getRealtime, logEvent, sendGatewayCommand }: ApiContext) {
  const router = Router()

  router.patch('/devices/:deviceCode/mode', databaseRequired, requireAdmin, requireSameOrigin, async (request, response, next) => {
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
      const payload = {
        commandId, command: 'SET_CONTROL_MODE', controlMode: parsed.data.controlMode,
        issuedAt: new Date().toISOString(),
      }
      const sent = getRealtime()?.mqttStatus === 'connected'
        ? await getRealtime()!.publishCommand(deviceCode, payload)
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
      getRealtime()?.broadcast({ type: 'control-mode-command', commandId, deviceCode, status })
      response.status(202).json({ commandId, status, message: sent
        ? 'Mode command sent; the displayed mode changes after device confirmation.'
        : 'Mode command queued; waiting for the device HTTP poll.' })
    } catch (error) { next(error) }
  })

  router.post('/gateway/commands', databaseRequired, requireAdmin, requireSameOrigin, async (request, response, next) => {
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

  router.get('/device/commands', databaseRequired, async (request, response, next) => {
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
          commandId: command.command_id, command: command.command_action,
          servoAngle: command.servo_angle, controlMode: command.control_mode,
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
          commandId: command.control_command_id, command: 'SET_CONTROL_MODE',
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

  return router
}
