import { useEffect, useMemo, useState } from 'react'
import { cancelMaintenanceBooking, completeMaintenance, loadMaintenancePlanning, scheduleMaintenance } from '../lib/api'
import { cycleLabel, forecastLabel, formatDate, formatDateTimeRange, formatDuration, formatKm, formatTime, singaporeDate } from '../lib/format'
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
      setToast({ message: `${form.lrvId} booking ${form.bookingId ? 'updated' : 'created'}.`, tone: 'success' }); setEditing(false); setForm(emptyForm); state.refresh(true)
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
    if (!form.bookingId || !globalThis.confirm(`Cancel the ${form.lrvId} maintenance booking?`)) return
    setSaving(true)
    try {
      await cancelMaintenanceBooking(form.bookingId)
      setToast({ message: `${form.lrvId} booking cancelled.`, tone: 'success' }); setEditing(false); setForm(emptyForm); state.refresh(true)
    } catch (error) { setToast({ message: error.message, tone: 'danger' }) } finally { setSaving(false) }
  }

  return <>
    <PageHeader eyebrow="Depot control" title="Maintenance Planning" description="Turn mileage forecasts into recall decisions while protecting service coverage." actions={<button className="button button-primary" onClick={() => setEditing(true)}><Icon name="calendar"/>New booking</button>}/>
    <DataBoundary loading={state.loading} error={state.error} empty={!state.data?.vehicles?.length} onRetry={state.refresh}>
      {model && <>
        <div className="metric-grid">
          <MetricCard label="Overdue recalls" value={model.overdue} detail="Requires immediate control" tone="danger" icon="alert"/>
          <MetricCard label="Due within 7 days" value={model.dueSoon} detail="Grouped by vehicle" tone="warning" icon="clock"/>
          <MetricCard label="Confirmed this week" value={model.confirmed} detail="Continuous depot/bay stays" tone="success" icon="calendar"/>
          <MetricCard label="Compound packages" value={model.compoundPackages} detail="Standard nested scope" tone="info" icon="wrench"/>
        </div>

        <div className="maintenance-layout">
          <Card title="Recall queue" eyebrow="Ranked by urgency and serviceability">
            <div className="recall-list">{model.queue.map((item, index) => <button key={item.lrv_id} onClick={() => suggest(item)}>
              <span className={`queue-rank ${index < 2 ? 'urgent' : ''}`}>{index + 1}</span><span><strong>{item.lrv_id} · {cycleLabel(item.cycle_type)}</strong><small>{item.status === 'maintenance' ? 'Already in depot' : forecastLabel(item.forecast_days)}</small></span><span><b>{formatKm(item.km_to_next)}</b><small>{item.status.replace('_', ' ')}</small></span><Icon name="chevron"/>
            </button>)}</div>
          </Card>
          <Card title="Suggested recall" eyebrow="Best available intervention">
            <div className="suggestion-hero"><span><Icon name="wrench" size={26}/></span><div><small>Recommended next</small><h3>{model.queue[0]?.lrv_id} · {cycleLabel(model.queue[0]?.cycle_type)}</h3><p>{model.queue[0]?.lrv_id === 'D18' ? 'Complete the overdue 2K inspection already booked in Bay 1.' : 'Reserve the earliest compatible bay before the forecast window closes.'}</p></div></div>
            <div className="reason-box"><strong>Decision factors</strong><span>Forecast urgency · standard package scope · continuous bay occupancy · minimum service fleet</span></div>
            {model.queue[0] && <button className="button button-primary button-full" onClick={() => suggest(model.queue[0])}>Review suggested slot</button>}
          </Card>
        </div>

        {model.longStays.length > 0 && <Card title="Long depot commitments" eyebrow="Continuous bay occupation · weekends and waiting time included">
          <div className="long-stay-list">{model.longStays.map((booking) => <article key={booking.id}><div><strong>{booking.lrv_id} · {cycleLabel(booking.primary_cycle)} package</strong><small>{booking.bundled_cycles.map(cycleLabel).join(' + ')}</small></div><div><b>{formatDuration((new Date(booking.end_at) - new Date(booking.start_at)) / 60000)}</b><small>{formatDateTimeRange(booking.start_at, booking.end_at)}</small></div><Badge value={booking.status}/></article>)}</div>
        </Card>}

        <Card title="Weekly depot schedule" eyebrow="Two-bay continuous occupancy · multi-day visits appear on every affected day">
          <div className="schedule-grid"><div className="schedule-label"/><>{model.days.map((day) => <div className="schedule-day" key={day}><strong>{formatDate(day)}</strong><small>{day === singaporeDate() ? 'Today' : ''}</small></div>)}</>
            {state.data.bays.map((bay) => <ScheduleRow key={bay.bay_id} bay={bay} days={model.days} bookings={state.data.bookings} onEdit={editBooking} onComplete={beginCompletion}/>)}</div>
        </Card>

        {editing && <div className="modal-backdrop" onMouseDown={() => setEditing(false)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><div className="eyebrow">Forecast-based planning</div><h2>{form.bookingId ? 'Adjust booking' : 'Create maintenance booking'}</h2></div><button onClick={() => setEditing(false)}>×</button></div>
          <form onSubmit={submit} className="form-grid">
            <label>Vehicle<select value={form.lrvId} required onChange={(e) => setForm({ ...form, lrvId: e.target.value })}><option value="">Select LRV</option>{state.data.vehicles.map((vehicle) => <option key={vehicle.lrv_id}>{vehicle.lrv_id}</option>)}</select></label>
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

        {completion && <div className="modal-backdrop" onMouseDown={() => setCompletion(null)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><div><div className="eyebrow">Technician completion record</div><h2>{completion.booking.lrv_id} · {cycleLabel(completion.booking.primary_cycle)} visit</h2></div><button onClick={() => setCompletion(null)}>×</button></div>
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
    queue, overdue: queue.filter((row) => Number(row.km_to_next) <= 0).length,
    dueSoon: queue.filter((row) => row.forecast_days !== null && Number(row.forecast_days) >= 0 && Number(row.forecast_days) <= 7).length,
    confirmed: data.bookings.filter((row) => row.status === 'confirmed' && dayOffset(row.start_at) >= 0 && dayOffset(row.start_at) < 7).length,
    compoundPackages: queue.filter((item) => (data.rules.find((rule) => Number(rule.cycle_type) === Number(item.cycle_type))?.included_cycles?.length || 1) > 1).length,
    longStays: data.bookings.filter((booking) => ['proposed', 'confirmed'].includes(booking.status) && new Date(booking.end_at) - new Date(booking.start_at) >= 86400000).sort((a, b) => new Date(a.start_at) - new Date(b.start_at)),
    days: Array.from({ length: 7 }, (_, index) => singaporeDate(index)),
  }
}

function dayOffset(value) {
  const bookingDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(value))
  return Math.round((new Date(`${bookingDate}T00:00:00+08:00`) - new Date(`${singaporeDate()}T00:00:00+08:00`)) / 86400000)
}

function ScheduleRow({ bay, days, bookings, onEdit, onComplete }) {
  return <><div className="schedule-label"><strong>{bay.name}</strong><small>{bay.opens_at.slice(0, 5)}–{bay.closes_at.slice(0, 5)}</small></div>{days.map((day) => {
    const dayStart = new Date(`${day}T00:00:00+08:00`); const dayEnd = new Date(dayStart.getTime() + 86400000)
    const items = bookings.filter((booking) => new Date(booking.start_at) < dayEnd && new Date(booking.end_at) > dayStart && booking.bay_id === bay.bay_id && booking.status !== 'cancelled')
    return <div className="schedule-cell" key={`${bay.bay_id}-${day}`}>{items.map((booking) => { const startsToday = new Date(booking.start_at) >= dayStart; const endsToday = new Date(booking.end_at) <= dayEnd; const timing = startsToday && endsToday ? `${formatTime(booking.start_at)}–${formatTime(booking.end_at)}` : startsToday ? `Starts ${formatTime(booking.start_at)}` : endsToday ? `Ends ${formatTime(booking.end_at)}` : 'Occupied all day'; return <div className={`booking booking-${booking.status}`} key={booking.id}><button disabled={!['proposed', 'confirmed'].includes(booking.status)} onClick={() => onEdit(booking)}><strong>{booking.lrv_id} · {cycleLabel(booking.primary_cycle)}</strong><span>{timing}</span><Badge value={booking.status}/></button>{booking.status === 'confirmed' && endsToday && <button className="complete-link" onClick={() => onComplete(booking)}>Record completion</button>}</div> })}</div>
  })}</>
}
