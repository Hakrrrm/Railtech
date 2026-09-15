import { useEffect, useMemo, useState } from 'react'
import { completeMaintenance, loadMaintenancePlanning, scheduleMaintenance } from '../lib/api'
import { cycleLabel, forecastLabel, formatDate, formatKm, formatTime, singaporeDate } from '../lib/format'
import { useSupabaseData } from '../hooks/useSupabaseData'
import { Badge, Card, DataBoundary, MetricCard, PageHeader, Toast } from '../components/UI'
import { Icon } from '../components/Icons'

const subscriptions = [
  { table: 'maintenance_bookings' }, { table: 'maintenance_events', event: 'INSERT' },
  { table: 'cycle_state' }, { table: 'vehicles' }, { table: 'segment_traversals', event: 'INSERT' },
]

const emptyForm = { lrvId: '', primaryCycle: 2000, bundledCycles: [2000], bayId: '', date: singaporeDate(1), time: '09:00', status: 'proposed', notes: '' }

export function MaintenancePlanning({ reportUpdatedAt }) {
  const state = useSupabaseData(loadMaintenancePlanning, [], subscriptions)
  const [form, setForm] = useState(emptyForm)
  const [editing, setEditing] = useState(false)
  const [toast, setToast] = useState(null)
  const [saving, setSaving] = useState(false)
  const model = useMemo(() => buildMaintenanceModel(state.data), [state.data])
  useEffect(() => { if (state.updatedAt) reportUpdatedAt(state.updatedAt) }, [state.updatedAt, reportUpdatedAt])

  const suggest = (item) => {
    const cycles = state.data.forecasts.filter((cycle) => cycle.lrv_id === item.lrv_id && cycle.forecast_days !== null && Number(cycle.forecast_days) <= Number(item.forecast_days) + 2).map((cycle) => Number(cycle.cycle_type))
    const rule = state.data.rules.find((candidate) => Number(candidate.cycle_type) === Number(item.cycle_type))
    const bay = state.data.bays.find((candidate) => candidate.active && (candidate.bay_type === rule?.compatible_bay_type || candidate.bay_type === 'universal')) || state.data.bays.find((candidate) => candidate.active)
    setForm({ ...emptyForm, lrvId: item.lrv_id, primaryCycle: item.cycle_type, bundledCycles: cycles.length ? cycles : [Number(item.cycle_type)], bayId: bay?.bay_id || '', date: singaporeDate(Math.max(1, Math.min(6, Number(item.forecast_days || 1)))), notes: cycles.length > 1 ? `Bundle ${cycles.map(cycleLabel).join(' + ')} in one depot visit` : `${cycleLabel(item.cycle_type)} forecast-based recall` })
    setEditing(true)
  }

  const editBooking = (booking) => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(booking.start_at))
    setForm({ lrvId: booking.lrv_id, primaryCycle: booking.primary_cycle, bundledCycles: booking.bundled_cycles, bayId: booking.bay_id, date, time: formatTime(booking.start_at), status: booking.status, notes: booking.notes || '', bookingId: booking.id })
    setEditing(true)
  }

  const submit = async (event) => {
    event.preventDefault(); setSaving(true)
    try {
      const rule = state.data.rules.find((candidate) => Number(candidate.cycle_type) === Number(form.primaryCycle))
      const start = new Date(`${form.date}T${form.time}:00+08:00`)
      const end = new Date(start.getTime() + Number(rule?.duration_minutes || 90) * 60000)
      await scheduleMaintenance({ ...form, startAt: start.toISOString(), endAt: end.toISOString() })
      setToast({ message: `${form.lrvId} booking ${form.bookingId ? 'updated' : 'created'}.`, tone: 'success' }); setEditing(false); setForm(emptyForm); state.refresh(true)
    } catch (error) { setToast({ message: error.message, tone: 'danger' }) } finally { setSaving(false) }
  }

  const complete = async (booking) => {
    const fallback = state.data.vehicles.find((row) => row.lrv_id === booking.lrv_id)
    const entered = globalThis.prompt(`Enter the definite hubometer reading for ${booking.lrv_id}:`, fallback?.odo_km || '')
    if (!entered) return
    setSaving(true)
    try {
      await completeMaintenance({ lrvId: booking.lrv_id, primaryCycle: booking.primary_cycle, mileageKm: entered, technicianId: 'TECH_DEMO', bookingId: booking.id, notes: booking.notes })
      setToast({ message: `${cycleLabel(booking.primary_cycle)} completed. Nested cycles were reset atomically.`, tone: 'success' }); state.refresh(true)
    } catch (error) { setToast({ message: error.message, tone: 'danger' }) } finally { setSaving(false) }
  }

  return <>
    <PageHeader eyebrow="Depot control" title="Maintenance Planning" description="Turn mileage forecasts into recall decisions while protecting service coverage." actions={<button className="button button-primary" onClick={() => setEditing(true)}><Icon name="calendar"/>New booking</button>}/>
    <DataBoundary loading={state.loading} error={state.error} empty={!state.data?.vehicles?.length} onRetry={state.refresh}>
      {model && <>
        <div className="metric-grid">
          <MetricCard label="Overdue recalls" value={model.overdue} detail="Requires immediate control" tone="danger" icon="alert"/>
          <MetricCard label="Due within 7 days" value={model.dueSoon} detail="Grouped by vehicle" tone="warning" icon="clock"/>
          <MetricCard label="Confirmed this week" value={model.confirmed} detail="Across two depot bays" tone="success" icon="calendar"/>
          <MetricCard label="Bundle opportunities" value={model.bundles} detail="One visit, multiple cycles" tone="info" icon="wrench"/>
        </div>

        <div className="maintenance-layout">
          <Card title="Recall queue" eyebrow="Ranked by urgency and serviceability">
            <div className="recall-list">{model.queue.map((item, index) => <button key={item.lrv_id} onClick={() => suggest(item)}>
              <span className={`queue-rank ${index < 2 ? 'urgent' : ''}`}>{index + 1}</span><span><strong>{item.lrv_id} · {cycleLabel(item.cycle_type)}</strong><small>{item.status === 'maintenance' ? 'Already in depot' : forecastLabel(item.forecast_days)}</small></span><span><b>{formatKm(item.km_to_next)}</b><small>{item.status.replace('_', ' ')}</small></span><Icon name="chevron"/>
            </button>)}</div>
          </Card>
          <Card title="Suggested recall" eyebrow="Best available intervention">
            <div className="suggestion-hero"><span><Icon name="wrench" size={26}/></span><div><small>Recommended next</small><h3>{model.queue[0]?.lrv_id} · {cycleLabel(model.queue[0]?.cycle_type)}</h3><p>{model.queue[0]?.lrv_id === 'D18' ? 'Complete the overdue 2K inspection already booked in Bay 1.' : 'Reserve the earliest compatible bay before the forecast window closes.'}</p></div></div>
            <div className="reason-box"><strong>Decision factors</strong><span>Forecast urgency · bay capability · minimum service fleet · bundle proximity</span></div>
            {model.queue[0] && <button className="button button-primary button-full" onClick={() => suggest(model.queue[0])}>Review suggested slot</button>}
          </Card>
        </div>

        <Card title="Weekly depot schedule" eyebrow="Two-bay capacity · click a booking to adjust">
          <div className="schedule-grid"><div className="schedule-label"/><>{model.days.map((day) => <div className="schedule-day" key={day}><strong>{formatDate(day)}</strong><small>{day === singaporeDate() ? 'Today' : ''}</small></div>)}</>
            {state.data.bays.map((bay) => <ScheduleRow key={bay.bay_id} bay={bay} days={model.days} bookings={state.data.bookings} onEdit={editBooking} onComplete={complete}/>)}</div>
        </Card>

        {editing && <div className="modal-backdrop" onMouseDown={() => setEditing(false)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><div className="eyebrow">Forecast-based planning</div><h2>{form.bookingId ? 'Adjust booking' : 'Create maintenance booking'}</h2></div><button onClick={() => setEditing(false)}>×</button></div>
          <form onSubmit={submit} className="form-grid">
            <label>Vehicle<select value={form.lrvId} required onChange={(e) => setForm({ ...form, lrvId: e.target.value })}><option value="">Select LRV</option>{state.data.vehicles.map((vehicle) => <option key={vehicle.lrv_id}>{vehicle.lrv_id}</option>)}</select></label>
            <label>Primary cycle<select value={form.primaryCycle} onChange={(e) => setForm({ ...form, primaryCycle: Number(e.target.value), bundledCycles: [Number(e.target.value)] })}>{state.data.rules.map((rule) => <option key={rule.cycle_type} value={rule.cycle_type}>{cycleLabel(rule.cycle_type)}</option>)}</select></label>
            <label>Depot bay<select value={form.bayId} required onChange={(e) => setForm({ ...form, bayId: e.target.value })}><option value="">Select compatible bay</option>{state.data.bays.filter((bay) => bay.active).map((bay) => <option key={bay.bay_id} value={bay.bay_id}>{bay.name}</option>)}</select></label>
            <label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="proposed">Proposed</option><option value="confirmed">Confirmed</option></select></label>
            <label>Date<input type="date" value={form.date} min={singaporeDate()} required onChange={(e) => setForm({ ...form, date: e.target.value })}/></label>
            <label>Start time<input type="time" value={form.time} required onChange={(e) => setForm({ ...form, time: e.target.value })}/></label>
            <fieldset className="form-span"><legend>Complete in this visit</legend><div className="cycle-checks">{state.data.rules.filter((rule) => Number(rule.cycle_type) <= Number(form.primaryCycle)).map((rule) => <label key={rule.cycle_type}><input type="checkbox" checked={form.bundledCycles.includes(Number(rule.cycle_type))} onChange={(e) => setForm({ ...form, bundledCycles: e.target.checked ? [...new Set([...form.bundledCycles, Number(rule.cycle_type)])] : form.bundledCycles.filter((cycle) => cycle !== Number(rule.cycle_type)) })}/>{cycleLabel(rule.cycle_type)}</label>)}</div></fieldset>
            <label className="form-span">Planning note<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}/></label>
            <div className="modal-actions form-span"><button type="button" className="button button-secondary" onClick={() => setEditing(false)}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? 'Checking capacity…' : 'Save booking'}</button></div>
          </form></div></div>}
      </>}
    </DataBoundary>
    <Toast message={toast?.message} tone={toast?.tone} onClose={() => setToast(null)}/>
  </>
}

function buildMaintenanceModel(data) {
  if (!data) return null
  const vehicles = new Map(data.vehicles.map((vehicle) => [vehicle.lrv_id, vehicle]))
  const nearest = new Map()
  data.forecasts.forEach((item) => { const current = nearest.get(item.lrv_id); if (!current || Number(item.priority_score) > Number(current.priority_score)) nearest.set(item.lrv_id, { ...item, status: vehicles.get(item.lrv_id)?.status }) })
  const queue = [...nearest.values()].sort((a, b) => Number(b.priority_score) - Number(a.priority_score)).slice(0, 12)
  const counts = new Map()
  data.forecasts.filter((row) => row.forecast_days !== null && Number(row.forecast_days) <= 3).forEach((row) => counts.set(row.lrv_id, (counts.get(row.lrv_id) || 0) + 1))
  return {
    queue, overdue: queue.filter((row) => Number(row.km_to_next) <= 0).length,
    dueSoon: queue.filter((row) => row.forecast_days !== null && Number(row.forecast_days) >= 0 && Number(row.forecast_days) <= 7).length,
    confirmed: data.bookings.filter((row) => row.status === 'confirmed' && dayOffset(row.start_at) >= 0 && dayOffset(row.start_at) < 7).length,
    bundles: [...counts.values()].filter((count) => count > 1).length,
    days: Array.from({ length: 7 }, (_, index) => singaporeDate(index)),
  }
}

function dayOffset(value) {
  return Math.round((new Date(value) - new Date(`${singaporeDate()}T00:00:00+08:00`)) / 86400000)
}

function ScheduleRow({ bay, days, bookings, onEdit, onComplete }) {
  return <><div className="schedule-label"><strong>{bay.name}</strong><small>{bay.opens_at.slice(0, 5)}–{bay.closes_at.slice(0, 5)}</small></div>{days.map((day) => {
    const items = bookings.filter((booking) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(booking.start_at)) === day && booking.bay_id === bay.bay_id && booking.status !== 'cancelled')
    return <div className="schedule-cell" key={`${bay.bay_id}-${day}`}>{items.map((booking) => <div className={`booking booking-${booking.status}`} key={booking.id}><button onClick={() => onEdit(booking)}><strong>{booking.lrv_id} · {cycleLabel(booking.primary_cycle)}</strong><span>{formatTime(booking.start_at)}–{formatTime(booking.end_at)}</span><Badge value={booking.status}/></button>{booking.status === 'confirmed' && <button className="complete-link" onClick={() => onComplete(booking)}>Complete</button>}</div>)}</div>
  })}</>
}
