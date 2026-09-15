import { useState } from 'react'
import { Icon } from './Icons'
import { formatDate } from '../lib/format'

const navItems = [
  ['fleet', 'grid', 'Fleet Overview'], ['maintenance', 'wrench', 'Maintenance Planning'],
  ['deployment', 'pin', 'Fleet Deployment'], ['evidence', 'evidence', 'Evidence'],
]

export function Layout({ route, navigate, children, updatedAt }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const active = route.page === 'vehicle' ? 'fleet' : route.page
  const go = (page) => { navigate(page); setSidebarOpen(false) }
  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark">LTA</div><div><strong>LRV Maintenance</strong><span>SPLRT Operations</span></div></div>
      <nav>{navItems.map(([page, icon, label]) => <button key={page} className={active === page ? 'active' : ''} onClick={() => go(page)}><Icon name={icon}/><span>{label}</span></button>)}</nav>
      <div className="sidebar-footer"><strong>Safe trains</strong><span>Reliable journeys</span></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <button className="mobile-menu" aria-label="Toggle navigation" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
        <div className="context"><span className="demo-badge">SPLRT · DEMO</span><span>{formatDate(new Date(), { year: true })}</span>{updatedAt && <small>Live · updated {updatedAt.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' })}</small>}</div>
        <div className="admin-wrap"><span className="live-dot"/>Operations View<button className="admin-button" onClick={() => setMenuOpen(!menuOpen)}><b>AD</b> Admin ▾</button>
          {menuOpen && <div className="admin-menu"><button onClick={() => { go('settings'); setMenuOpen(false) }}><Icon name="settings"/>Planning settings</button><button disabled><Icon name="train"/>Technician capture <span>Later</span></button></div>}
        </div>
      </header>
      <main>{children}</main>
    </div>
  </div>
}
