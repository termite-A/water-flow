import { useEffect, useState } from 'react'
import { AlertTriangle, Settings } from 'lucide-react'
import type { Device, DeviceSettings } from '../types'
import { apiRequest } from '../lib/api'
import { EmptyPanel } from '../components/Shared'

export function SettingsView({ settings, devices, selectedDevice, onSaved, onError }: { settings: DeviceSettings[]; devices: Device[]; selectedDevice: string; onSaved: () => Promise<void>; onError: (message: string) => void }) {
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
