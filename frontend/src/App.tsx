import { useEffect, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Bell, Check,
  ChevronDown, ChevronRight, Clock3, Droplets, Gauge,
  History, LayoutDashboard, LogOut, Menu, Radio, Settings, ShieldCheck,
  Waves, X, Eye, EyeOff, RefreshCw, Search, SlidersHorizontal,
} from 'lucide-react'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import './App.css'

type ViewName = 'dashboard' | 'water' | 'gateway' | 'history' | 'device' | 'settings'
type Admin = { adminId: string; username: string; email: string }
type Device = {
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
type Measurement = {
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
type EventRow = {
  id: string
  type: string
  severity: string
  message: string
  occurredAt: string
  deviceCode: string | null
  actor: string | null
  details: Record<string, unknown>
}
type DeviceSettings = {
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
type DashboardResponse = { devices: Device[]; mqttStatus: string }
type ApiError = Error & { status?: number }
type HistoryFilters = {
  search: string
  status: string
  gatewayStatus: string
  controlMode: string
  from: string
  to: string
}

const navigation: { id: ViewName; title: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', title: 'Dashboard', icon: LayoutDashboard },
  { id: 'water', title: 'Water level', icon: Waves },
  { id: 'gateway', title: 'Gateway control', icon: SlidersHorizontal },
  { id: 'history', title: 'Activity & history', icon: History },
  { id: 'device', title: 'IoT device', icon: Radio },
  { id: 'settings', title: 'Settings', icon: Settings },
]

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error ?? `Request failed (${response.status}).`) as ApiError
    error.status = response.status
    throw error
  }
  return body as T
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'No measurement received'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function App() {
  const [admin, setAdmin] = useState<Admin | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [sessionError, setSessionError] = useState('')

  useEffect(() => {
    let active = true
    apiRequest<{ admin: Admin }>('/auth/session')
      .then(({ admin: currentAdmin }) => { if (active) setAdmin(currentAdmin) })
      .catch((error: ApiError) => {
        if (!active) return
        if (error.status !== 401) setSessionError(error.message)
      })
      .finally(() => { if (active) setCheckingSession(false) })
    return () => { active = false }
  }, [])

  if (checkingSession) return <div className="auth-loading"><span className="spinner" /><span>Checking administrator session</span></div>
  if (!admin) return <LoginPage onLogin={setAdmin} serverMessage={sessionError} />
  return <AdminApplication admin={admin} onLogout={() => setAdmin(null)} onSessionExpired={() => setAdmin(null)} />
}

function LoginPage({ onLogin, serverMessage }: { onLogin: (admin: Admin) => void; serverMessage: string }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const result = await apiRequest<{ admin: Admin }>('/auth/login', {
        method: 'POST', body: JSON.stringify({ username, password }),
      })
      onLogin(result.admin)
    } catch (requestError) {
      setError((requestError as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <main className="login-screen">
    <div className="login-visual">
      <div className="login-watermark"><Waves size={260} strokeWidth={0.7} /></div>
      <div className="login-brand"><span className="brand-icon"><Droplets size={21} /></span><span>WATER FLOW<br />CONTROLLER</span></div>
      <div className="login-visual-copy"><span className="login-overline">PULANGI RIVER  /  VALENCIA CITY</span><h1>Water intelligence<br />for every gateway.</h1><p>Monitor calibrated water levels and manage irrigation infrastructure from one secure operations room.</p></div>
      <div className="login-visual-footer"><span><span className="signal-line" /> FIELD MONITORING</span><span>ADMINISTRATOR ACCESS ONLY</span></div>
    </div>
    <section className="login-panel"><div className="login-card">
      <div className="login-card-icon"><ShieldCheck size={20} /></div>
      <p className="login-eyebrow">SECURE CONSOLE</p><h2>Administrator sign in</h2><p className="login-help">Use your assigned administrator account to continue.</p>
      {(error || serverMessage) && <div className="login-error"><AlertTriangle size={16} /><span>{error || serverMessage}</span></div>}
      <form onSubmit={submit}>
        <label className="form-label" htmlFor="admin-name">Email or username</label>
        <input className="form-input" id="admin-name" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
        <label className="form-label password-label" htmlFor="admin-password">Password</label>
        <div className="password-wrap"><input className="form-input" id="admin-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
        <button className="login-submit" disabled={busy}>{busy ? <><span className="button-spinner" /> Verifying credentials</> : <>Sign in <ChevronRight size={17} /></>}</button>
      </form>
      <div className="login-security"><ShieldCheck size={14} /><span>Protected administrator access  /  No public registration</span></div>
    </div><footer className="login-panel-footer">PULANGI WATER OPERATIONS <span> / </span> SECURE ACCESS</footer></section>
  </main>
}

function AdminApplication({ admin, onLogout, onSessionExpired }: { admin: Admin; onLogout: () => void; onSessionExpired: () => void }) {
  const [view, setView] = useState<ViewName>('dashboard')
  const [devices, setDevices] = useState<Device[]>([])
  const [measurements, setMeasurements] = useState<Measurement[]>([])
  const [historyRows, setHistoryRows] = useState<Measurement[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [activities, setActivities] = useState<EventRow[]>([])
  const [settings, setSettings] = useState<DeviceSettings[]>([])
  const [mqttStatus, setMqttStatus] = useState('not-configured')
  const [selectedDevice, setSelectedDevice] = useState('')
  const [socketStatus, setSocketStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [pageError, setPageError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyCommand, setBusyCommand] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>({ search: '', status: '', gatewayStatus: '', controlMode: '', from: '', to: '' })
  const [historyPage, setHistoryPage] = useState(1)
  const [refreshing, setRefreshing] = useState(false)
  const pageSize = 15

  const activeDevice = devices.find((device) => device.deviceCode === selectedDevice) ?? devices[0] ?? null
  async function loadDashboard() {
    const result = await apiRequest<DashboardResponse>('/dashboard')
    setDevices(result.devices)
    setMqttStatus(result.mqttStatus)
    if (!selectedDevice && result.devices[0]) setSelectedDevice(result.devices[0].deviceCode)
  }

  async function loadHistory() {
    const query = new URLSearchParams({ page: '1', limit: '100' })
    if (activeDevice) query.set('deviceCode', activeDevice.deviceCode)
    const result = await apiRequest<{ measurements: Measurement[] }>(`/history?${query}`)
    setMeasurements(result.measurements)
  }

  async function loadActivities() {
    const result = await apiRequest<{ events: EventRow[] }>('/activities?limit=100')
    setActivities(result.events)
  }

  async function loadSettings() {
    const result = await apiRequest<{ settings: DeviceSettings[] }>('/settings')
    setSettings(result.settings)
  }

  async function refreshAll() {
    setRefreshing(true)
    setPageError('')
    try {
      const results = await Promise.allSettled([loadDashboard(), loadHistory(), loadActivities(), loadSettings()])
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') {
        if ((failed.reason as ApiError).status === 401) { onSessionExpired(); return }
        setPageError((failed.reason as Error).message)
      }
    } finally { setRefreshing(false) }
  }

  useEffect(() => { void refreshAll() }, [])

  useEffect(() => {
    if (!selectedDevice) return
    let active = true
    const fetchMeasurements = async () => {
      try {
        const query = new URLSearchParams({ page: '1', limit: '100', deviceCode: selectedDevice })
        const result = await apiRequest<{ measurements: Measurement[] }>(`/history?${query}`)
        if (active) setMeasurements(result.measurements)
      } catch (error) {
        if (active) setPageError((error as Error).message)
      }
    }
    void fetchMeasurements()
    return () => { active = false }
  }, [selectedDevice])

  useEffect(() => {
    if (view !== 'history') return
    let active = true
    const query = new URLSearchParams({ page: String(historyPage), limit: String(pageSize) })
    if (selectedDevice) query.set('deviceCode', selectedDevice)
    for (const [key, value] of Object.entries(historyFilters)) {
      if (value) query.set(key, value)
    }
    apiRequest<{ measurements: Measurement[]; total: number }>(`/history?${query}`)
      .then((result) => {
        if (!active) return
        setHistoryRows(result.measurements)
        setHistoryTotal(result.total)
      })
      .catch((error: Error) => { if (active) setPageError(error.message) })
    return () => { active = false }
  }, [view, selectedDevice, historyFilters, historyPage, pageSize])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    let active = true
    let reconnectTimer = 0
    let socket: WebSocket | null = null
    const connect = () => {
      if (!active) return
      setSocketStatus('connecting')
      socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`)
      socket.onopen = () => setSocketStatus('connected')
      socket.onclose = () => {
        if (!active) return
        setSocketStatus('offline')
        reconnectTimer = window.setTimeout(connect, 3000)
      }
      socket.onerror = () => socket?.close()
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as { type?: string; status?: string }
          if (message.type === 'mqtt' && message.status) setMqttStatus(message.status)
          void loadDashboard()
          void loadHistory()
          void loadActivities()
        } catch { setPageError('A realtime update could not be read.') }
      }
    }
    connect()
    return () => {
      active = false
      window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => { void loadDashboard() }, 30000)
    return () => window.clearInterval(timer)
  }, [selectedDevice])

  async function logout() {
    try { await apiRequest('/auth/logout', { method: 'POST' }) } catch { /* The server may be unavailable; remove local access either way. */ }
    onLogout()
  }

  async function issueGatewayCommand(command: 'OPEN_GATE' | 'CLOSE_GATE') {
    if (!activeDevice) return
    setBusyCommand(true)
    setNotice('')
    setPageError('')
    try {
      const result = await apiRequest<{ status: string; message: string }>('/gateway/commands', {
        method: 'POST', body: JSON.stringify({ deviceCode: activeDevice.deviceCode, command }),
      })
      setNotice(result.message)
      await loadActivities()
    } catch (error) {
      const apiError = error as ApiError
      if (apiError.status === 401) onSessionExpired()
      else setPageError(apiError.message)
    } finally { setBusyCommand(false) }
  }

  async function setControlMode(controlMode: 'AUTOMATIC' | 'MANUAL') {
    if (!activeDevice) return
    setPageError('')
    try {
      const result = await apiRequest<{ status: string; message: string }>(`/devices/${encodeURIComponent(activeDevice.deviceCode)}/mode`, {
        method: 'PATCH', body: JSON.stringify({ controlMode }),
      })
      setNotice(result.message)
      await loadActivities()
    } catch (error) { setPageError((error as Error).message) }
  }

  const viewTitle = navigation.find((item) => item.id === view)?.title ?? 'Dashboard'
  const pendingAlerts = activities.filter((activity) => activity.severity === 'critical' || activity.severity === 'error').length

  return <div className="app-shell">
    {mobileNavOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
    <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
      <div className="brand-lockup"><div className="brand-mark"><Droplets size={19} /></div><div><span className="brand-name">WATER FLOW</span><span className="brand-caption">CONTROLLER</span></div><button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><X size={18} /></button></div>
      <div className="workspace-switcher"><div className="workspace-icon"><Waves size={17} /></div><div className="workspace-copy"><span>Pulangi River</span><small>Valencia City  /  Admin</small></div><ChevronDown size={15} className="muted-icon" /></div>
      <span className="nav-section-label">CONTROL ROOM</span>
      <nav className="primary-nav" aria-label="Main navigation">{navigation.map(({ id, title, icon: Icon }) => <button key={id} className={`nav-link ${view === id ? 'nav-link-active' : ''}`} onClick={() => { setView(id); setMobileNavOpen(false) }}><Icon size={18} strokeWidth={1.8} /><span>{title}</span>{id === 'history' && pendingAlerts > 0 && <span className="nav-count">{pendingAlerts}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="field-status"><div className="field-status-heading"><span className={`connection-dot ${socketStatus}`} /> Realtime stream</div><p>{socketStatus === 'connected' ? 'WebSocket connected' : socketStatus === 'connecting' ? 'Connecting to backend' : 'No live event connection'}</p><small>MQTT: {mqttStatus.replace('-', ' ')}</small></div><div className="profile-row"><div className="avatar">{admin.username.slice(0, 2).toUpperCase()}</div><div className="profile-copy"><strong>{admin.username}</strong><small>Administrator</small></div><button className="icon-button profile-menu" title="Sign out" aria-label="Sign out" onClick={() => void logout()}><LogOut size={16} /></button></div></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button><div className="breadcrumb"><span>Water Flow Controller</span><ChevronRight size={14} /><strong>{viewTitle}</strong></div><div className="topbar-actions"><span className={`connection-pill ${socketStatus}`}><i />{socketStatus === 'connected' ? 'LIVE LINK' : socketStatus === 'connecting' ? 'CONNECTING' : 'OFFLINE'}</span><button className="top-icon" aria-label="Activity history" onClick={() => setView('history')}><Bell size={18} /></button><div className="top-date">{admin.email}</div></div></header>
      <div className="page-content">
        <section className="page-heading"><div><p className="eyebrow">PULANGI RIVER <span>/</span> VALENCIA CITY, BUKIDNON</p><h1>{viewTitle}</h1><p className="page-subtitle">Live measurements and gateway state from connected field devices.</p></div><div className="heading-actions">{activeDevice && <label className="device-select-label"><span>DEVICE</span><select aria-label="Select IoT device" value={selectedDevice} onChange={(event) => setSelectedDevice(event.target.value)}>{devices.map((device) => <option key={device.deviceId} value={device.deviceCode}>{device.deviceName}  /  {device.deviceCode}</option>)}</select></label>}<button className="outline-button refresh-button" onClick={() => void refreshAll()} disabled={refreshing} title="Refresh data"><RefreshCw size={15} className={refreshing ? 'spinning' : ''} /><span>Refresh</span></button></div></section>
        {pageError && <div className="error-banner"><AlertTriangle size={16} /><span>{pageError}</span><button aria-label="Dismiss error" onClick={() => setPageError('')}><X size={15} /></button></div>}
        {notice && <div className="notice-banner"><Check size={16} /><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}><X size={15} /></button></div>}
        {view === 'dashboard' && <DashboardView device={activeDevice} devices={devices} measurements={measurements} activities={activities} mqttStatus={mqttStatus} onOpenWater={() => setView('water')} onOpenGateway={() => setView('gateway')} />}
        {view === 'water' && <WaterView device={activeDevice} measurements={measurements} />}
        {view === 'gateway' && <GatewayView device={activeDevice} mqttStatus={mqttStatus} busy={busyCommand} onCommand={issueGatewayCommand} onMode={setControlMode} />}
        {view === 'history' && <HistoryView measurements={historyRows} total={historyTotal} activities={activities} device={activeDevice} filters={historyFilters} setFilters={setHistoryFilters} page={historyPage} setPage={setHistoryPage} pageSize={pageSize} />}
        {view === 'device' && <DeviceView devices={devices} mqttStatus={mqttStatus} />}
        {view === 'settings' && <SettingsView settings={settings} devices={devices} selectedDevice={selectedDevice} onSaved={async () => { await Promise.all([loadSettings(), loadDashboard(), loadActivities()]); setNotice('Calibration and level thresholds saved.') }} onError={setPageError} />}
        <footer className="page-footer"><span><span className={`footer-dot ${socketStatus}`} />{socketStatus === 'connected' ? 'Realtime data stream active' : 'Waiting for the next valid device update'}</span><span>Water level and gateway state are separate measurements</span></footer>
      </div>
    </main>
  </div>
}

function StatusBadge({ value, kind = 'water' }: { value: string | null | undefined; kind?: 'water' | 'gateway' | 'device' }) {
  const normalized = value ?? 'NO DATA'
  const style = normalized === 'ONLINE' || normalized === 'NORMAL' || normalized === 'OPEN' || normalized === 'MANUAL' ? 'positive'
    : normalized === 'HIGH' || normalized === 'MOVING' || normalized === 'CONNECTING' || normalized === 'AUTOMATIC' ? 'caution'
      : normalized === 'CRITICAL' || normalized === 'ERROR' ? 'negative' : normalized === 'LOW' ? 'low' : 'neutral'
  return <span className={`status-badge ${kind} ${style}`}><i />{normalized.replaceAll('_', ' ')}</span>
}

function WaterLevelVisual({ percentage, status }: { percentage: number | null; status: string | null }) {
  const height = percentage === null ? '0%' : `${Math.max(0, Math.min(100, percentage))}%`
  return <div className="water-visual" aria-label={percentage === null ? 'No calibrated water-level reading' : `Water level ${percentage} percent, ${status ?? 'status unconfigured'}`}><div className="tank-scale"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div><div className="tank"><div className="tank-grid"><i /><i /><i /><i /></div><div className="tank-water" style={{ height }}><span className="water-wave" /></div><div className="tank-empty-copy">{percentage === null ? 'NO READING' : ''}</div></div><span className="tank-unit">%</span></div>
}

function DashboardView({ device, devices, measurements, activities, mqttStatus, onOpenWater, onOpenGateway }: { device: Device | null; devices: Device[]; measurements: Measurement[]; activities: EventRow[]; mqttStatus: string; onOpenWater: () => void; onOpenGateway: () => void }) {
  const currentPct = device?.readingStale ? null : device?.waterLevelPct ?? null
  const chartData = [...measurements].reverse().filter((row) => row.readingValid && row.waterLevelPct !== null).map((row) => ({ time: new Date(row.measuredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), level: Number(row.waterLevelPct) }))
  const lastValid = device?.measuredAt && !device.readingStale ? formatDate(device.measuredAt) : 'No recent valid measurement'
  return <>
    <section className="hero-grid">
      <article className="level-card"><div className="level-card-top"><div><span className="panel-kicker">CURRENT WATER LEVEL</span><div className="level-primary">{currentPct === null ? '--' : currentPct.toFixed(1)}<small>%</small></div></div><WaterLevelVisual percentage={currentPct} status={device?.waterLevelStatus ?? null} /></div><div className="level-card-bottom"><div><span>CONDITION</span><StatusBadge value={currentPct === null ? device?.readingStale ? 'STALE' : 'NO DATA' : device?.waterLevelStatus} /></div><div><span>RAW SENSOR</span><strong>{currentPct === null ? '--' : device?.rawSensorValue ?? '--'}</strong></div><div><span>LAST VALID UPDATE</span><strong className="level-timestamp">{lastValid}</strong></div></div><button className="inline-link" onClick={onOpenWater}>View water-level history <ChevronRight size={15} /></button></article>
      <article className="gateway-card"><div className="panel-heading"><div><span className="panel-kicker">PHYSICAL GATEWAY</span><h2>Gateway state</h2></div><span className="gateway-glyph"><SlidersHorizontal size={18} /></span></div><div className="gateway-status-large"><StatusBadge value={device?.deviceStatus === 'OFFLINE' ? 'OFFLINE' : device?.gatewayStatus} kind="gateway" /></div><div className="gateway-reading"><div><span>SERVO ANGLE</span><strong>{device?.servoAngle === null || device?.servoAngle === undefined ? '--' : `${device.servoAngle} deg`}</strong></div><div><span>CONTROL MODE</span><StatusBadge value={device?.controlMode ?? 'UNCONFIGURED'} kind="gateway" /></div></div><div className="gateway-device-line"><span className={`mini-dot ${device?.deviceStatus === 'ONLINE' ? 'online' : ''}`} />{device?.deviceStatus ?? 'DEVICE NOT REGISTERED'}<span> / </span>{mqttStatus === 'connected' ? 'MQTT ready' : device?.deviceStatus === 'ONLINE' ? 'HTTP poll online' : 'No device command link'}</div><button className="gateway-manage" onClick={onOpenGateway}>Manage gateway <ChevronRight size={15} /></button></article>
    </section>
    <section className="metric-grid compact-metrics"><MetricCard label="REGISTERED DEVICES" value={String(devices.length)} detail={devices.length ? `${devices.filter((entry) => entry.deviceStatus === 'ONLINE').length} currently online` : 'No devices registered'} icon={Radio} tone="blue" /><MetricCard label="MEASUREMENTS STORED" value={String(measurements.length)} detail="From PostgreSQL history" icon={Activity} tone="teal" /><MetricCard label="WATER STATUS" value={device?.waterLevelStatus ?? '--'} detail={device?.readingStale ? 'Reading is stale' : 'Based on saved thresholds'} icon={Droplets} tone="amber" /><MetricCard label="GATEWAY MODE" value={device?.controlMode ?? '--'} detail="Independent from water status" icon={Gauge} tone="green" /></section>
    <section className="content-grid live-content-grid"><article className="panel chart-panel"><div className="panel-heading"><div><span className="panel-kicker">DATABASE MEASUREMENTS</span><h2>Water level history</h2><p>Recorded measurements  /  percentage</p></div><button className="text-button" onClick={onOpenWater}>Full history <ChevronRight size={15} /></button></div>{chartData.length ? <WaterChart data={chartData} /> : <EmptyPanel title="No water-level history yet" detail="The chart will populate after a calibrated measurement is received and stored." icon={Activity} />}<div className="chart-footnote"><span><i className="legend-dot" />Stored water-level measurements</span><span className="live-data-note">PostgreSQL source</span></div></article><article className="panel alert-panel"><div className="panel-heading compact-heading"><div><span className="panel-kicker">SYSTEM EVENT LOG</span><h2>Recent activity</h2></div><span className={`connection-pill ${mqttStatus === 'connected' ? 'connected' : 'offline'}`}><i />{mqttStatus === 'connected' ? 'MQTT ONLINE' : 'MQTT OFFLINE'}</span></div>{activities.length ? <div className="activity-list">{activities.slice(0, 5).map((event) => <ActivityRow key={`${event.type}-${event.id}`} event={event} />)}</div> : <EmptyPanel title="No activity recorded" detail="Device and administrator events will appear here." icon={Clock3} compact />}<div className="activity-panel-foot"><span><span className="footer-dot" />Events are stored in PostgreSQL</span></div></article></section>
  </>
}

function WaterChart({ data }: { data: { time: string; level: number }[] }) {
  return <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data} margin={{ top: 12, right: 8, left: -12, bottom: 0 }}><defs><linearGradient id="waterFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2588b8" stopOpacity={0.24} /><stop offset="95%" stopColor="#2588b8" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid vertical={false} stroke="#e5edf1" strokeDasharray="3 5" /><XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: '#83939d', fontSize: 10 }} dy={8} /><YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} axisLine={false} tickLine={false} tick={{ fill: '#83939d', fontSize: 10 }} tickFormatter={(value: number) => `${value}%`} /><Tooltip contentStyle={{ border: '1px solid #dce7ed', borderRadius: 7, fontSize: 11 }} formatter={(value) => [`${Number(value).toFixed(1)}%`, 'Water level']} /><Area type="monotone" dataKey="level" stroke="#2588b8" strokeWidth={2.5} fill="url(#waterFill)" activeDot={{ r: 5, fill: '#2588b8', stroke: '#fff', strokeWidth: 2 }} /></AreaChart></ResponsiveContainer></div>
}

function MetricCard({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: typeof Gauge; tone: string }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}><Icon size={17} /></span></div><div className={`metric-value ${value.length > 11 ? 'value-long' : ''}`}>{value}</div><div className="metric-detail">{detail}</div></article>
}

function WaterView({ device, measurements }: { device: Device | null; measurements: Measurement[] }) {
  const values = measurements.filter((item) => item.readingValid).map((item) => item.waterLevelPct).filter((value): value is number => value !== null)
  const stats = values.length ? { min: Math.min(...values), max: Math.max(...values), avg: values.reduce((sum, value) => sum + value, 0) / values.length } : null
  const data = [...measurements].reverse().filter((row) => row.readingValid && row.waterLevelPct !== null).map((row) => ({ time: formatDate(row.measuredAt), level: Number(row.waterLevelPct) }))
  const current = device?.readingStale ? null : device?.waterLevelPct ?? null
  return <><section className="water-detail-grid"><article className="panel water-current-panel"><div className="panel-heading"><div><span className="panel-kicker">LATEST STORED MEASUREMENT</span><h2>Water level</h2></div><StatusBadge value={current === null ? device?.readingStale ? 'STALE' : 'NO DATA' : device?.waterLevelStatus} /></div><div className="water-current-content"><WaterLevelVisual percentage={current} status={device?.waterLevelStatus ?? null} /><div className="water-current-numbers"><strong>{current === null ? '--' : `${current.toFixed(1)}%`}</strong><span>{device?.waterLevelM === null || device?.waterLevelM === undefined ? 'Physical unit not calibrated' : `${device.waterLevelM.toFixed(2)} m`}</span><div className="raw-reading"><span>RAW SENSOR READING</span><b>{device?.rawSensorValue ?? '--'}</b></div><div className="raw-reading"><span>MEASURED AT</span><b>{formatDate(device?.measuredAt)}</b></div></div></div></article><div className="water-stat-stack"><MetricCard label="MINIMUM RECORDED" value={stats ? `${stats.min.toFixed(1)}%` : '--'} detail="Selected history result" icon={ArrowDownRight} tone="blue" /><MetricCard label="MAXIMUM RECORDED" value={stats ? `${stats.max.toFixed(1)}%` : '--'} detail="Selected history result" icon={ArrowUpRight} tone="teal" /><MetricCard label="AVERAGE LEVEL" value={stats ? `${stats.avg.toFixed(1)}%` : '--'} detail={`${values.length} stored measurements`} icon={Activity} tone="amber" /></div></section><section className="panel water-history-panel"><div className="panel-heading"><div><span className="panel-kicker">POSTGRESQL RECORDS</span><h2>Water-level trend</h2><p>Only valid, stored sensor measurements are plotted.</p></div><span className="record-count">{values.length} records</span></div>{data.length ? <WaterChart data={data} /> : <EmptyPanel title="No measurements available" detail="Connect a calibrated IoT sensor and save its first reading to view a trend." icon={Waves} />}</section></>
}

function GatewayView({ device, mqttStatus, busy, onCommand, onMode }: { device: Device | null; mqttStatus: string; busy: boolean; onCommand: (command: 'OPEN_GATE' | 'CLOSE_GATE') => void; onMode: (mode: 'AUTOMATIC' | 'MANUAL') => void }) {
  const canControl = device?.deviceStatus === 'ONLINE' && device.controlMode === 'MANUAL' && !busy
  const canChangeMode = device?.deviceStatus === 'ONLINE' && !busy
  return <><section className="gateway-detail-grid"><article className="panel gateway-state-panel"><div className="panel-heading"><div><span className="panel-kicker">DEVICE-REPORTED POSITION</span><h2>Physical gateway</h2></div><StatusBadge kind="gateway" value={device?.deviceStatus === 'OFFLINE' ? 'OFFLINE' : device?.gatewayStatus} /></div><div className="gate-illustration"><div className={`gate-water ${device?.gatewayStatus === 'OPEN' ? 'gate-open' : ''}`}><span className="gate-water-line" /><span className="gate-water-line two" /></div><div className="gate-frame"><span /><span /><i /></div></div><div className="gate-facts"><div><span>GATE STATUS</span><StatusBadge kind="gateway" value={device?.deviceStatus === 'OFFLINE' ? 'OFFLINE' : device?.gatewayStatus} /></div><div><span>SERVO ANGLE</span><strong>{device?.servoAngle === null || device?.servoAngle === undefined ? '--' : `${device.servoAngle} deg`}</strong></div><div><span>CONTROL MODE</span><StatusBadge kind="gateway" value={device?.controlMode} /></div></div></article><article className="panel gateway-control-panel"><span className="panel-kicker">AUTHORIZED CONTROL</span><h2>Gateway commands</h2><p>Commands are sent to the IoT device. The displayed gateway state changes only after device confirmation.</p><div className="command-buttons"><button className="open-gate-button" disabled={!canControl} onClick={() => onCommand('OPEN_GATE')}><ArrowUpRight size={17} />{busy ? 'Sending...' : 'Open gate'}<small>Servo target  /  135 deg</small></button><button className="close-gate-button" disabled={!canControl} onClick={() => onCommand('CLOSE_GATE')}><ArrowDownRight size={17} />{busy ? 'Sending...' : 'Close gate'}<small>Servo target  /  0 deg</small></button></div><div className="control-block-note"><AlertTriangle size={16} /><span>{device?.deviceStatus !== 'ONLINE' ? 'Device is offline. Gateway commands are disabled.' : mqttStatus !== 'connected' ? 'MQTT is offline; commands queue until the device polls over HTTP.' : device.controlMode !== 'MANUAL' ? 'Switch to manual mode before issuing direct commands.' : 'Device must confirm its physical position after every command.'}</span></div><div className="mode-section"><div><strong>Control mode</strong><span>Water-level conditions do not describe gateway position.</span></div><div className="mode-switch"><button disabled={!canChangeMode} className={device?.controlMode === 'MANUAL' ? 'active' : ''} onClick={() => onMode('MANUAL')}>Manual</button><button disabled={!canChangeMode} className={device?.controlMode === 'AUTOMATIC' ? 'active' : ''} onClick={() => onMode('AUTOMATIC')}>Automatic</button></div></div></article></section><section className="panel gateway-safety"><ShieldCheck size={18} /><div><strong>Command lifecycle</strong><p>Queued to sent over MQTT to confirmed by a device status report. A sent command alone does not prove the gate moved.</p></div><span className="mqtt-indicator"><i className={mqttStatus === 'connected' ? 'online' : ''} /> MQTT {mqttStatus.toUpperCase()}</span></section></>
}

function HistoryView({ measurements, total, activities, device, filters, setFilters, page, setPage, pageSize }: { measurements: Measurement[]; total: number; activities: EventRow[]; device: Device | null; filters: HistoryFilters; setFilters: (value: HistoryFilters) => void; page: number; setPage: (page: number) => void; pageSize: number }) {
  const [eventType, setEventType] = useState('')
  const filteredActivities = activities.filter((event) => !eventType || event.type === eventType)
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const visible = measurements
  return <><section className="panel history-panel"><div className="panel-heading"><div><span className="panel-kicker">LATEST FIRST  /  DATABASE RECORDS</span><h2>Water measurements</h2></div><span className="record-count">{total} records</span></div><div className="filter-bar"><label className="search-field"><Search size={14} /><input aria-label="Search readings" placeholder="Search device or raw value" value={filters.search} onChange={(event) => { setPage(1); setFilters({ ...filters, search: event.target.value }) }} /></label><select aria-label="Filter water status" value={filters.status} onChange={(event) => { setPage(1); setFilters({ ...filters, status: event.target.value }) }}><option value="">All water statuses</option>{['LOW', 'NORMAL', 'HIGH', 'CRITICAL', 'UNCONFIGURED', 'INVALID'].map((status) => <option key={status}>{status}</option>)}</select><select aria-label="Filter gateway status" value={filters.gatewayStatus} onChange={(event) => { setPage(1); setFilters({ ...filters, gatewayStatus: event.target.value }) }}><option value="">All gateway statuses</option><option value="OPEN">OPEN</option><option value="CLOSED">CLOSED</option><option value="MOVING">MOVING</option><option value="ERROR">ERROR</option><option value="OFFLINE">OFFLINE</option></select><select aria-label="Filter control mode" value={filters.controlMode} onChange={(event) => { setPage(1); setFilters({ ...filters, controlMode: event.target.value }) }}><option value="">All modes</option><option value="MANUAL">MANUAL</option><option value="AUTOMATIC">AUTOMATIC</option></select><input aria-label="From date" type="date" value={filters.from} onChange={(event) => { setPage(1); setFilters({ ...filters, from: event.target.value }) }} /><input aria-label="To date" type="date" value={filters.to} onChange={(event) => { setPage(1); setFilters({ ...filters, to: event.target.value }) }} /></div><div className="table-scroll"><table className="data-table"><thead><tr><th>MEASURED AT</th><th>DEVICE</th><th>RAW SENSOR</th><th>WATER LEVEL</th><th>CONDITION</th><th>GATEWAY</th><th>GATE POSITION</th><th>MODE</th></tr></thead><tbody>{visible.map((row) => <tr key={row.measurementId}><td>{formatDate(row.measuredAt)}</td><td>{row.deviceId}</td><td>{row.rawSensorValue ?? '--'}</td><td>{row.waterLevelPct === null ? '--' : `${Number(row.waterLevelPct).toFixed(1)}%`}{row.waterLevelM === null ? '' : `  /  ${Number(row.waterLevelM).toFixed(2)} m`}</td><td><StatusBadge value={row.waterLevelStatus} /></td><td><StatusBadge kind="gateway" value={row.gatewayStatus} /></td><td>{row.gatePositionPct === null ? '--' : `${row.gatePositionPct}%`}</td><td>{row.controlMode ?? '--'}</td></tr>)}</tbody></table></div>{visible.length === 0 && <EmptyPanel title="No matching measurements" detail="Try changing the filters, or wait for a valid sensor reading." icon={History} compact />}<div className="pagination"><span>Page {page} of {pageCount}</span><div><button className="outline-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button className="outline-button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button></div></div><div className="active-device-note">Filtered to selected device: <strong>{device?.deviceCode ?? 'No device selected'}</strong></div></section><section className="panel event-history-panel"><div className="panel-heading"><div><span className="panel-kicker">SYSTEM AND GATEWAY EVENTS</span><h2>Activity history</h2></div><select className="event-filter" aria-label="Filter event type" value={eventType} onChange={(event) => setEventType(event.target.value)}><option value="">All event types</option>{Array.from(new Set(activities.map((item) => item.type))).map((type) => <option key={type}>{type}</option>)}</select></div>{filteredActivities.length ? <div className="activity-list expanded-activity">{filteredActivities.map((event) => <ActivityRow key={`${event.type}-${event.id}`} event={event} />)}</div> : <EmptyPanel title="No events recorded" detail="Login, sensor, gateway and communication events will be stored here." icon={Activity} compact />}</section></>
}

function ActivityRow({ event }: { event: EventRow }) {
  const date = new Date(event.occurredAt)
  return <div className="activity-row"><span className={`activity-marker ${event.severity}`}><i /></span><div className="activity-content"><strong>{event.message}</strong><span>{event.deviceCode ?? event.actor ?? 'System'}{event.actor && event.deviceCode ? `  /  ${event.actor}` : ''}</span></div><time>{Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>
}

function DeviceView({ devices, mqttStatus }: { devices: Device[]; mqttStatus: string }) {
  return <section className="panel device-panel"><div className="panel-heading"><div><span className="panel-kicker">DEVICE REGISTRY  /  POSTGRESQL</span><h2>IoT devices</h2></div><span className={`connection-pill ${mqttStatus === 'connected' ? 'connected' : 'offline'}`}><i /> MQTT {mqttStatus.toUpperCase()}</span></div>{devices.length ? <div className="device-grid">{devices.map((device) => <article className="device-card" key={device.deviceId}><div className="device-card-header"><span className="device-card-icon"><Radio size={19} /></span><StatusBadge kind="device" value={device.deviceStatus} /></div><h3>{device.deviceName}</h3><p>{device.deviceCode}  /  {device.deviceType}</p><dl><div><dt>Canal</dt><dd>{device.canalName}</dd></div><div><dt>Water level</dt><dd>{device.readingStale ? 'STALE' : device.waterLevelPct === null ? 'NO READING' : `${device.waterLevelPct}%  /  ${device.waterLevelStatus ?? 'UNCONFIGURED'}`}</dd></div><div><dt>Gateway</dt><dd>{device.gatewayStatus}  /  {device.servoAngle === null ? 'angle unknown' : `${device.servoAngle} deg`}</dd></div><div><dt>Control mode</dt><dd>{device.controlMode}</dd></div><div><dt>Last communication</dt><dd>{formatDate(device.lastCommunication)}</dd></div></dl></article>)}</div> : <EmptyPanel title="No IoT devices registered" detail="Add a device row in PostgreSQL after applying the existing schema extensions. No device is assumed online." icon={Radio} />}</section>
}

function SettingsView({ settings, devices, selectedDevice, onSaved, onError }: { settings: DeviceSettings[]; devices: Device[]; selectedDevice: string; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const current = settings.find((entry) => entry.deviceCode === selectedDevice)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setForm({
      rawAtLowLevel: current?.rawAtLowLevel?.toString() ?? '', rawAtHighLevel: current?.rawAtHighLevel?.toString() ?? '',
      lowMaxPct: current?.lowMaxPct?.toString() ?? '', normalMaxPct: current?.normalMaxPct?.toString() ?? '',
      highMaxPct: current?.highMaxPct?.toString() ?? '', automaticOpenBelowPct: current?.automaticOpenBelowPct?.toString() ?? '',
      automaticCloseAbovePct: current?.automaticCloseAbovePct?.toString() ?? '',
    })
  }, [selectedDevice, current?.updatedAt])
  const fields = [
    { key: 'rawAtLowLevel', label: 'Raw sensor value at low-water reference', hint: 'Measured value from the installed sensor' },
    { key: 'rawAtHighLevel', label: 'Raw sensor value at high-water reference', hint: 'Measured value from the installed sensor' },
    { key: 'lowMaxPct', label: 'LOW status upper limit (%)', hint: '' },
    { key: 'normalMaxPct', label: 'NORMAL status upper limit (%)', hint: '' },
    { key: 'highMaxPct', label: 'HIGH status upper limit (%)', hint: 'Above this limit is CRITICAL' },
    { key: 'automaticOpenBelowPct', label: 'Automatic open below (%)', hint: 'Requires stakeholder-approved policy' },
    { key: 'automaticCloseAbovePct', label: 'Automatic close above (%)', hint: 'Requires stakeholder-approved policy' },
  ]
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedDevice) return
    setSaving(true)
    onError('')
    const data = Object.fromEntries(fields.map(({ key }) => [key, form[key] === '' ? null : Number(form[key])]))
    try {
      await apiRequest(`/settings/${encodeURIComponent(selectedDevice)}`, { method: 'PUT', body: JSON.stringify(data) })
      await onSaved()
    } catch (error) { onError((error as Error).message) }
    finally { setSaving(false) }
  }
  return <section className="panel settings-panel"><div className="panel-heading"><div><span className="panel-kicker">CALIBRATION AND CONTROL POLICY</span><h2>Water-level configuration</h2><p>Thresholds are intentionally blank until calibrated and approved for this canal.</p></div></div>{devices.length ? <form className="settings-form" onSubmit={save}><div className="settings-device-line"><span>Selected device</span><strong>{selectedDevice}</strong></div><div className="settings-form-grid">{fields.map(({ key, label, hint }) => <label className="settings-field" key={key}><span>{label}</span><input type="number" step="any" min="0" max={key.startsWith('raw') ? 65535 : 100} value={form[key] ?? ''} onChange={(event) => setForm({ ...form, [key]: event.target.value })} placeholder="Not configured" /><small>{hint || (key.startsWith('raw') ? 'Calibration endpoint; not a guessed conversion.' : 'Enter the locally approved threshold.')}</small></label>)}</div><div className="settings-warning"><AlertTriangle size={16} /><span>Automatic movement stays unavailable until real sensor calibration, safe gateway feedback, and operating thresholds are configured.</span></div><button className="solid-button save-settings" disabled={saving}>{saving ? 'Saving...' : 'Save configuration'}</button></form> : <EmptyPanel title="No device settings available" detail="Register the IoT device in PostgreSQL before configuring thresholds or calibration." icon={Settings} />}</section>
}

function EmptyPanel({ title, detail, icon: Icon, compact = false }: { title: string; detail: string; icon: typeof Activity; compact?: boolean }) {
  return <div className={`empty-panel ${compact ? 'compact' : ''}`}><div className="empty-icon"><Icon size={19} /></div><strong>{title}</strong><p>{detail}</p></div>
}

export default App
