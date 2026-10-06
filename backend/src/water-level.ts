export type WaterLevelStatus = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL' | 'UNCONFIGURED'

export type LevelThresholds = {
  lowMaxPct: number | null
  normalMaxPct: number | null
  highMaxPct: number | null
}

export function classifyWaterLevel(
  percentage: number | null,
  thresholds: LevelThresholds | null,
): WaterLevelStatus {
  if (percentage === null || !thresholds ||
      thresholds.lowMaxPct === null || thresholds.normalMaxPct === null ||
      thresholds.highMaxPct === null) return 'UNCONFIGURED'
  if (percentage <= thresholds.lowMaxPct) return 'LOW'
  if (percentage <= thresholds.normalMaxPct) return 'NORMAL'
  if (percentage <= thresholds.highMaxPct) return 'HIGH'
  return 'CRITICAL'
}
