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
  const [sort, setSort] = useState({ key: 'vehicle', direction: 'asc' })
  const rows = useMemo(() => buildRows(state.data, search, status, sort), [state.data, search, status, sort])
  const changeSort = (key) => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
  }))

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
              <SortHeader label="Vehicle number" sortKey="vehicle" sort={sort} onSort={changeSort}/>
              <SortHeader label="Fleet" sortKey="fleet" sort={sort} onSort={changeSort}/>
              <SortHeader label="Operational status" sortKey="status" sort={sort} onSort={changeSort}/>
              <SortHeader label="Lifetime mileage" sortKey="lifetime" sort={sort} onSort={changeSort}/>
              <SortHeader label="Mileage today" sortKey="today" sort={sort} onSort={changeSort}/>
              <SortHeader label="Last check date" sortKey="lastCheck" sort={sort} onSort={changeSort}/>
              <SortHeader label="Cycle completed" sortKey="cycle" sort={sort} onSort={changeSort}/>
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

function SortHeader({ label, sortKey, sort, onSort }) {
  const active = sort.key === sortKey
  const direction = active ? sort.direction : 'none'
  return <th aria-sort={active ? `${sort.direction}ending` : 'none'}>
    <button className={`table-sort ${active ? 'active' : ''}`} onClick={() => onSort(sortKey)}>
      <span>{label}</span><span className="table-sort-arrow" aria-hidden="true">{direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : '↕'}</span>
    </button>
  </th>
}

function buildRows(data, search, status, sort) {
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
    .sort((left, right) => compareRows(left, right, sort))
}

const sortValues = {
  vehicle: (row) => Number(String(row.lrv_id).replace(/\D/g, '')),
  fleet: (row) => row.fleet,
  status: (row) => row.status,
  lifetime: (row) => row.lifetimeMileage,
  today: (row) => row.mileage_today_km,
  lastCheck: (row) => row.lastCheck?.completed_at ? new Date(row.lastCheck.completed_at).getTime() : null,
  cycle: (row) => row.lastCheck?.work_type === 'corrective' ? Number.MAX_SAFE_INTEGER : row.lastCheck?.primary_cycle,
}

function compareRows(left, right, sort) {
  const leftValue = sortValues[sort.key](left)
  const rightValue = sortValues[sort.key](right)
  const leftMissing = leftValue === null || leftValue === undefined || Number.isNaN(leftValue)
  const rightMissing = rightValue === null || rightValue === undefined || Number.isNaN(rightValue)
  if (leftMissing !== rightMissing) return leftMissing ? 1 : -1
  if (leftMissing) return vehicleNumber(left) - vehicleNumber(right)
  const comparison = typeof leftValue === 'string'
    ? leftValue.localeCompare(String(rightValue), 'en-SG', { numeric: true })
    : Number(leftValue) - Number(rightValue)
  return comparison === 0
    ? vehicleNumber(left) - vehicleNumber(right)
    : comparison * (sort.direction === 'asc' ? 1 : -1)
}

function vehicleNumber(row) {
  return Number(String(row.lrv_id).replace(/\D/g, ''))
}

function completedCycle(event) {
  if (!event) return '—'
  if (event.work_type === 'corrective') return 'Fault repair'
  return event.primary_cycle ? cycleLabel(event.primary_cycle) : '—'
}
