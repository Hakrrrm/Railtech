import { useEffect, useMemo, useState } from 'react'
import { loadVehicleDetail } from '../lib/api'
import { cycleLabel, forecastLabel, formatDateTime, formatDateTimeRange, formatDuration, formatKm, qualityLabel, statusLabel, vehicleLabel } from '../lib/format'
import { useSupabaseData } from '../hooks/useSupabaseData'
import { Badge, Card, DataBoundary, MetricCard, PageHeader, Progress } from '../components/UI'
import { MaintenancePhoto } from '../components/MaintenancePhoto'
import { Icon } from '../components/Icons'

const routeSegments = ['SIM_SK_A_B', 'SIM_SK_B_C', 'SIM_SK_C_D', 'SIM_SK_D_E', 'SIM_SK_E_F', 'SIM_SK_F_A']

export function VehicleDetail({ lrvId, navigate, reportUpdatedAt }) {
  const [tab, setTab] = useState('trend')
  const [photo, setPhoto] = useState(null)
  const subscriptions = useMemo(() => [
    { table: 'vehicles', filter: `lrv_id=eq.${lrvId}` },
    { table: 'segment_traversals', event: 'INSERT', filter: `lrv_id=eq.${lrvId}` },
    { table: 'mileage_anchors', event: 'INSERT', filter: `lrv_id=eq.${lrvId}` },
    { table: 'cycle_state', filter: `lrv_id=eq.${lrvId}` },
    { table: 'technician_observations', filter: `lrv_id=eq.${lrvId}` },
    { table: 'maintenance_events', filter: `lrv_id=eq.${lrvId}` },
    { table: 'maintenance_bookings', filter: `lrv_id=eq.${lrvId}` },
    { table: 'maintenance_cycle_rules' },
  ], [lrvId])
  const state = useSupabaseData(() => loadVehicleDetail(lrvId), [lrvId], subscriptions)
  const trend = useMemo(() => dailyTrend(state.data?.traversals || []), [state.data?.traversals])
  useEffect(() => { if (state.updatedAt) reportUpdatedAt(state.updatedAt) }, [state.updatedAt, reportUpdatedAt])
  const data = state.data

  return <>
    <button className="back-link" onClick={() => navigate('fleet')}><Icon name="arrow"/>Back to fleet overview</button>
    <PageHeader eyebrow="Vehicle record" title={vehicleLabel(lrvId)} description="Reconciled mileage, maintenance exposure and completed segment evidence." actions={data?.summary && <Badge value={data.summary.status}/>}/>
    <DataBoundary loading={state.loading} error={state.error} empty={!data?.summary} onRetry={state.refresh}>
      {data?.summary && <>
        <div className="metric-grid metric-grid-three">
          <MetricCard label="Lifetime planning mileage" value={formatKm(data.summary.lifetime_planning_mileage_km, 1)} detail="Physical anchor + validated segments" tone="info" icon="train"/>
          <MetricCard label="Mileage today" value={formatKm(data.summary.mileage_today_km, 1)} detail={`${formatKm(data.summary.rolling_daily_rate_km, 1)} vehicle 7-day history`} tone="success" icon="clock"/>
          <MetricCard label="Last physical check" value={formatKm(data.summary.last_physical_check_km, 1)} detail={formatDateTime(data.summary.last_physical_check_at)} tone="neutral" icon="evidence"/>
        </div>

        <Card title="Maintenance cycles" eyebrow="Nested preventive-maintenance exposure">
          <div className="cycle-grid">{data.forecasts.map((cycle) => {
            const progress = Number(cycle.km_since) / Number(cycle.cycle_type) * 100
            const hasForecast = cycle.forecast_days !== null && cycle.forecast_days !== undefined
            const overdue = cycle.km_to_next !== null && Number(cycle.km_to_next) <= 0
            const danger = overdue || (hasForecast && Number(cycle.forecast_days) <= 2)
            return <div className={`cycle-card ${danger ? 'cycle-danger' : ''}`} key={cycle.cycle_type}>
              <div><strong>{cycleLabel(cycle.cycle_type)}</strong>{(overdue || hasForecast) && <Badge value={overdue ? 'Overdue' : forecastLabel(cycle.forecast_days)} tone={danger ? 'danger' : 'info'}/>}</div>
              <Progress value={progress} tone={danger ? 'red' : 'teal'}/>
              <p><b>{formatKm(cycle.km_to_next)}</b> remaining</p>{hasForecast && <small>{forecastLabel(cycle.forecast_days)} at fleet average {formatKm(cycle.rolling_daily_rate_km, 0)}/day</small>}
            </div>
          })}</div>
        </Card>

        {data.bookings.filter((booking) => ['proposed', 'confirmed'].includes(booking.status)).map((booking) => <Card key={booking.id} title="Planned depot stay">
          <div className="planned-stay"><div><span>Work</span><strong>{booking.work_type === 'corrective' ? 'Corrective repair' : cycleLabel(booking.primary_cycle)}</strong><small>{booking.work_type === 'corrective' ? booking.notes || 'Fault repair' : `Includes ${booking.bundled_cycles.map(cycleLabel).join(' + ')}`}</small></div><div><span>Occupancy</span><strong>{formatDuration((new Date(booking.end_at) - new Date(booking.start_at)) / 60000)}</strong><small>{formatDateTimeRange(booking.start_at, booking.end_at)}</small></div><Badge value={booking.status}/></div>
        </Card>)}

        <div className="detail-grid">
          <Card title="Movement context" action={<div className="tabs"><button className={tab === 'trend' ? 'active' : ''} onClick={() => setTab('trend')}>Mileage trend</button><button className={tab === 'route' ? 'active' : ''} onClick={() => setTab('route')}>Route position</button></div>}>
            {tab === 'trend' ? <TrendChart trend={trend}/> : <RoutePosition current={data.summary.seg_id} direction={data.traversals[0]?.dir}/>}
          </Card>
          <Card title="Evidence summary" eyebrow="Latest accepted physical record" action={<button className="text-button" onClick={() => navigate('evidence')}>Open audit view <Icon name="chevron"/></button>}>
            <div className="evidence-summary"><div><span>Accepted reading</span><strong>{formatKm(data.summary.last_physical_check_km, 1)}</strong></div><div><span>Device comparison</span><strong>{formatKm(data.summary.device_odo_km, 1)}</strong></div><div><span>Divergence</span><strong className={Math.abs(Number(data.summary.divergence_km)) >= 50 ? 'text-danger' : ''}>{formatKm(data.summary.divergence_km, 1)}</strong></div></div>
            <div className="evidence-note"><Icon name="shield"/><span>{data.anchors.some((row) => row.superseded_by) ? 'Audit history contains a superseded reading; the correction remains traceable.' : 'The latest physical check is accepted and the history is append-only.'}</span></div>
          </Card>
        </div>

        <Card title="Recent activity" eyebrow="Completed segment traversals" className="activity-card">
          {data.traversals.length ? <div className="table-wrap"><table><thead><tr><th>Completed</th><th>Segment</th><th>Direction</th><th>Distance</th><th>Device mileage</th><th>GNSS quality</th></tr></thead><tbody>
            {data.traversals.slice(0, 12).map((event) => { const quality = qualityLabel(event.hdop); return <tr key={event.id}><td>{formatDateTime(event.ts)}</td><td><strong>{event.seg_id}</strong></td><td>{event.dir || '—'}</td><td>{formatKm(Number(event.length_m) / 1000, 2)}</td><td>{formatKm(event.odo_km, 1)}</td><td><Badge value={`${quality.label}${event.hdop ? ` · ${Number(event.hdop).toFixed(1)}` : ''}`} tone={quality.tone}/></td></tr> })}
          </tbody></table></div> : <p className="empty-copy">No completed segments have been received for this vehicle.</p>}
        </Card>

        <Card title="Maintenance log" eyebrow="Technician-confirmed work and definite completion mileage">
          {data.events.length ? <div className="table-wrap"><table><thead><tr><th>Completed</th><th>Planned package</th><th>Physical reading</th><th>Actually completed</th><th>Result</th><th>Technician</th><th>Notes</th><th>Photo</th></tr></thead><tbody>
            {data.events.map((event) => { const corrective = event.work_type === 'corrective'; const planned = corrective ? [] : data.rules.find((rule) => Number(rule.cycle_type) === Number(event.primary_cycle))?.included_cycles || [event.primary_cycle]; const completed = event.reset_cycles || []; const partial = !corrective && planned.some((cycle) => !completed.map(Number).includes(Number(cycle))); return <tr key={event.id}><td>{formatDateTime(event.completed_at)}</td><td><strong>{corrective ? 'Corrective repair' : cycleLabel(event.primary_cycle)}</strong></td><td>{formatKm(event.completion_mileage_km, 1)}</td><td>{corrective ? 'No mileage reset' : completed.map(cycleLabel).join(' Â· ')}</td><td><Badge value={partial ? 'Partial scope' : 'Completed'} tone={partial ? 'warning' : 'success'}/></td><td>{event.technician_id}</td><td>{event.notes || statusLabel(event.source)}</td><td>{event.imageUri ? <button className="button button-secondary button-compact" onClick={() => setPhoto(event)}><Icon name="camera"/>View image</button> : '—'}</td></tr> })}
          </tbody></table></div> : <p className="empty-copy">No completed maintenance has been recorded.</p>}
        </Card>
      </>}
    </DataBoundary>
    {photo && <MaintenancePhoto key={photo.id} record={photo} onClose={() => setPhoto(null)}/>}
  </>
}

function dailyTrend(traversals) {
  const values = new Map()
  traversals.forEach((row) => {
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(row.ts))
    values.set(key, (values.get(key) || 0) + Number(row.length_m) / 1000)
  })
  return [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-7).map(([date, km]) => ({ date, km }))
}

function TrendChart({ trend }) {
  const maximum = Math.max(...trend.map((day) => day.km), 1)
  if (!trend.length) return <p className="empty-copy">No mileage trend is available yet.</p>
  return <div className="trend-chart">{trend.map((day) => <div key={day.date}><span className="trend-value">{Math.round(day.km)} km</span><div className="trend-bar"><i style={{ height: `${Math.max(5, day.km / maximum * 100)}%` }}/></div><small>{new Date(`${day.date}T00:00:00+08:00`).toLocaleDateString('en-SG', { weekday: 'short', timeZone: 'Asia/Singapore' })}</small></div>)}</div>
}

function RoutePosition({ current, direction }) {
  const activeIndex = routeSegments.indexOf(current)
  if (current && activeIndex < 0) {
    return <div className="route-map"><p className="empty-copy">The latest segment is <strong>{current}</strong>. Route geometry has not been loaded for this track dataset, so the dashboard will not guess a position.</p></div>
  }
  const directionLabel = { E: 'Eastbound', W: 'Westbound', N: 'Northbound', S: 'Southbound' }[direction] || 'Direction unavailable'
  return <div className="route-map"><div className="loop-line">{routeSegments.map((segment, index) => <div className={`route-stop ${index === activeIndex ? 'active' : ''}`} key={segment}><span>{index === activeIndex ? <Icon name="train" size={16}/> : index + 1}</span><small>{segment.replace('SIM_SK_', '').replaceAll('_', ' → ')}</small></div>)}</div><p><Badge value={directionLabel} tone="info"/> Last completed segment: <strong>{current || 'No position'}</strong></p></div>
}
