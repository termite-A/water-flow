import { useState } from 'react'
import { AlertTriangle, ChevronRight, Droplets, ShieldCheck, Waves, Eye, EyeOff } from 'lucide-react'
import type { Admin } from '../types'
import { apiRequest } from '../lib/api'

export function LoginPage({ onLogin, serverMessage }: { onLogin: (admin: Admin) => void; serverMessage: string }) {
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
