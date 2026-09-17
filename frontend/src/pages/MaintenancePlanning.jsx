import { useEffect, useMemo, useState } from 'react'
import { cancelMaintenanceBooking, completeMaintenance, loadMaintenancePlanning, scheduleMaintenance } from '../lib/api'
import { cycleLabel, formatDate, formatDateTime, formatDuration, formatKm, formatTime, singaporeDate, vehicleLabel } from '../lib/format'
import { useSupabaseData } from '../hooks/useSupabaseData'
import { Badge, Card, DataBoundary, MetricCard, PageHeader, Toast } from '../components/UI'
import { Icon } from '../components/Icons'
import { compareMaintenancePriority, maintenancePriorityCategory, matchesMaintenancePriorityFilter } from '../lib/maintenancePriority'

const subscriptions = [
  { table: 'maintenance_bookings' }, { table: 'maintenance_events', event: 'INSERT' },
  { table: 'maintenance_faults' },
  { table: 'cycle_state' }, { table: 'vehicles' }, { table: 'segment_traversals', event: 'INSERT' },
]

const emptyForm = { workType: 'preventive', lrvId: '', primaryCycle: 2000, bundledCycles: [2000], faultId: '', durationMinutes: 120, bayId: '', date: singaporeDate(1), time: '09:00', status: 'proposed', notes: '' }

export function MaintenancePlanning({ reportUpdatedAt }) {
  const state = useSupabaseData(loadMaintenancePlanning, [], subscriptions)
  const [form, setForm] = useState(emptyForm)
  const [editing, setEditing] = useState(false)
  const [completion, setCompletion] = useState(null)
  const [toast, setToast] = useState(null)
  const [saving, setSaving] = useState(false)
  const [weekOffset, setWeekOffset] = useState(0)
  const [priorityFilter, setPriorityFilter] = useState('all')
  const model = useMemo(() => buildMaintenanceModel(state.data, weekOffset), [state.data, weekOffset])
  const visibleQueue = useMemo(() => model?.queue.filter((item) => matchesMaintenancePriorityFilter(item, priorityFilter)) || [], [model, priorityFilter])
  const queueCounts = useMemo(() => ({
    today: model?.queue.filter((item) => maintenancePriorityCategory(item) === 'today').length || 0,
    week: model?.queue.filter((item) => matchesMaintenancePriorityFilter(item, 'week')).length || 0,
    fault: model?.queue.filter((item) => maintenancePriorityCategory(item) === 'fault').length || 0,
  }), [model])
  const selectedFault = state.data?.faults?.find((fault) => fault.id === form.faultId)
  const selectedRule = form.workType === 'corrective'
    ? { compatible_bay_type: selectedFault?.required_bay_type }
    : state.data?.rules?.find((rule) => Number(rule.cycle_type) === Number(form.primaryCycle))
  useEffect(() => { if (state.updatedAt) reportUpdatedAt(state.updatedAt) }, [state.updatedAt, reportUpdatedAt])

  const suggest = (item) => {
    if (item.booking) {
      editBooking(item.booking)
      return
    }
    if (item.work_type === 'corrective') {
      const fault = item.fault
      const rule = { duration_minutes: fault.estimated_duration_minutes, compatible_bay_type: fault.required_bay_type }
      const slot = findAvailableSlot(rule, state.data.bays, state.data.bookings, state.data.duties, item.lrv_id, 0)
      if (!slot) {
        setToast({ message: `No collision-free ${fault.required_bay_type} bay is available for ${vehicleLabel(item.lrv_id)} in the next six weeks.`, tone: 'danger' })
        return
      }
      setWeekOffset(Math.floor(dayOffset(slot.start) / 7))
      setForm({
        ...emptyForm, workType: 'corrective', lrvId: item.lrv_id, primaryCycle: null,
        bundledCycles: [], faultId: fault.id, durationMinutes: Number(fault.estimated_duration_minutes),
        bayId: slot.bay.bay_id, date: singaporeDateFrom(slot.start), time: formatTime(slot.start),
        notes: `${fault.fault_code}: ${fault.description} · first compatible free slot selected automatically`,
      })
      setEditing(true)
      return
    }
    const approaching = state.data.forecasts.filter((cycle) => cycle.lrv_id === item.lrv_id && cycle.forecast_days !== null && Number(cycle.forecast_days) <= Number(item.forecast_days) + 2).map((cycle) => Number(cycle.cycle_type))
    const primaryCycle = Math.max(Number(item.cycle_type), ...approaching)
    const rule = state.data.rules.find((candidate) => Number(candidate.cycle_type) === primaryCycle)
    const cycles = rule?.included_cycles?.map(Number) || [primaryCycle]
    const forecastDays = Number(item.forecast_days)
    const hasForecast = item.forecast_days !== null && item.forecast_days !== undefined && Number.isFinite(forecastDays)
    // Start on the forecast due date, then walk forward to the next free slot.
    const preferredOffset = hasForecast ? Math.max(0, Math.ceil(forecastDays)) : 1
    const slot = findAvailableSlot(rule, state.data.bays, state.data.bookings, state.data.duties, item.lrv_id, preferredOffset)
    if (!slot) {
      setToast({ message: `No compatible free bay was found for ${vehicleLabel(item.lrv_id)} in the next six weeks.`, tone: 'danger' })
      return
    }
    setWeekOffset(Math.floor(dayOffset(slot.start) / 7))
    setForm({ ...emptyForm, workType: 'preventive', lrvId: item.lrv_id, primaryCycle, bundledCycles: cycles, durationMinutes: Number(rule?.duration_minutes || 120), bayId: slot.bay.bay_id, date: singaporeDateFrom(slot.start), time: formatTime(slot.start), notes: cycles.length > 1 ? `${cycleLabel(primaryCycle)} package includes ${cycles.map(cycleLabel).join(', ')} · earliest compatible slot on or after the forecast due date` : `${cycleLabel(primaryCycle)} recall · earliest compatible slot on or after the forecast due date` })
    setEditing(true)
  }

  const editBooking = (booking) => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(booking.start_at))
    setWeekOffset(Math.floor(dayOffset(booking.start_at) / 7))
    setForm({
      workType: booking.work_type || 'preventive', lrvId: booking.lrv_id,
      primaryCycle: booking.primary_cycle, bundledCycles: booking.bundled_cycles || [],
      faultId: booking.fault_id || '', durationMinutes: Math.round((new Date(booking.end_at) - new Date(booking.start_at)) / 60000),
      bayId: booking.bay_id, date, time: formatTime(booking.start_at), status: booking.status,
      notes: booking.notes || '', bookingId: booking.id,
    })
    setEditing(true)
  }

  const submit = async (event) => {
    event.preventDefault(); setSaving(true)
    try {
      const rule = state.data.rules.find((candidate) => Number(candidate.cycle_type) === Number(form.primaryCycle))
      const start = new Date(`${form.date}T${form.time}:00+08:00`)
      const durationMinutes = form.workType === 'corrective' ? Number(form.durationMinutes) : Number(rule?.duration_minutes || 90)
      const end = new Date(start.getTime() + durationMinutes * 60000)
      const conflict = findBookingConflict(state.data.bookings, form.bayId, form.lrvId, start, end, form.bookingId)
      if (conflict) throw new Error(conflict)
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
      completedCycles: booking.work_type === 'corrective' ? [] : booking.bundled_cycles.map(Number),
      notes: '',
    })
  }

  const submitCompletion = async (event) => {
    event.preventDefault()
    const corrective = completion.booking.work_type === 'corrective'
    if (!corrective && !completion.completedCycles.length) { setToast({ message: 'Select at least one cycle that was actually completed.', tone: 'danger' }); return }
    const planned = completion.booking.bundled_cycles.map(Number)
    const partial = !corrective && planned.some((cycle) => !completion.completedCycles.includes(cycle))
    if ((corrective || partial) && !completion.notes.trim()) { setToast({ message: corrective ? 'Record the corrective repair outcome before closing the fault.' : 'Explain why the completed scope differs from the planned package.', tone: 'danger' }); return }
    setSaving(true)
    try {
      await completeMaintenance({
        lrvId: completion.booking.lrv_id, primaryCycle: completion.booking.primary_cycle,
        mileageKm: completion.mileageKm, technicianId: completion.technicianId,
        bookingId: completion.booking.id, notes: completion.notes,
        completedCycles: completion.completedCycles,
        workType: completion.booking.work_type || 'preventive', faultId: completion.booking.fault_id || null,
      })
      setToast({ message: corrective ? 'Corrective repair recorded and the fault was closed.' : `${cycleLabel(completion.booking.primary_cycle)} visit recorded; only confirmed completed cycles were reset.`, tone: 'success' })
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

        <div className="maintenance-planning-grid">
          <Card title="Weekly depot schedule" className="schedule-card" action={<div className="week-nav"><button className="icon-button" onClick={() => setWeekOffset((value) => value - 1)} aria-label="Previous week"><Icon name="arrow"/></button><span>{formatDate(model.days[0])} – {formatDate(model.days[6])}</span><button className="icon-button" onClick={() => setWeekOffset((value) => value + 1)} aria-label="Next week"><Icon name="chevron"/></button></div>}>
            <div className="schedule-grid"><div className="schedule-label"/><>{model.days.map((day) => <div className="schedule-day" key={day}><strong>{formatDate(day)}</strong><small>{day === singaporeDate() ? 'Today' : ''}</small></div>)}</>
              {state.data.bays.map((bay) => <ScheduleRow key={bay.bay_id} bay={bay} days={model.days} bookings={state.data.bookings} onEdit={editBooking}/>)}</div>
          </Card>

          <Card title="Maintenance priority queue" className="maintenance-priority-card-wrap" action={<select className="priority-filter" aria-label="Filter maintenance priority queue" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
            <option value="all">All priorities ({model.queue.length})</option>
            <option value="today">Due today ({queueCounts.today})</option>
            <option value="week">Due within 7 days ({queueCounts.week})</option>
            <option value="fault">Fault repair ({queueCounts.fault})</option>
          </select>}>
            <div className="maintenance-priority-grid">{visibleQueue.map((item, index) => {
              const decisionStatus = queueStatus(item)
              return <article className="maintenance-priority-item" key={item.fault?.id || item.lrv_id}>
                <span className={`queue-rank ${decisionStatus === 'overdue' ? 'urgent' : ''}`}>{index + 1}</span>
                <div className="maintenance-priority-main"><strong>{vehicleLabel(item.lrv_id)} · {item.work_type === 'corrective' ? 'Corrective repair' : cycleLabel(item.cycle_type)}</strong><small>{queueDecisionLabel(item)}</small></div>
                <button className={`priority-add ${item.booking ? 'priority-booked' : ''} ${item.work_type === 'corrective' ? 'priority-fault' : ''}`} onClick={() => suggest(item)} aria-label={item.booking ? `Open the existing ${vehicleLabel(item.lrv_id)} booking` : `Find a collision-free slot for ${vehicleLabel(item.lrv_id)}`} title={item.booking ? 'Open existing booking' : 'Find the first compatible free slot'}><Icon name={item.booking ? 'check' : 'plus'}/></button>
                <div className="maintenance-priority-meta"><Badge value={decisionStatus}/><b>{queuePlanningDetail(item, state.data.rules)}</b></div>
              </article>
            })}{visibleQueue.length === 0 && <div className="empty-copy">No vehicles match this priority filter.</div>}</div>
          </Card>
        </div>

        {editing && <div className="modal-backdrop" onMouseDown={() => setEditing(false)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><h2>{form.bookingId ? 'Adjust booking' : 'Create maintenance booking'}</h2><button onClick={() => setEditing(false)}>×</button></div>
          <form onSubmit={submit} className="form-grid">
            <label>Work type<select value={form.workType} disabled={Boolean(form.bookingId)} onChange={(e) => { const workType = e.target.value; const fault = workType === 'corrective' ? state.data.faults.find((item) => item.status === 'open') : null; setForm({ ...emptyForm, workType, lrvId: fault?.lrv_id || '', faultId: fault?.id || '', durationMinutes: Number(fault?.estimated_duration_minutes || 240), notes: fault ? `${fault.fault_code}: ${fault.description}` : '' }) }}><option value="preventive">Preventive mileage work</option><option value="corrective">Corrective fault repair</option></select></label>
            <label>Vehicle<select value={form.lrvId} required disabled={form.workType === 'corrective'} onChange={(e) => setForm({ ...form, lrvId: e.target.value })}><option value="">Select LRV</option>{state.data.vehicles.filter((vehicle) => form.workType !== 'corrective' || vehicle.status === 'faulty').map((vehicle) => <option key={vehicle.lrv_id} value={vehicle.lrv_id}>{vehicleLabel(vehicle.lrv_id)}</option>)}</select></label>
            {form.workType === 'corrective' ? <>
              <label>Fault record<select value={form.faultId} required onChange={(e) => { const fault = state.data.faults.find((item) => item.id === e.target.value); setForm({ ...form, faultId: fault?.id || '', lrvId: fault?.lrv_id || '', durationMinutes: Number(fault?.estimated_duration_minutes || 240), notes: fault ? `${fault.fault_code}: ${fault.description}` : '' }) }}><option value="">Select open fault</option>{state.data.faults.filter((fault) => ['open', 'scheduled'].includes(fault.status)).map((fault) => <option key={fault.id} value={fault.id}>{vehicleLabel(fault.lrv_id)} · {fault.fault_code}</option>)}</select></label>
              <label>Estimated bay time (hours)<input type="number" min="0.5" step="0.5" value={Number(form.durationMinutes) / 60} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) * 60 })}/></label>
            </> : <label>Primary cycle<select value={form.primaryCycle} onChange={(e) => { const primaryCycle = Number(e.target.value); const rule = state.data.rules.find((candidate) => Number(candidate.cycle_type) === primaryCycle); setForm({ ...form, primaryCycle, bundledCycles: rule?.included_cycles?.map(Number) || [primaryCycle], durationMinutes: Number(rule?.duration_minutes || 120) }) }}>{state.data.rules.map((rule) => <option key={rule.cycle_type} value={rule.cycle_type}>{cycleLabel(rule.cycle_type)}</option>)}</select></label>}
            <label>Depot bay<select value={form.bayId} required onChange={(e) => setForm({ ...form, bayId: e.target.value })}><option value="">Select compatible bay</option>{state.data.bays.filter((bay) => bay.active && (!selectedRule || isCompatibleBay(selectedRule, bay))).map((bay) => <option key={bay.bay_id} value={bay.bay_id}>{bay.name}</option>)}</select></label>
            <label>Status<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="proposed">Proposed</option><option value="confirmed">Confirmed</option></select></label>
            <label>Date<input type="date" value={form.date} min={singaporeDate()} required onChange={(e) => setForm({ ...form, date: e.target.value })}/></label>
            <label>Start time<input type="time" value={form.time} required onChange={(e) => setForm({ ...form, time: e.target.value })}/></label>
            {form.workType === 'preventive' && <fieldset className="form-span"><legend>Standard package scope</legend><div className="cycle-checks">{form.bundledCycles.map((cycle) => <label key={cycle}><input type="checkbox" checked readOnly/>{cycleLabel(cycle)}</label>)}</div><small>The technician records the cycles actually completed when closing the visit.</small></fieldset>}
            <div className="form-span scope-summary"><strong>Expected continuous occupancy</strong><span>{formatDuration(form.workType === 'corrective' ? form.durationMinutes : selectedRule?.duration_minutes)}{form.workType === 'corrective' ? ` · ${selectedFault?.severity || 'fault'} priority · ${selectedFault?.required_bay_type || 'compatible'} bay` : ' · return at the same time of day for multi-day packages'}</span></div>
            <label className="form-span">Planning note<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}/></label>
            <div className="modal-actions form-span">{form.bookingId && <button type="button" className="button button-secondary" disabled={saving} onClick={cancelBooking}>Cancel booking</button>}{form.bookingId && form.status === 'confirmed' && <button type="button" className="button button-secondary" disabled={saving} onClick={() => { const booking = state.data.bookings.find((item) => item.id === form.bookingId); if (booking) { setEditing(false); beginCompletion(booking) } }}>Record completed work</button>}<button type="button" className="button button-secondary" onClick={() => setEditing(false)}>Close</button><button className="button button-primary" disabled={saving}>{saving ? 'Checking capacity…' : 'Save booking'}</button></div>
          </form></div></div>}

        {completion && <div className="modal-backdrop" onMouseDown={() => setCompletion(null)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-header"><h2>{vehicleLabel(completion.booking.lrv_id)} · {bookingWorkLabel(completion.booking)} visit</h2><button onClick={() => setCompletion(null)}>×</button></div>
          <form onSubmit={submitCompletion} className="form-grid">
            <label>Definite hubometer reading (km)<input type="number" min="0" step="0.1" required value={completion.mileageKm} onChange={(event) => setCompletion({ ...completion, mileageKm: event.target.value })}/></label>
            <label>Technician ID<input required value={completion.technicianId} onChange={(event) => setCompletion({ ...completion, technicianId: event.target.value })}/></label>
            {completion.booking.work_type !== 'corrective' && <fieldset className="form-span"><legend>Cycles actually completed</legend><div className="cycle-checks">{completion.booking.bundled_cycles.map(Number).map((cycle) => <label key={cycle}><input type="checkbox" checked={completion.completedCycles.includes(cycle)} onChange={(event) => setCompletion({ ...completion, completedCycles: event.target.checked ? [...completion.completedCycles, cycle].sort((a, b) => a - b) : completion.completedCycles.filter((item) => item !== cycle) })}/>{cycleLabel(cycle)}</label>)}</div><small>Only selected cycles will reset. A reduced scope requires an explanation.</small></fieldset>}
            <label className="form-span">Completion note<textarea required={completion.booking.work_type === 'corrective'} value={completion.notes} placeholder={completion.booking.work_type === 'corrective' ? 'Repair performed and verification result' : 'Required when planned work was not completed'} onChange={(event) => setCompletion({ ...completion, notes: event.target.value })}/></label>
            <div className="modal-actions form-span"><button type="button" className="button button-secondary" onClick={() => setCompletion(null)}>Close</button><button className="button button-primary" disabled={saving}>{saving ? 'Recording…' : 'Record actual work'}</button></div>
          </form></div></div>}
      </>}
    </DataBoundary>
    <Toast message={toast?.message} tone={toast?.tone} onClose={() => setToast(null)}/>
  </>
}

function buildMaintenanceModel(data, weekOffset = 0) {
  if (!data) return null
  const vehicles = new Map(data.vehicles.map((vehicle) => [vehicle.lrv_id, vehicle]))
  const activeBookings = data.bookings.filter((booking) => ['proposed', 'confirmed'].includes(booking.status))
  const bookings = new Map(activeBookings.map((booking) => [booking.lrv_id, booking]))
  const faultBookings = new Map(activeBookings.filter((booking) => booking.fault_id).map((booking) => [booking.fault_id, booking]))
  const nearest = new Map()
  data.forecasts.forEach((item) => {
    const current = nearest.get(item.lrv_id)
    const status = vehicles.get(item.lrv_id)?.status
    const candidate = { ...item, work_type: 'preventive', status, booking: bookings.get(item.lrv_id) }
    if (!current || compareMaintenancePriority(candidate, current) < 0) nearest.set(item.lrv_id, candidate)
  })
  const preventive = [...nearest.values()].filter((item) =>
    !['maintenance', 'faulty'].includes(item.status)
    && (Number(item.km_to_next) <= 0 || item.forecast_days !== null && item.forecast_days !== undefined)
  )
  const corrective = (data.faults || []).filter((fault) => ['open', 'scheduled'].includes(fault.status)).map((fault) => ({
    lrv_id: fault.lrv_id, work_type: 'corrective', status: vehicles.get(fault.lrv_id)?.status || 'faulty',
    fault, booking: faultBookings.get(fault.id),
  }))
  const queue = [...corrective, ...preventive].sort(compareMaintenancePriority).slice(0, 12)
  const weekStartOffset = weekOffset * 7
  return {
    queue, overdue: queue.filter((row) => row.status !== 'faulty' && Number(row.km_to_next) < 0).length,
    dueSoon: queue.filter((row) => row.status !== 'faulty' && row.forecast_days !== null && Number(row.forecast_days) >= 0 && Number(row.forecast_days) <= 7).length,
    confirmed: data.bookings.filter((row) => row.status === 'confirmed' && dayOffset(row.start_at) >= weekStartOffset && dayOffset(row.start_at) < weekStartOffset + 7).length,
    days: Array.from({ length: 7 }, (_, index) => singaporeDate(weekStartOffset + index)),
  }
}

function dayOffset(value) {
  const bookingDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(value))
  return Math.round((new Date(`${bookingDate}T00:00:00+08:00`) - new Date(`${singaporeDate()}T00:00:00+08:00`)) / 86400000)
}

function ScheduleRow({ bay, days, bookings, onEdit }) {
  const layout = layoutScheduleBookings(bookings, bay.bay_id, days)
  const lanes = Math.max(1, ...layout.map((item) => item.lane + 1))
  const rowHeight = Math.max(205, lanes * 82 + 16)
  return <><div className="schedule-label" style={{ height: rowHeight }}><strong>{bay.name}</strong><small>{bay.opens_at.slice(0, 5)}–{bay.closes_at.slice(0, 5)}</small></div><div className="schedule-track" style={{ height: rowHeight }}>
    {layout.map(({ booking, startDay, endDay, lane, continuesBefore, continuesAfter }) => {
      const left = (startDay / days.length) * 100
      const width = ((endDay - startDay) / days.length) * 100
      return <div className={`schedule-booking booking-${booking.status}`} key={booking.id} style={{ left: `calc(${left}% + 4px)`, width: `calc(${width}% - 8px)`, top: 8 + lane * 82 }}>
        <button disabled={!['proposed', 'confirmed'].includes(booking.status)} onClick={() => onEdit(booking)}>
          <span className="booking-copy"><strong>{vehicleLabel(booking.lrv_id)} · {bookingWorkLabel(booking)}</strong><small>{bookingRangeLabel(booking, continuesBefore, continuesAfter)}</small></span>
          <Badge value={booking.status}/>
        </button>
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

function queueDecisionLabel(item) {
  if (item.work_type === 'corrective') return `${item.fault.description} · reported ${formatDateTime(item.fault.reported_at)}`
  if (Number(item.km_to_next) < 0) return 'Overdue'
  if (Number(item.km_to_next) === 0) return 'Due today'
  if (Number(item.forecast_days) === 0) return 'Due today'
  if (Number(item.forecast_days) === 1) return 'Due tomorrow'
  return `Due in ${item.forecast_days} days`
}

function queueStatus(item) {
  if (item.work_type === 'corrective') return 'faulty'
  if (Number(item.km_to_next) < 0) return 'overdue'
  if (Number(item.km_to_next) === 0 || Number(item.forecast_days) <= 0) return 'maintenance_due'
  return 'due_soon'
}

function queuePlanningDetail(item, rules) {
  if (item.work_type === 'corrective') return `${item.fault.severity} · ${formatDuration(item.fault.estimated_duration_minutes)}`
  const km = Number(item.km_to_next)
  const duration = rules.find((rule) => Number(rule.cycle_type) === Number(item.cycle_type))?.duration_minutes
  if (km < 0) return `${formatKm(Math.abs(km))} overdue · ${formatDuration(duration)}`
  if (km === 0) return `Due now · ${formatDuration(duration)}`
  return `${formatKm(km)} remaining · ${formatDuration(duration)}`
}

function bookingWorkLabel(booking) {
  return booking.work_type === 'corrective' ? 'Corrective repair' : cycleLabel(booking.primary_cycle)
}

function findBookingConflict(bookings, bayId, lrvId, start, end, bookingId) {
  const active = bookings.filter((booking) => ['proposed', 'confirmed'].includes(booking.status) && booking.id !== bookingId)
  const bay = active.find((booking) => booking.bay_id === bayId && new Date(booking.start_at) < end && new Date(booking.end_at) > start)
  if (bay) return `${bayId} is already occupied by ${vehicleLabel(bay.lrv_id)} during this period.`
  const vehicle = active.find((booking) => booking.lrv_id === lrvId && new Date(booking.start_at) < end && new Date(booking.end_at) > start)
  if (vehicle) return `${vehicleLabel(lrvId)} already has a depot booking during this period.`
  return null
}

function findAvailableSlot(rule, bays, bookings, duties, lrvId, preferredOffset) {
  if (!rule) return null
  const durationMs = Number(rule.duration_minutes || 90) * 60000
  const eligibleBays = bays.filter((bay) => bay.active && isCompatibleBay(rule, bay))
  const occupied = bookings.filter((booking) => ['proposed', 'confirmed'].includes(booking.status))
  const now = new Date()
  for (let offset = preferredOffset; offset <= preferredOffset + 42; offset += 1) {
    const date = singaporeDate(offset)
    for (const bay of eligibleBays) {
      const openMinutes = timeToMinutes(bay.opens_at)
      const closeMinutes = timeToMinutes(bay.closes_at)
      for (let minute = openMinutes; minute <= closeMinutes; minute += 30) {
        const start = new Date(`${date}T${minutesToTime(minute)}:00+08:00`)
        const end = new Date(start.getTime() + durationMs)
        const endTime = Number(formatTime(end).replace(':', ''))
        const openTime = Number(bay.opens_at.slice(0, 5).replace(':', ''))
        const closeTime = Number(bay.closes_at.slice(0, 5).replace(':', ''))
        if (start < now || endTime < openTime || endTime > closeTime) continue
        const bayOverlap = occupied.some((booking) => booking.bay_id === bay.bay_id && new Date(booking.start_at) < end && new Date(booking.end_at) > start)
        const vehicleOverlap = occupied.some((booking) => booking.lrv_id === lrvId && new Date(booking.start_at) < end && new Date(booking.end_at) > start)
        const dutyOverlap = (duties || []).some((duty) => duty.lrv_id === lrvId && new Date(duty.duty_start) < end && new Date(duty.duty_end) > start)
        if (!bayOverlap && !vehicleOverlap && !dutyOverlap) return { bay, start, end }
      }
    }
  }
  return null
}

function isCompatibleBay(rule, bay) {
  if (rule.compatible_bay_type === 'heavy') return ['heavy', 'universal'].includes(bay.bay_type)
  return ['routine', 'universal', 'heavy'].includes(bay.bay_type)
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number)
  return hours * 60 + minutes
}

function minutesToTime(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

function singaporeDateFrom(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(value))
}
