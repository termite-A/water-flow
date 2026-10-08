import { Router } from 'express'
import { z } from 'zod'
import type { Admin } from '../auth.js'
import type { ApiContext } from './context.js'

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

export function createSettingsRouter({ pool, databaseRequired, requireAdmin, requireSameOrigin, logEvent, getRealtime }: ApiContext) {
  const router = Router()

  router.get('/', databaseRequired, requireAdmin, async (_request, response, next) => {
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

  router.put('/:deviceCode', databaseRequired, requireAdmin, requireSameOrigin, async (request, response, next) => {
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
      getRealtime()?.broadcast({ type: 'settings', deviceCode: request.params.deviceCode })
      response.json({ saved: true })
    } catch (error) { next(error) }
  })

  return router
}
