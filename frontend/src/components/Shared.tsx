import { Activity, Gauge } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { EventRow } from '../types'

export function StatusBadge({ value, kind = 'water' }: { value: string | null | undefined; kind?: 'water' | 'gateway' | 'device' }) {
  const normalized = value ?? 'NO DATA'
  const style = normalized === 'ONLINE' || normalized === 'NORMAL' || normalized === 'OPEN' || normalized === 'MANUAL' ? 'positive'
    : normalized === 'HIGH' || normalized === 'MOVING' || normalized === 'CONNECTING' || normalized === 'AUTOMATIC' ? 'caution'
      : normalized === 'CRITICAL' || normalized === 'ERROR' ? 'negative' : normalized === 'LOW' ? 'low' : 'neutral'
  return <span className={`status-badge ${kind} ${style}`}><i />{normalized.replaceAll('_', ' ')}</span>
}

export function WaterLevelVisual({ percentage, status }: { percentage: number | null; status: string | null }) {
  const height = percentage === null ? '0%' : `${Math.max(0, Math.min(100, percentage))}%`
  return <div className="water-visual" aria-label={percentage === null ? 'No calibrated water-level reading' : `Water level ${percentage} percent, ${status ?? 'status unconfigured'}`}><div className="tank-scale"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div><div className="tank"><div className="tank-grid"><i /><i /><i /><i /></div><div className="tank-water" style={{ height }}><span className="water-wave" /></div><div className="tank-empty-copy">{percentage === null ? 'NO READING' : ''}</div></div><span className="tank-unit">%</span></div>
}

export function WaterChart({ data }: { data: { time: string; level: number }[] }) {
  return <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data} margin={{ top: 12, right: 8, left: -12, bottom: 0 }}><defs><linearGradient id="waterFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2588b8" stopOpacity={0.24} /><stop offset="95%" stopColor="#2588b8" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid vertical={false} stroke="#e5edf1" strokeDasharray="3 5" /><XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: '#83939d', fontSize: 10 }} dy={8} /><YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} axisLine={false} tickLine={false} tick={{ fill: '#83939d', fontSize: 10 }} tickFormatter={(value: number) => `${value}%`} /><Tooltip contentStyle={{ border: '1px solid #dce7ed', borderRadius: 7, fontSize: 11 }} formatter={(value) => [`${Number(value).toFixed(1)}%`, 'Water level']} /><Area type="monotone" dataKey="level" stroke="#2588b8" strokeWidth={2.5} fill="url(#waterFill)" activeDot={{ r: 5, fill: '#2588b8', stroke: '#fff', strokeWidth: 2 }} /></AreaChart></ResponsiveContainer></div>
}

export function MetricCard({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: typeof Gauge; tone: string }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}><Icon size={17} /></span></div><div className={`metric-value ${value.length > 11 ? 'value-long' : ''}`}>{value}</div><div className="metric-detail">{detail}</div></article>
}

export function ActivityRow({ event }: { event: EventRow }) {
  const date = new Date(event.occurredAt)
  return <div className="activity-row"><span className={`activity-marker ${event.severity}`}><i /></span><div className="activity-content"><strong>{event.message}</strong><span>{event.deviceCode ?? event.actor ?? 'System'}{event.actor && event.deviceCode ? `  /  ${event.actor}` : ''}</span></div><time>{Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>
}

export function EmptyPanel({ title, detail, icon: Icon, compact = false }: { title: string; detail: string; icon: typeof Activity; compact?: boolean }) {
  return <div className={`empty-panel ${compact ? 'compact' : ''}`}><div className="empty-icon"><Icon size={19} /></div><strong>{title}</strong><p>{detail}</p></div>
}
