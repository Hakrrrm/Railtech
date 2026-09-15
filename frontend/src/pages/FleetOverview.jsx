import { useEffect, useMemo } from 'react'
import { loadFleetOverview } from '../lib/api'
import { daysFromToday, forecastLabel, formatDate, formatKm } from '../lib/format'
import { useSupabaseData } from '../hooks/useSupabaseData'
import { Badge, Card, DataBoundary, MetricCard, PageHeader } from '../components/UI'
import { Icon } from '../components/Icons'

const subscriptions = [
  { table: 'vehicles' }, { table: 'segment_traversals', event: 'INSERT' },
  { table: 'mileage_anchors', event: 'INSERT' }, { table: 'cycle_state' },
  { table: 'maintenance_bookings' },
]

export function FleetOverview({ navigate, reportUpdatedAt }) {
  const state = useSupabaseData(loadFleetOverview, [], subscriptions)
  const model = useMemo(() => buildModel(state.data), [state.data])
  useEffect(() => { if (state.updatedAt) reportUpdatedAt(state.updatedAt) }, [state.updatedAt, reportUpdatedAt])

  return <>
    <PageHeader eyebrow="Operations control centre" title="Fleet Overview" description="Live fleet condition, mileage confidence and the next decisions that protect service." actions={<button className="button button-secondary" onClick={() => state.refresh()}><Icon name="refresh"/>Refresh</button>}/>
    <DataBoundary loading={state.loading} error={state.error} empty={!state.data?.vehicles?.length} onRetry={state.refresh}>
      {model && <>
        <div className="metric-grid">
          <MetricCard label="Maintenance attention" value={model.attention.length} detail="Faults, overdue or stale" tone="danger" icon="alert"/>
          <MetricCard label="Due within 7 days" value={model.dueSoon.length} detail="Vehicles, grouped by recall" tone="warning" icon="clock"/>
          <MetricCard label="Spares on reserve" value={model.spares} detail="Serviceable idle LRVs" tone="info" icon="train"/>
          <MetricCard label="Mileage checks" value={model.checks} detail="Stale or high divergence" tone="neutral" icon="evidence"/>
        </div>

        <div className="overview-grid">
          <Card title="Priority vehicles" eyebrow="Live feed" className="priority-card">
            <div className="table-wrap"><table><thead><tr><th>Vehicle</th><th>Status</th><th>Planning mileage</th><th>Location</th><th>Priority</th><th aria-label="Open"/></tr></thead>
              <tbody>{model.priority.map((item) => <tr key={item.lrv_id}>
                <td><strong>{item.lrv_id}</strong><small>{item.reason}</small></td><td><Badge value={item.status}/></td>
                <td>{formatKm(item.lifetime_planning_mileage_km, 1)}<small>{formatKm(item.mileage_today_km, 1)} today</small></td>
                <td>{item.seg_id || 'Depot'}<small>{item.latest_telemetry_at ? `Seen ${formatDate(item.latest_telemetry_at)}` : 'No telemetry'}</small></td>
                <td><strong className={item.forecast_days !== null && item.forecast_days <= 2 ? 'text-danger' : ''}>{forecastLabel(item.forecast_days)}</strong><small>{formatKm(item.km_to_next)} to {item.cycle_type / 1000}K</small></td>
                <td><button className="icon-button" aria-label={`Open ${item.lrv_id}`} onClick={() => navigate(`vehicle/${item.lrv_id}`)}><Icon name="chevron"/></button></td>
              </tr>)}</tbody></table></div>
          </Card>
          <Card title="Next best action" eyebrow="Decision support" className="action-card">
            <div className={`action-symbol ${model.next.status === 'faulty' ? 'danger' : ''}`}><Icon name={model.next.status === 'faulty' ? 'alert' : 'calendar'} size={25}/></div>
            <h3>{model.next.title}</h3><p>{model.next.description}</p>
            <div className="reason-box"><strong>Why this matters</strong><span>{model.next.reason}</span></div>
            <button className="button button-primary button-full" onClick={() => navigate(model.next.destination)}>{model.next.button}<Icon name="chevron"/></button>
          </Card>
        </div>

        <Card title="14-day maintenance outlook" eyebrow="Forecast dates · days are primary, kilometres are supporting detail">
          <div className="outlook">{model.outlook.map((day) => <div className="outlook-day" key={day.date} title={`${day.count} maintenance cycle${day.count === 1 ? '' : 's'}`}>
            <div className="bar-area"><span style={{ height: `${Math.max(4, day.count * 20)}%` }} className={day.count ? 'bar-active' : ''}/></div><b>{day.count || '·'}</b><small>{formatDate(day.date)}</small>
          </div>)}</div>
        </Card>
      </>}
    </DataBoundary>
  </>
}

function buildModel(data) {
  if (!data) return null
  const forecastsByVehicle = new Map()
  data.forecasts.forEach((cycle) => {
    const current = forecastsByVehicle.get(cycle.lrv_id)
    if (!current || Number(cycle.priority_score) > Number(current.priority_score)) forecastsByVehicle.set(cycle.lrv_id, cycle)
  })
  const summaries = new Map(data.mileage.map((row) => [row.lrv_id, row]))
  const combined = data.vehicles.map((vehicle) => ({ ...vehicle, ...(summaries.get(vehicle.lrv_id) || {}), ...(forecastsByVehicle.get(vehicle.lrv_id) || {}) }))
  const attention = combined.filter((row) => row.status === 'faulty' || row.status === 'maintenance' || Number(row.km_to_next) <= 0 || Number(row.telemetry_age_hours) > 12)
  const dueSoon = combined.filter((row) => row.forecast_days !== null && Number(row.forecast_days) >= 0 && Number(row.forecast_days) <= 7)
  const checks = combined.filter((row) => Number(row.telemetry_age_hours) > 12 || Math.abs(Number(row.divergence_km || 0)) >= 50).length
  const priority = combined.map((row) => ({ ...row, reason: reasonFor(row) })).sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0)).slice(0, 8)
  const leading = priority[0] || {}
  const next = leading.status === 'faulty'
    ? { status: 'faulty', title: `Replace ${leading.lrv_id} at the next handover`, description: leading.reason, reason: 'A controlled stock change keeps the service slot covered while the faulty LRV returns to depot.', button: 'Open deployment plan', destination: 'deployment' }
    : { title: `Reserve a depot slot for ${leading.lrv_id || 'the next recall'}`, description: leading.reason || 'Review the upcoming maintenance forecast.', reason: 'Booking against forecast days gives planners time to bundle work and protect fleet availability.', button: 'Open maintenance plan', destination: 'maintenance' }
  const outlook = Array.from({ length: 14 }, (_, offset) => {
    const date = new Date(); date.setDate(date.getDate() + offset)
    const iso = date.toISOString().slice(0, 10)
    return { date: iso, count: data.forecasts.filter((cycle) => cycle.forecast_date && daysFromToday(cycle.forecast_date) === offset).length }
  })
  return { attention, dueSoon, checks, priority, next, outlook, spares: combined.filter((row) => row.status === 'idle').length }
}

function reasonFor(row) {
  if (row.status === 'faulty') return row.lrv_id === 'D29' ? 'Brake pressure fault · withdraw from service' : 'Fault reported · telemetry also stale'
  if (Number(row.km_to_next) <= 0) return `${row.cycle_type / 1000}K cycle overdue`
  if (Math.abs(Number(row.divergence_km || 0)) >= 50) return 'Physical and device mileage need review'
  if (Number(row.telemetry_age_hours) > 12) return 'Telemetry is stale'
  if (row.forecast_days !== null && Number(row.forecast_days) <= 2) return `${row.cycle_type / 1000}K maintenance approaching`
  if (row.status === 'maintenance') return 'Currently occupying a depot slot'
  return 'Healthy · monitor forecast'
}
