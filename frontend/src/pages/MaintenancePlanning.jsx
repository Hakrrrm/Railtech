import { useEffect, useMemo, useState } from 'react'
import { cancelMaintenanceBooking, completeMaintenance, loadMaintenancePlanning, scheduleMaintenance } from '../lib/api'
import { cycleLabel, formatDate, formatDuration, formatKm, formatTime, singaporeDate, statusLabel, vehicleLabel } from '../lib/format'
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
  const [completion, setCompletion] = useState(null)
  const [toast, setToast] = useState(null)
  const [saving, setSaving] = useState(false)
  const model = useMemo(() => buildMaintenanceModel(state.data), [state.data])
  useEffect(() => { if (state.updatedAt) reportUpdatedAt(state.updatedAt) }, [state.updatedAt, reportUpdatedAt])

  const suggest = (item) => {
    const approaching = state.data.forecasts.filter((cycle) => cycle.lrv_id === item.lrv_id && cycle.forecast_days !== null && Number(cycle.forecast_days) <= Number(item.forecast_days) + 2).map((cycle) => Number(cycle.cycle_type))
    const primaryCycle = Math.max(Number(item.cycle_type), ...approaching)
    const rule = state.data.rules.find((candidate) => Number(candidate.cycle_type) === primaryCycle)
    const cycles = rule?.included_cycles?.map(Number) || [primaryCycle]
    const bay = state.data.bays.find((candidate) => candidate.active && (candidate.bay_type === rule?.compatible_bay_type || candidate.bay_type === 'universal')) || state.data.bays.find((candidate) => candidate.active)
    setForm({ ...emptyForm, lrvId: item.lrv_id, primaryCycle, bundledCycles: cycles, bayId: bay?.bay_id || '', date: singaporeDate(Math.max(1, Math.min(6, Number(item.forecast_days || 1)))), notes: cycles.length > 1 ? `${cycleLabel(primaryCycle)} standard package includes ${cycles.map(cycleLabel).join(', ')}` : `${cycleLabel(primaryCycle)} forecast-based recall` })
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
      setToast({ message: `${vehicleLabel(form.lrvId)} booking ${form.bookingId ? 'updated' : 'created'}.`, tone: 'success' }); setEditing(false); setForm(emptyForm); state.refresh(true)
    } catch (error) { setToast({ message: error.message, tone: 'danger' }) } finally { setSaving(false) }
  }

  const beginCompletion = (booking) => {
    const fallback = state.data.mileage.find((row) => row.lrv_id === booking.lrv_id)
    setCompletion({
      booking,
      mileageKm: fallback?.lifetime_planning_mileage_km || fallback?.device_odo_km || '',
      technicianId: 'TECH_DEMO',
      completedCycles: booking.bundled_cycles.map(Number),
      notes: '',
    })
  }

  const submitCompletion = async (event) => {
    event.preventDefault()
    if (!completion.completedCycles.length) { setToast({ message: 'Select at least one cycle that was actually completed.', tone: 'danger' }); return }
    const planned = completion.booking.bundled_cycles.map(Number)
    const partial = planned.some((cycle) => !completion.completedCycles.includes(cycle))
    if (partial && !completion.notes.trim()) { setToast({ message: 'Explain why the completed scope differs from the planned package.', tone: 'danger' }); return }
    setSaving(true)
    try {
      await completeMaintenance({
        lrvId: completion.booking.lrv_id, primaryCycle: completion.booking.primary_cycle,
        mileageKm: completion.mileageKm, technicianId: completion.technicianId,
        bookingId: completion.booking.id, notes: completion.notes,
        completedCycles: completion.completedCycles,
      })
      setToast({ message: `${cycleLabel(completion.booking.primary_cycle)} visit recorded; only confirmed completed cycles were reset.`, tone: 'success' })
      setCompletion(null); state.refresh(true)
    } catch (error) { setToast({ message: error.message, tone: 'danger' }) } finally { setSaving(false) }
  }

  const cancelBooking = async () => {
    if (!form.bookingId || !globalThis.confirm(`Cancel the ${vehicleLabel(form.lrvId)} maintenance booking?`)) return
    setSaving(true)
    try {
      await cancelMaintenanceBooking(form.bookingId)
      setToast({ message: `${vehicleLabel(form.lrvId)} booking cancelled.`, tone: 'success' }); setEditing(false); setForm(emptyForm); state.refresh(true)
    } catch (error) { setToast({ message: error.message, tone: 'danger' }) } finally { setSaving(false) }
  }

  return <>
    <PageHeader title="Maintenance planning" actions={<button className="button button-primary" onClick={() => setEditing(true)}><Icon name="calendar"/>New booking</button>}/>
    <DataBoundary loading={state.loading} error={state.error} empty={!state.data?.vehicles?.length} onRetry={state.refresh}>
      {model && <>
        <div className="metric-grid metric-grid-three">
          <MetricCard label="Overdue recalls" value={model.overdue} detail="Requires immediate control" tone="danger" icon="alert"/>
          <MetricCard label="Due within 7 days" value={model.dueSoon} detail="Grouped by vehicle" tone="warning" icon="clock"/>
          <MetricCard label="Confirmed this week" value={model.confirmed} detail="Continuous depot/bay stays" tone="success" icon="calendar"/>
        </div>

        <Card title="Weekly depot schedule" className="schedule-card">
          <div className="schedule-grid"><div className="schedule-label"/><>{model.days.map((day) => <div className="schedule-day" key={day}><strong>{formatDate(day)}</strong><small>{day === singaporeDate() ? 'Today' : ''}</small></div>)}</>
            {state.data.bays.map((bay) => <ScheduleRow key={bay.bay_id} bay={bay} days={model.days} bookings={state.data.bookings} onEdit={editBooking} onComplete={beginCompletion}/>)}</div>
        </Card>

        <Card title="Maintenance priority queue" className="maintenance-priority-card-wrap">
          <div className="maintenance-priority-grid">{model.queue.map((item, index) => <article className="maintenance-priority-item" key={item.lrv_id}>
            <span className={`queue-rank ${Number(item.km_to_next) < 0 ? 'urgent' : ''}`}>{index + 1}</span>
            <div className="maintenance-priority-main"><strong>{vehicleLabel(item.lrv_id)} · {cycleLabel(item.cycle_type)}</strong><small>{queueForecastLabel(item)}</small></div>
            <div className="maintenance-priority-distance"><b>{queueDistanceLabel(item.km_to_next)}</b><small>{statusLabel(item.status)}</small></div>
            <button className="priority-add" onClick={() => suggest(item)} aria-label={`Add ${vehicleLabel(item.lrv_id)} to the weekly depot schedule`} title="Add to schedule"><Icon name="plus"/></button>
          </article>)}</div>
        </Card>

        {editing && <div className="modal-backdrop" onMouseDown={() => setEditing(false)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><h2>{form.bookingId ? 'Adjust booking' : 'Create maintenance booking'}</h2><button onClick={() => setEditing(false)}>×</button></div>
          <form onSubmit={submit} className="form-grid">
            <label>Vehicle<select value={form.lrvId} required onChange={(e) => setForm({ ...form, lrvId: e.target.value })}><option value="">Select LRV</option>{state.data.vehicles.map((vehicle) => <option key={vehicle.lrv_id} value={vehicle.lrv_id}>{vehicleLabel(vehicle.lrv_id)}</option>)}</select></label>
            <label>Primary cycle<select value={form.primaryCycle} onChange={(e) => { const primaryCycle = Number(e.target.value); const rule = state.data.rules.find((candidate) => Number(candidate.cycle_type) === primaryCycle); setForm({ ...form, primaryCycle, bundledCycles: rule?.included_cycles?.map(Number) || [primaryCycle] }) }}>{state.data.rules.map((rule) => <option key={rule.cycle_type} value={rule.cycle_type}>{cycleLabel(rule.cycle_type)}</option>)}</select></label>
            <label>Depot bay<select value={form.bayId} required onChange={(e) => setForm({ ...form, bayId: e.target.value })}><option value="">Select compatible bay</option>{state.data.bays.filter((bay) => bay.active).map((bay) => <option key={bay.bay_id} value={bay.bay_id}>{bay.name}</option>)}</select></label>
            <label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="proposed">Proposed</option><option value="confirmed">Confirmed</option></select></label>
            <label>Date<input type="date" value={form.date} min={singaporeDate()} required onChange={(e) => setForm({ ...form, date: e.target.value })}/></label>
            <label>Start time<input type="time" value={form.time} required onChange={(e) => setForm({ ...form, time: e.target.value })}/></label>
            <fieldset className="form-span"><legend>Standard package scope</legend><div className="cycle-checks">{form.bundledCycles.map((cycle) => <label key={cycle}><input type="checkbox" checked readOnly/>{cycleLabel(cycle)}</label>)}</div><small>The technician records the cycles actually completed when closing the visit.</small></fieldset>
            <div className="form-span scope-summary"><strong>Expected continuous occupancy</strong><span>{formatDuration(state.data.rules.find((rule) => Number(rule.cycle_type) === Number(form.primaryCycle))?.duration_minutes)} · return at the same time of day for multi-day packages</span></div>
            <label className="form-span">Planning note<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}/></label>
            <div className="modal-actions form-span">{form.bookingId && <button type="button" className="button button-secondary" disabled={saving} onClick={cancelBooking}>Cancel booking</button>}<button type="button" className="button button-secondary" onClick={() => setEditing(false)}>Close</button><button className="button button-primary" disabled={saving}>{saving ? 'Checking capacity…' : 'Save booking'}</button></div>
          </form></div></div>}

        {completion && <div className="modal-backdrop" onMouseDown={() => setCompletion(null)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><h2>{vehicleLabel(completion.booking.lrv_id)} · {cycleLabel(completion.booking.primary_cycle)} visit</h2><button onClick={() => setCompletion(null)}>×</button></div>
          <form onSubmit={submitCompletion} className="form-grid">
            <label>Definite hubometer reading (km)<input type="number" min="0" step="0.1" required value={completion.mileageKm} onChange={(event) => setCompletion({ ...completion, mileageKm: event.target.value })}/></label>
            <label>Technician ID<input required value={completion.technicianId} onChange={(event) => setCompletion({ ...completion, technicianId: event.target.value })}/></label>
            <fieldset className="form-span"><legend>Cycles actually completed</legend><div className="cycle-checks">{completion.booking.bundled_cycles.map(Number).map((cycle) => <label key={cycle}><input type="checkbox" checked={completion.completedCycles.includes(cycle)} onChange={(event) => setCompletion({ ...completion, completedCycles: event.target.checked ? [...completion.completedCycles, cycle].sort((a, b) => a - b) : completion.completedCycles.filter((item) => item !== cycle) })}/>{cycleLabel(cycle)}</label>)}</div><small>Only selected cycles will reset. A reduced scope requires an explanation.</small></fieldset>
            <label className="form-span">Completion note<textarea value={completion.notes} placeholder="Required when planned work was not completed" onChange={(event) => setCompletion({ ...completion, notes: event.target.value })}/></label>
            <div className="modal-actions form-span"><button type="button" className="button button-secondary" onClick={() => setCompletion(null)}>Close</button><button className="button button-primary" disabled={saving}>{saving ? 'Recording…' : 'Record actual work'}</button></div>
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
  return {
    queue, overdue: queue.filter((row) => Number(row.km_to_next) < 0).length,
    dueSoon: queue.filter((row) => row.forecast_days !== null && Number(row.forecast_days) >= 0 && Number(row.forecast_days) <= 7).length,
    confirmed: data.bookings.filter((row) => row.status === 'confirmed' && dayOffset(row.start_at) >= 0 && dayOffset(row.start_at) < 7).length,
    days: Array.from({ length: 7 }, (_, index) => singaporeDate(index)),
  }
}

function dayOffset(value) {
  const bookingDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(value))
  return Math.round((new Date(`${bookingDate}T00:00:00+08:00`) - new Date(`${singaporeDate()}T00:00:00+08:00`)) / 86400000)
}

function ScheduleRow({ bay, days, bookings, onEdit, onComplete }) {
  const layout = layoutScheduleBookings(bookings, bay.bay_id, days)
  const lanes = Math.max(1, ...layout.map((item) => item.lane + 1))
  const rowHeight = Math.max(86, lanes * 62 + 12)
  return <><div className="schedule-label" style={{ height: rowHeight }}><strong>{bay.name}</strong><small>{bay.opens_at.slice(0, 5)}–{bay.closes_at.slice(0, 5)}</small></div><div className="schedule-track" style={{ height: rowHeight }}>
    {layout.map(({ booking, startDay, endDay, lane, continuesBefore, continuesAfter }) => {
      const left = (startDay / days.length) * 100
      const width = ((endDay - startDay) / days.length) * 100
      return <div className={`schedule-booking booking-${booking.status}`} key={booking.id} style={{ left: `calc(${left}% + 6px)`, width: `calc(${width}% - 12px)`, top: 8 + lane * 62 }}>
        <button disabled={!['proposed', 'confirmed'].includes(booking.status)} onClick={() => onEdit(booking)}>
          <strong>{vehicleLabel(booking.lrv_id)} · {cycleLabel(booking.primary_cycle)}</strong>
          <span>{bookingRangeLabel(booking, continuesBefore, continuesAfter)}</span>
          <Badge value={booking.status}/>
        </button>
        {booking.status === 'confirmed' && <button className="complete-link" onClick={() => onComplete(booking)}>Record completion</button>}
      </div>
    })}
  </div></>
}

function layoutScheduleBookings(bookings, bayId, days) {
  const dayMs = 86400000
  const weekStart = new Date(`${days[0]}T00:00:00+08:00`)
  const weekEnd = new Date(weekStart.getTime() + days.length * dayMs)
  const laneEnds = []
  return bookings
    .filter((booking) => booking.bay_id === bayId && booking.status !== 'cancelled' && new Date(booking.start_at) < weekEnd && new Date(booking.end_at) > weekStart)
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
    .map((booking) => {
      const start = new Date(booking.start_at)
      const end = new Date(booking.end_at)
      const startDay = Math.max(0, Math.floor((start - weekStart) / dayMs))
      const endDay = Math.min(days.length, Math.max(startDay + 1, Math.ceil((end - weekStart) / dayMs)))
      let lane = laneEnds.findIndex((occupiedUntil) => occupiedUntil <= startDay)
      if (lane === -1) lane = laneEnds.length
      laneEnds[lane] = endDay
      return { booking, startDay, endDay, lane, continuesBefore: start < weekStart, continuesAfter: end > weekEnd }
    })
}

function bookingRangeLabel(booking, continuesBefore, continuesAfter) {
  const startDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(booking.start_at))
  const endDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(booking.end_at))
  const range = startDay === endDay ? `${formatTime(booking.start_at)}–${formatTime(booking.end_at)}` : `${formatDate(booking.start_at)} ${formatTime(booking.start_at)} → ${formatDate(booking.end_at)} ${formatTime(booking.end_at)}`
  return `${continuesBefore ? '← ' : ''}${range}${continuesAfter ? ' · continues →' : ''}`
}

function queueForecastLabel(item) {
  if (Number(item.km_to_next) < 0) return 'Overdue'
  if (Number(item.km_to_next) === 0) return 'Due today'
  if (item.status === 'maintenance') return 'Already in depot'
  if (item.forecast_days === null || item.forecast_days === undefined) return 'Awaiting reliable telemetry'
  if (Number(item.forecast_days) === 0) return 'Due today'
  if (Number(item.forecast_days) === 1) return 'Due tomorrow'
  return `Due in ${item.forecast_days} days`
}

function queueDistanceLabel(value) {
  const km = Number(value)
  if (km < 0) return `${formatKm(Math.abs(km))} overdue`
  if (km === 0) return 'Due now'
  return `${formatKm(km)} remaining`
}
