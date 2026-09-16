import { useState } from 'react'
import { Icon } from './Icons'
import { formatDate } from '../lib/format'
import { resetDashboardDemo } from '../lib/api'
import { Toast } from './UI'

const navItems = [
  ['fleet', 'grid', 'Fleet Overview'], ['maintenance', 'wrench', 'Maintenance Planning'],
  ['deployment', 'pin', 'Fleet Deployment'], ['evidence', 'evidence', 'Evidence'],
]

export function Layout({ route, navigate, children, updatedAt }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState(null)
  const active = route.page === 'vehicle' ? 'fleet' : route.page
  const go = (page) => { navigate(page); setSidebarOpen(false) }
  const resetDemo = async () => {
    if (!globalThis.confirm('Reset all dashboard test actions to the seeded starting state? Stop the MQTT simulator first or it will immediately add new events.')) return
    setResetting(true); setResetError(null)
    try {
      await resetDashboardDemo()
      globalThis.location.reload()
    } catch (error) {
      setResetError(error.message); setResetting(false); setMenuOpen(false)
    }
  }
  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="brand">
        <div className="brand-logo"><img src="/lta-logo.png" alt="Land Transport Authority"/></div>
        <div className="brand-copy"><strong>LRV Maintenance</strong><span>SPLRT Operations</span></div>
      </div>
      <nav>{navItems.map(([page, icon, label]) => <button key={page} className={active === page ? 'active' : ''} onClick={() => go(page)}><Icon name={icon}/><span>{label}</span></button>)}</nav>
      <div className="sidebar-footer"><strong>Safe trains</strong><span>Reliable journeys</span></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <button className="mobile-menu" aria-label="Toggle navigation" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
        <div className="context"><span className="demo-badge">SPLRT · DEMO</span><span>{formatDate(new Date(), { year: true })}</span>{updatedAt && <small>Live · updated {updatedAt.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' })}</small>}</div>
        <div className="admin-wrap"><span className="live-dot"/>Operations View<button className="admin-button" onClick={() => setMenuOpen(!menuOpen)}><b>AD</b> Admin ▾</button>
          {menuOpen && <div className="admin-menu"><button onClick={() => { go('settings'); setMenuOpen(false) }}><Icon name="settings"/>Planning settings</button><button onClick={resetDemo} disabled={resetting}><Icon name="refresh"/>{resetting ? 'Resetting demo…' : 'Reset demo data'}</button><button onClick={() => { go('technician'); setMenuOpen(false) }}><Icon name="train"/>Technician app</button></div>}
        </div>
      </header>
      <main>{children}</main>
      <Toast message={resetError} tone="danger" onClose={() => setResetError(null)}/>
    </div>
  </div>
}
