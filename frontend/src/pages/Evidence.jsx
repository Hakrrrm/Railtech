import { useEffect, useMemo, useState } from 'react'
import { loadEvidence } from '../lib/api'
import { cycleLabel, formatDate, formatKm, vehicleLabel } from '../lib/format'
import { useSupabaseData } from '../hooks/useSupabaseData'
import { Badge, Card, DataBoundary, PageHeader } from '../components/UI'
import { Icon } from '../components/Icons'

const subscriptions = [
  { table: 'vehicles' },
  { table: 'segment_traversals', event: 'INSERT' },
  { table: 'mileage_anchors', event: 'INSERT' },
  { table: 'maintenance_events', event: 'INSERT' },
]

export function Evidence({ navigate, reportUpdatedAt }) {
  const state = useSupabaseData(loadEvidence, [], subscriptions)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const rows = useMemo(() => buildRows(state.data, search, status), [state.data, search, status])

  useEffect(() => {
    if (state.updatedAt) reportUpdatedAt(state.updatedAt)
  }, [state.updatedAt, reportUpdatedAt])

  return <>
    <PageHeader title="LRV Database" actions={<button className="button button-secondary" onClick={() => state.refresh()}><Icon name="refresh"/>Refresh</button>}/>
    <DataBoundary loading={state.loading} error={state.error} empty={!state.data?.vehicles?.length} onRetry={state.refresh}>
      <Card title={`LRV records (${rows.length})`} className="fleet-database-card" action={<div className="filter-bar">
        <input aria-label="Search vehicle" placeholder="Search vehicle…" value={search} onChange={(event) => setSearch(event.target.value)}/>
        <select aria-label="Filter operational status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">All statuses</option>
          <option value="faulty">Faulty</option>
          <option value="idle">Idle</option>
          <option value="in_service">In service</option>
          <option value="maintenance">Under maintenance</option>
        </select>
      </div>}>
        <div className="table-wrap fleet-database-table">
          <table>
            <thead><tr>
              <th>Vehicle number</th>
              <th>Fleet</th>
              <th>Operational status</th>
              <th>Lifetime mileage</th>
              <th>Mileage today</th>
              <th>Last check date</th>
              <th>Cycle completed</th>
              <th aria-label="Open vehicle"/>
            </tr></thead>
            <tbody>
              {rows.map((row) => <tr key={row.lrv_id}>
                <td><strong>{vehicleLabel(row.lrv_id)}</strong></td>
                <td>{String(row.fleet || '—').toUpperCase()}</td>
                <td><Badge value={row.status}/></td>
                <td><strong>{formatKm(row.lifetimeMileage, 1)}</strong><small>{row.mileageSource}</small></td>
                <td><strong>{formatKm(row.mileage_today_km, 1)}</strong></td>
                <td>{formatDate(row.lastCheck?.completed_at, { year: true })}</td>
                <td><strong>{completedCycle(row.lastCheck)}</strong></td>
                <td><button className="icon-button" aria-label={`Open ${vehicleLabel(row.lrv_id)}`} onClick={() => navigate(`vehicle/${row.lrv_id}`)}><Icon name="chevron"/></button></td>
              </tr>)}
              {rows.length === 0 && <tr><td colSpan="8" className="empty-copy">No LRVs match the current filters.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </DataBoundary>
  </>
}

function buildRows(data, search, status) {
  if (!data) return []
  const latestChecks = new Map()
  data.events.forEach((event) => {
    if (!latestChecks.has(event.lrv_id)) latestChecks.set(event.lrv_id, event)
  })
  const query = search.trim().toUpperCase()
  return data.vehicles
    .map((vehicle) => {
      const verified = vehicle.last_physical_check_km !== null && vehicle.last_physical_check_km !== undefined
      return {
        ...vehicle,
        lifetimeMileage: verified ? vehicle.last_physical_check_km : vehicle.device_odo_km,
        mileageSource: verified
          ? `Verified ${formatDate(vehicle.last_physical_check_at, { year: true })}`
          : vehicle.device_odo_km !== null && vehicle.device_odo_km !== undefined ? 'Estimated device odometer' : 'No mileage available',
        lastCheck: latestChecks.get(vehicle.lrv_id),
      }
    })
    .filter((vehicle) => status === 'all' || vehicle.status === status)
    .filter((vehicle) => !query || vehicle.lrv_id.includes(query) || vehicleLabel(vehicle.lrv_id).includes(query) || String(vehicle.fleet || '').toUpperCase().includes(query))
}

function completedCycle(event) {
  if (!event) return '—'
  if (event.work_type === 'corrective') return 'Fault repair'
  return event.primary_cycle ? cycleLabel(event.primary_cycle) : '—'
}
