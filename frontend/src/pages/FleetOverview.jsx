import { useEffect, useMemo, useState } from 'react'
import { loadFleetOverview } from '../lib/api'
import { cycleLabel, vehicleLabel } from '../lib/format'
import { useSupabaseData } from '../hooks/useSupabaseData'
import { Badge, Card, DataBoundary, MetricCard, PageHeader } from '../components/UI'
import { MaintenanceOutlook } from '../components/MaintenanceOutlook'
import { Icon } from '../components/Icons'
import { compareMaintenancePriority, maintenancePriorityCategory, matchesMaintenancePriorityFilter } from '../lib/maintenancePriority'

const subscriptions = [
  { table: 'vehicles' }, { table: 'segment_traversals', event: 'INSERT' },
  { table: 'mileage_anchors', event: 'INSERT' }, { table: 'cycle_state' },
  { table: 'maintenance_bookings' }, { table: 'maintenance_faults' }, { table: 'planning_settings' },
]

export function FleetOverview({ navigate, reportUpdatedAt }) {
  const state = useSupabaseData(loadFleetOverview, [], subscriptions)
  const [priorityFilter, setPriorityFilter] = useState('all')
  const model = useMemo(() => buildModel(state.data), [state.data])
  const visiblePriority = useMemo(() => model?.priority.filter((item) => matchesPriorityFilter(item, priorityFilter)) || [], [model, priorityFilter])
  useEffect(() => { if (state.updatedAt) reportUpdatedAt(state.updatedAt) }, [state.updatedAt, reportUpdatedAt])

  return <div className="fleet-page">
    <PageHeader eyebrow="Operations control centre" title="Fleet Overview" actions={<button className="button button-secondary" onClick={() => state.refresh()}><Icon name="refresh"/>Refresh</button>}/>
    <DataBoundary loading={state.loading} error={state.error} empty={!state.data?.vehicles?.length} onRetry={state.refresh}>
      {model && <>
        <div className="metric-grid metric-grid-three">
          <MetricCard label="Maintenance attention" value={model.attention.length} detail="Due now, due soon or fault repair" tone="danger" icon="alert"/>
          <MetricCard label="Due within 7 days" value={model.dueSoon.length} detail="Includes vehicles due today" tone="warning" icon="clock"/>
          <MetricCard label="Spares on reserve" value={model.spares} detail="Idle, serviceable and unbooked" tone="info" icon="train"/>
        </div>

        <Card title="14-day maintenance outlook">
          <MaintenanceOutlook bookings={state.data.bookings}/>
        </Card>

        <div className="overview-grid">
          <Card title="Priority vehicles" className="priority-card" action={<select className="priority-filter" aria-label="Filter priority vehicles" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
            <option value="all">All priorities ({model.priority.length})</option>
            <option value="today">Due today ({model.priorityCounts.today})</option>
            <option value="week">Due within 7 days ({model.priorityCounts.week})</option>
            <option value="fault">Fault repair ({model.priorityCounts.fault})</option>
          </select>}>
            <div className="table-wrap priority-table-scroll"><table><thead><tr><th>Vehicle</th><th>Status</th><th>Next maintenance cycle</th><th>Km to maintenance</th><th>Priority</th><th aria-label="Open"/></tr></thead>
              <tbody>{visiblePriority.map((item) => <tr key={item.lrv_id}>
                <td><strong>{vehicleLabel(item.lrv_id)}</strong></td><td><Badge value={item.displayStatus}/></td>
                <td><strong>{item.status === 'faulty' ? 'Corrective repair' : cycleLabel(item.cycle_type)}</strong></td>
                <td><strong className={item.status === 'faulty' || Number(item.km_to_next) <= 0 ? 'text-danger' : ''}>{item.status === 'faulty' ? 'Fault reported' : maintenanceDistance(item.km_to_next)}</strong></td>
                <td>{item.status === 'faulty' ? <span className="priority-timing priority-overdue">Fault repair</span> : <span className={`priority-timing priority-${forecastTone(item.displayForecastDays)}`}>{priorityForecastLabel(item.displayForecastDays)}</span>}</td>
                <td><button className="icon-button" aria-label={`Open ${vehicleLabel(item.lrv_id)}`} onClick={() => navigate(`vehicle/${item.lrv_id}`)}><Icon name="chevron"/></button></td>
              </tr>)}{visiblePriority.length === 0 && <tr><td colSpan="6" className="empty-copy">No vehicles match this priority filter.</td></tr>}</tbody></table></div>
          </Card>
          <Card title="Next best action" eyebrow="Decision support" className="action-card">
            <div className={`action-symbol ${model.next.status === 'faulty' ? 'danger' : ''}`}><Icon name={model.next.status === 'faulty' ? 'alert' : 'calendar'} size={25}/></div>
            <h3>{model.next.title}</h3><p>{model.next.description}</p>
            <div className="reason-box"><strong>Why this matters</strong><span>{model.next.reason}</span></div>
            <button className="button button-primary button-full" onClick={() => navigate(model.next.destination)}>{model.next.button}<Icon name="chevron"/></button>
          </Card>
        </div>
      </>}
    </DataBoundary>
  </div>
}

function buildModel(data) {
  if (!data) return null
  const forecastsByVehicle = new Map()
  data.forecasts.forEach((cycle) => {
    const current = forecastsByVehicle.get(cycle.lrv_id)
    if (!current || compareMaintenancePriority(cycle, current) < 0) forecastsByVehicle.set(cycle.lrv_id, cycle)
  })
  const summaries = new Map(data.mileage.map((row) => [row.lrv_id, row]))
  const faults = new Map((data.faults || []).map((fault) => [fault.lrv_id, fault]))
  const now = new Date()
  const activeBookings = new Map(data.bookings.filter((booking) => booking.status === 'confirmed' && new Date(booking.start_at) <= now && new Date(booking.end_at) > now).map((booking) => [booking.lrv_id, booking]))
  const openBookings = new Map(data.bookings.filter((booking) => ['proposed', 'confirmed'].includes(booking.status)).map((booking) => [booking.lrv_id, booking]))
  const combined = data.vehicles.map((vehicle) => {
    const row = { ...vehicle, ...(summaries.get(vehicle.lrv_id) || {}), ...(forecastsByVehicle.get(vehicle.lrv_id) || {}), currentBooking: activeBookings.get(vehicle.lrv_id), openBooking: openBookings.get(vehicle.lrv_id), fault: faults.get(vehicle.lrv_id) }
    return { ...row, displayForecastDays: row.forecast_days, displayStatus: row.status === 'maintenance' || row.currentBooking ? 'maintenance' : row.status }
  })
  const staleAfterHours = Number(data.settings?.stale_telemetry_hours || 12)
  const priority = combined
    .filter((row) => row.displayStatus !== 'maintenance')
    .map((row) => ({ ...row, priorityCategory: maintenancePriorityCategory(row), reason: reasonFor(row, staleAfterHours) }))
    .filter((row) => row.priorityCategory)
    .sort(compareMaintenancePriority)
  const attention = priority
  const dueSoon = priority.filter((row) => ['today', 'week'].includes(row.priorityCategory))
  const priorityCounts = {
    today: priority.filter((row) => row.priorityCategory === 'today').length,
    fault: priority.filter((row) => row.priorityCategory === 'fault').length,
    week: dueSoon.length,
  }
  const leading = priority[0] || {}
  const next = leading.status === 'faulty'
    ? { status: 'faulty', title: `Replace ${vehicleLabel(leading.lrv_id)} at the next handover`, description: leading.reason, reason: 'A controlled stock change keeps the service slot covered while the faulty LRV returns to depot.', button: 'Open deployment plan', destination: 'deployment' }
    : leading.status === 'maintenance' || leading.currentBooking
      ? { title: `Complete the maintenance record for ${leading.lrv_id ? vehicleLabel(leading.lrv_id) : 'the current visit'}`, description: `${cycleLabel(leading.cycle_type)} work is under way or awaiting technician confirmation.`, reason: 'The cycle remains overdue until the technician records what was completed and the mileage at completion.', button: 'Open maintenance plan', destination: 'maintenance' }
      : leading.openBooking
        ? { title: `Review the booked slot for ${vehicleLabel(leading.lrv_id)}`, description: leading.reason, reason: 'This vehicle already has an unresolved depot booking, so another reservation would duplicate the visit.', button: 'Open maintenance plan', destination: 'maintenance' }
    : { title: `Reserve a depot slot for ${leading.lrv_id ? vehicleLabel(leading.lrv_id) : 'the next recall'}`, description: leading.reason || 'Review the upcoming maintenance forecast.', reason: 'Booking against forecast days gives planners time to bundle work and protect fleet availability.', button: 'Open maintenance plan', destination: 'maintenance' }
  return { attention, dueSoon, priority, priorityCounts, next, spares: combined.filter((row) => row.status === 'idle' && !row.openBooking).length }
}

function matchesPriorityFilter(row, filter) {
  return matchesMaintenancePriorityFilter(row, filter)
}

function priorityForecastLabel(days) {
  if (days === null || days === undefined) return 'Awaiting telemetry'
  if (days < 0) return 'Overdue'
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${days} days`
}

function forecastTone(days) {
  if (days === null || days === undefined) return 'muted'
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  return 'upcoming'
}

function maintenanceDistance(km) {
  const value = Number(km)
  if (!Number.isFinite(value)) return 'Awaiting mileage'
  if (value < 0) return `${Math.abs(value).toLocaleString('en-SG')} km overdue`
  if (value === 0) return 'Due now'
  return `${value.toLocaleString('en-SG')} km remaining`
}

function reasonFor(row, staleAfterHours) {
  if (row.status === 'faulty') return row.lrv_id === 'D29' ? 'Brake pressure fault · withdraw from service' : 'Fault reported · telemetry also stale'
  if (row.status === 'maintenance' && row.openBooking) return `${cycleLabel(row.openBooking.primary_cycle)} booking awaiting completion record`
  if (row.currentBooking) return `${cycleLabel(row.currentBooking.primary_cycle)} package occupying ${row.currentBooking.bay_id}`
  if (row.openBooking) return `${cycleLabel(row.openBooking.primary_cycle)} depot visit already booked`
  if (Number(row.km_to_next) <= 0) return `${cycleLabel(row.cycle_type)} cycle overdue`
  if (Math.abs(Number(row.divergence_km || 0)) >= 50) return 'Physical and device mileage need review'
  if (Number(row.telemetry_age_hours) > staleAfterHours) return 'Telemetry is stale'
  if (row.forecast_days !== null && Number(row.forecast_days) <= 2) return `${cycleLabel(row.cycle_type)} maintenance approaching`
  if (row.status === 'maintenance') return 'Currently occupying a depot slot'
  return 'Healthy · monitor forecast'
}
