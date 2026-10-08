import { useEffect, useState } from 'react'
import { AlertTriangle, Bell, Check, ChevronDown, ChevronRight, Droplets, History, LayoutDashboard, LogOut, Menu, Radio, Settings, Waves, X, RefreshCw, SlidersHorizontal } from 'lucide-react'
import type { ViewName, Admin, Device, Measurement, EventRow, DeviceSettings, DashboardResponse, ApiError, HistoryFilters } from './types'
import { apiRequest } from './lib/api'
import { DashboardView } from './pages/DashboardPage'
import { WaterView } from './pages/WaterPage'
import { GatewayView } from './pages/GatewayPage'
import { HistoryView } from './pages/HistoryPage'
import { DeviceView } from './pages/DevicePage'
import { SettingsView } from './pages/SettingsPage'
import { LoginPage } from './pages/LoginPage'
import './App.css'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'

const navigation: { id: ViewName; title: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', title: 'Dashboard', icon: LayoutDashboard },
  { id: 'water', title: 'Water level', icon: Waves },
  { id: 'gateway', title: 'Gateway control', icon: SlidersHorizontal },
  { id: 'history', title: 'Activity & history', icon: History },
  { id: 'device', title: 'IoT device', icon: Radio },
  { id: 'settings', title: 'Settings', icon: Settings },
]





function App() {
  const location = useLocation()
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

  if (!admin) {
    if (location.pathname !== '/login') return <Navigate to="/login" replace />
    return <LoginPage onLogin={setAdmin} serverMessage={sessionError} />
  }

  const validPage = navigation.some((item) => location.pathname === '/' + item.id)
  if (!validPage) return <Navigate to="/dashboard" replace />

  return <AdminApplication admin={admin} onLogout={() => setAdmin(null)} onSessionExpired={() => setAdmin(null)} />
}



function AdminApplication({ admin, onLogout, onSessionExpired }: { admin: Admin; onLogout: () => void; onSessionExpired: () => void }) {
  const location = useLocation()
const navigate = useNavigate()
const view = (navigation.find((item) => location.pathname === '/' + item.id)?.id ?? 'dashboard') as ViewName
const setView = (id: ViewName) => navigate('/' + id)
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

























export default App
