import { useCallback, useEffect, useState } from 'react'
import './App.css'
import { Layout } from './components/Layout'
import { FleetOverview } from './pages/FleetOverview'
import { VehicleDetail } from './pages/VehicleDetail'
import { MaintenancePlanning } from './pages/MaintenancePlanning'
import { DeploymentPlanning } from './pages/DeploymentPlanning'
import { Evidence } from './pages/Evidence'
import { Settings } from './pages/Settings'
import { TechnicianApp } from './pages/TechnicianApp'

function readRoute() {
  const path = globalThis.location.hash.replace(/^#\/?/, '') || 'fleet'
  const [page, id] = path.split('/')
  return { page: ['fleet', 'vehicle', 'maintenance', 'deployment', 'evidence', 'settings', 'technician'].includes(page) ? page : 'fleet', id }
}

function App() {
  const [route, setRoute] = useState(readRoute)
  const [updatedAt, setUpdatedAt] = useState(null)
  useEffect(() => {
    const update = () => setRoute(readRoute())
    globalThis.addEventListener('hashchange', update)
    return () => globalThis.removeEventListener('hashchange', update)
  }, [])
  const navigate = useCallback((path) => { globalThis.location.hash = `#/${path}` }, [])
  const reportUpdatedAt = useCallback((value) => {
    setUpdatedAt((current) => !current || value > current ? value : current)
  }, [])

  if (route.page === 'technician') return <TechnicianApp navigate={navigate}/>

  let page
  if (route.page === 'vehicle') page = <VehicleDetail lrvId={route.id || 'D07'} navigate={navigate} reportUpdatedAt={reportUpdatedAt}/>
  else if (route.page === 'maintenance') page = <MaintenancePlanning navigate={navigate} reportUpdatedAt={reportUpdatedAt}/>
  else if (route.page === 'deployment') page = <DeploymentPlanning navigate={navigate} reportUpdatedAt={reportUpdatedAt}/>
  else if (route.page === 'evidence') page = <Evidence navigate={navigate} reportUpdatedAt={reportUpdatedAt}/>
  else if (route.page === 'settings') page = <Settings navigate={navigate} reportUpdatedAt={reportUpdatedAt}/>
  else page = <FleetOverview navigate={navigate} reportUpdatedAt={reportUpdatedAt}/>

  return <Layout route={route} navigate={navigate} updatedAt={updatedAt}>{page}</Layout>
}

export default App
