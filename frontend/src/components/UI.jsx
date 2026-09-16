import { useEffect } from 'react'
import { Icon } from './Icons'
import { statusLabel } from '../lib/format'

export function PageHeader({ title, description, actions }) {
  return <div className="page-header">
    <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>
}

export function Card({ title, action, children, className = '' }) {
  return <section className={`card ${className}`}>
    {(title || action) && <header className="card-header"><h2>{title}</h2>{action}</header>}
    <div className="card-body">{children}</div>
  </section>
}

export function MetricCard({ label, value, detail, tone = 'neutral', icon = 'train' }) {
  return <div className={`metric-card metric-${tone}`}>
    <div className="metric-top"><span className="metric-icon"><Icon name={icon}/></span><span>{label}</span></div>
    <strong>{value}</strong>{detail && <small>{detail}</small>}
  </div>
}

export function Badge({ value, tone }) {
  const resolved = tone || ({ faulty: 'danger', maintenance: 'warning', idle: 'info', in_service: 'success', overdue: 'danger', maintenance_due: 'warning', due_soon: 'info', confirmed: 'success', completed: 'success', partially_completed: 'warning', proposed: 'info', cancelled: 'muted', active: 'success', withdrawn: 'danger' }[value] || 'muted')
  const vehicleStatus = ['faulty', 'maintenance', 'in_service', 'idle'].includes(value) ? ' badge-vehicle-status' : ''
  return <span className={`badge badge-${resolved}${vehicleStatus}`}>{statusLabel(value)}</span>
}

export function StatePanel({ type = 'empty', title, message, action }) {
  return <div className={`state-panel state-${type}`}><Icon name={type === 'error' ? 'alert' : type === 'loading' ? 'refresh' : 'train'} size={24}/><h3>{title}</h3><p>{message}</p>{action}</div>
}

export function DataBoundary({ loading, error, empty, onRetry, children }) {
  if (loading) return <StatePanel type="loading" title="Loading operational data" message="Reading the latest records from Supabase…"/>
  if (error) return <StatePanel type="error" title="Dashboard data is unavailable" message={error} action={<button className="button button-secondary" onClick={() => onRetry()}>Try again</button>}/>
  if (empty) return <StatePanel title="No records to show" message="The connection is working, but this dataset has no matching records."/>
  return children
}

export function Progress({ value, tone = 'teal' }) {
  return <div className="progress"><span className={`progress-${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }}/></div>
}

export function Toast({ message, tone = 'success', onClose }) {
  useEffect(() => {
    if (!message) return undefined
    const timeout = globalThis.setTimeout(() => onClose?.(), 5000)
    return () => globalThis.clearTimeout(timeout)
  }, [message, onClose])
  if (!message) return null
  return <div className={`toast toast-${tone}`} role="status"><Icon name={tone === 'danger' ? 'alert' : 'check'}/><span>{message}</span><button aria-label="Dismiss" onClick={onClose}>×</button></div>
}
