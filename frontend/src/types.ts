export type ViewName = 'dashboard' | 'water' | 'gateway' | 'history' | 'device' | 'settings'

export type Admin = { adminId: string; username: string; email: string }

export type Device = {
  deviceId: string
  deviceCode: string
  deviceName: string
  deviceType: string
  canalName: string
  barangay: string
  deviceStatus: 'ONLINE' | 'OFFLINE' | 'CONNECTING' | 'ERROR'
  gatewayStatus: 'OPEN' | 'CLOSED' | 'MOVING' | 'ERROR' | 'OFFLINE'
  servoAngle: number | null
  controlMode: 'AUTOMATIC' | 'MANUAL'
  lastCommunication: string | null
  rawSensorValue: number | null
  waterLevelPct: number | null
  waterLevelM: number | null
  waterLevelStatus: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL' | 'UNCONFIGURED' | 'INVALID' | null
  measuredAt: string | null
  readingStale: boolean
}

export type Measurement = {
  measurementId: string
  deviceId: string
  rawSensorValue: number | null
  waterLevelM: number | null
  waterLevelPct: number | null
  waterLevelStatus: string | null
  gatePositionPct: number | null
  gatewayStatus: string | null
  controlMode: string | null
  readingValid: boolean
  measuredAt: string
}

export type EventRow = {
  id: string
  type: string
  severity: string
  message: string
  occurredAt: string
  deviceCode: string | null
  actor: string | null
  details: Record<string, unknown>
}

export type DeviceSettings = {
  deviceCode: string
  deviceName: string
  controlMode: 'AUTOMATIC' | 'MANUAL'
  rawAtLowLevel: number | null
  rawAtHighLevel: number | null
  lowMaxPct: number | null
  normalMaxPct: number | null
  highMaxPct: number | null
  automaticOpenBelowPct: number | null
  automaticCloseAbovePct: number | null
  updatedAt?: string
}

export type DashboardResponse = { devices: Device[]; mqttStatus: string }

export type ApiError = Error & { status?: number }

export type HistoryFilters = {
  search: string
  status: string
  gatewayStatus: string
  controlMode: string
  from: string
  to: string
}
