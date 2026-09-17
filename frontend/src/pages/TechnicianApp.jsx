import { useEffect, useMemo, useRef, useState } from 'react'
import { loadTechnicianWork, readHubometerPhoto, submitHubometerReading } from '../lib/api'
import { cycleLabel, formatDate, formatKm, formatTime, forecastLabel, vehicleLabel } from '../lib/format'
import { useSupabaseData } from '../hooks/useSupabaseData'
import { Icon } from '../components/Icons'
import { requiresManualOcrReview } from '../lib/technician'

const subscriptions = [
  { table: 'maintenance_bookings' }, { table: 'maintenance_faults' },
  { table: 'mileage_anchors', event: 'INSERT' }, { table: 'segment_traversals', event: 'INSERT' },
]
const pageSize = 3

export function TechnicianApp({ navigate }) {
  const state = useSupabaseData(loadTechnicianWork, [], subscriptions)
  const jobs = useMemo(() => buildJobs(state.data), [state.data])
  const [selectedDay, setSelectedDay] = useState(singaporeDate())
  const dayJobs = useMemo(() => jobs.filter((job) => occursOnDay(job.booking, selectedDay)), [jobs, selectedDay])
  const [screen, setScreen] = useState('queue')
  const [selectedId, setSelectedId] = useState(null)
  const [page, setPage] = useState(0)
  const [completedCycles, setCompletedCycles] = useState([])
  const [completionNotes, setCompletionNotes] = useState('')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [ocr, setOcr] = useState(null)
  const [reading, setReading] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [technicianId, setTechnicianId] = useState('TECH-DEMO')
  const [completedLrvId, setCompletedLrvId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const selected = jobs.find((job) => job.booking.id === selectedId) || dayJobs[0]
  const pageCount = Math.max(1, Math.ceil(dayJobs.length / pageSize))
  const visibleJobs = dayJobs.slice(page * pageSize, page * pageSize + pageSize)
  const isPartialScope = selected?.workType === 'preventive' && completedCycles.length < selected.assignedCycles.length

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const openJob = (job) => {
    setSelectedId(job.booking.id)
    setCompletedCycles(job.assignedCycles)
    setCompletionNotes('')
    setScreen('detail')
    setError(null)
  }
  const changeDay = (amount) => {
    setSelectedDay((current) => shiftDay(current, amount))
    setPage(0); setSelectedId(null); setScreen('queue')
  }
  const goBack = () => {
    if (screen === 'queue') navigate('fleet')
    else if (screen === 'detail') setScreen('queue')
    else { setScreen('detail'); setError(null) }
  }
  const beginCapture = () => {
    if (selected.booking.status !== 'confirmed') return
    setFile(null); setOcr(null); setReading(''); setReviewed(false); setError(null); setScreen('capture')
  }
  const capture = async (event) => {
    const nextFile = event.target.files?.[0]
    if (!nextFile) return
    if (!nextFile.type.startsWith('image/')) { setError('Select or capture an image file.'); return }
    if (nextFile.size > 8 * 1024 * 1024) { setError('The photo must be smaller than 8 MB.'); return }
    if (preview) URL.revokeObjectURL(preview)
    setFile(nextFile); setPreview(URL.createObjectURL(nextFile)); setBusy(true); setError(null)
    try {
      const result = await readHubometerPhoto(nextFile, { lrvId: selected.lrvId, expectedKm: selected.deviceMileage })
      setOcr(result); setReading(Number(result.valueKm).toFixed(1)); setScreen('review')
    } catch (captureError) { setError(captureError.message) }
    finally { setBusy(false); event.target.value = '' }
  }
  const toggleCycle = (cycle) => setCompletedCycles((current) => current.includes(cycle)
    ? current.filter((value) => value !== cycle)
    : [...current, cycle].sort((a, b) => a - b))
  const submit = async () => {
    const value = Number(reading)
    const manualRequired = requiresManualOcrReview(ocr?.confidence)
    if (!Number.isFinite(value) || value < 0) { setError('Enter a valid non-negative mileage reading.'); return }
    if (manualRequired && !reviewed) { setError('Check the displayed digits against the photo before submitting.'); return }
    if (!technicianId.trim()) { setError('Technician ID is required.'); return }
    if (selected.workType === 'preventive' && completedCycles.length === 0) { setError('Select at least one completed maintenance cycle.'); return }
    if (isPartialScope && !completionNotes.trim()) { setError('Explain why part of the assigned maintenance scope was not completed.'); return }
    setBusy(true); setError(null)
    try {
      await submitHubometerReading({
        lrvId: selected.lrvId, bookingId: selected.booking.id, valueKm: value,
        ocrValueKm: Number(ocr.valueKm), completedCycles, completionNotes,
        technicianId: technicianId.trim(), confidence: ocr.confidence,
        reviewedManually: manualRequired ? reviewed : value !== Number(ocr.valueKm), file,
      })
      setCompletedLrvId(selected.lrvId); setScreen('success'); state.refresh(true)
    } catch (submitError) { setError(submitError.message) }
    finally { setBusy(false) }
  }
  const reset = () => {
    if (preview) URL.revokeObjectURL(preview)
    setPreview(null); setFile(null); setOcr(null); setReading(''); setReviewed(false); setCompletedLrvId(null); setError(null); setScreen('queue')
  }

  return <div className="technician-stage"><section className="technician-phone">
    <header className="technician-topbar"><button aria-label="Return to dashboard" onClick={() => navigate('fleet')}><Icon name="train"/></button><div><strong>Railtech</strong><span>Technician</span></div><b>Demo</b></header>
    <main className="technician-content">
      {state.loading && <TechState icon="refresh" title="Loading workshop plan" text="Checking expected maintenance arrivals…"/>}
      {state.error && <TechState icon="alert" title="Could not load jobs" text={state.error} action={<button className="tech-primary" onClick={() => state.refresh()}>Try again</button>}/>}
      {!state.loading && !state.error && screen !== 'success' && <div className="tech-screen-heading"><button className="tech-back" aria-label="Back" onClick={goBack}><Icon name="arrow"/></button><div><span>{headingEyebrow(screen)}</span><h1>{heading(screen)}</h1></div>{screen === 'queue' && <em>{dayJobs.length}</em>}</div>}

      {!state.loading && !state.error && screen === 'queue' && <>
        <div className="tech-day-nav"><button aria-label="Previous day" onClick={() => changeDay(-1)}><Icon name="arrow"/></button><div><strong>{formatDay(selectedDay)}</strong><small>{selectedDay === singaporeDate() ? 'Today' : 'Workshop bookings'}</small></div><button aria-label="Next day" onClick={() => changeDay(1)}><Icon name="chevron"/></button></div>
        <div className="tech-job-list">{visibleJobs.map((job) => <button key={job.booking.id} className="tech-job" onClick={() => openJob(job)}>
          <span className={`tech-job-icon ${job.workType === 'corrective' ? 'fault' : ''}`}><Icon name={job.workType === 'corrective' ? 'alert' : 'train'}/></span>
          <span className="tech-job-copy"><strong>{vehicleLabel(job.lrvId)} · {job.scope}</strong><small>{formatTime(job.booking.start_at)}–{formatTime(job.booking.end_at)} · {job.bayName}</small><small>{job.assignmentSummary}</small></span>
          <Icon name="chevron"/>
        </button>)}</div>
        {dayJobs.length === 0 && <TechState icon="check" title="No workshop arrivals" text="There are no proposed or confirmed depot visits for this day."/>}
        {dayJobs.length > pageSize && <div className="tech-pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="arrow"/></button><span>{page + 1} of {pageCount}</span><button disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}><Icon name="chevron"/></button></div>}
      </>}

      {!state.loading && !state.error && screen === 'detail' && selected && <>
        <div className="tech-vehicle-summary"><span><Icon name={selected.workType === 'corrective' ? 'alert' : 'train'} size={23}/></span><div><strong>{vehicleLabel(selected.lrvId)}</strong><small>{selected.scope}</small></div><b>{selected.bayName}</b></div>
        <div className="tech-bento">
          <div className="tech-bento-primary"><span>On-board device estimate</span><strong>{formatKm(selected.deviceMileage, 1)}</strong><small>Live mileage estimate</small></div>
          <div><span>Previous hubometer reading</span><strong>{formatKm(selected.lastPhysicalCheck, 1)}</strong><small>{selected.lastPhysicalCheckAt ? formatDate(selected.lastPhysicalCheckAt) : 'No previous check'}</small></div>
          <div><span>Appointment</span><strong>{formatTime(selected.booking.start_at)}</strong><small>{formatDate(selected.booking.start_at)} · {selected.bayName}</small></div>
          <div><span>Maintenance due</span><strong>{selected.scope}</strong><small>{selected.workType === 'corrective' ? 'Non-mileage repair' : forecastLabel(selected.forecastDays)}</small></div>
        </div>
        <div className={`tech-assignment ${selected.workType === 'corrective' ? 'fault' : ''}`}><strong>Work assignment</strong><p>{selected.description}</p>{selected.booking.notes && <small>Planner notes: {selected.booking.notes}</small>}</div>
        {selected.workType === 'preventive' && <div className="tech-cycle-checklist"><div><strong>Cycles actually completed</strong><small>Due scope is preselected</small></div><div>{selected.assignedCycles.map((cycle) => <label key={cycle}><input type="checkbox" checked={completedCycles.includes(cycle)} onChange={() => toggleCycle(cycle)}/><span>{cycleLabel(cycle)}</span></label>)}</div></div>}
        {isPartialScope && <label className="tech-completion-notes">Reason for reduced scope<input value={completionNotes} maxLength="500" placeholder="Required when assigned work was not completed" onChange={(event) => setCompletionNotes(event.target.value)}/></label>}
        <div className="tech-bottom-actions"><button className="tech-primary" disabled={selected.booking.status !== 'confirmed' || (selected.workType === 'preventive' && completedCycles.length === 0)} onClick={beginCapture}><Icon name="camera"/>Record hubometer reading</button><small>{selected.booking.status === 'confirmed' ? 'Confirming the reading completes this job and resets only the checked cycles.' : 'This booking will be available for completion after planning confirms it.'}</small></div>
      </>}

      {!state.loading && !state.error && screen === 'capture' && selected && <>
        <div className="tech-capture-vehicle"><strong>{vehicleLabel(selected.lrvId)}</strong><span>{selected.scope} · {selected.bayName}</span></div>
        <button className="tech-camera-target" disabled={busy} onClick={() => inputRef.current?.click()}><Icon name="camera" size={38}/><strong>{busy ? 'Reading photo…' : 'Capture hubometer'}</strong><span>Fill the frame with the digits and avoid glare.</span></button>
        <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={capture}/>
        <div className="tech-capture-tips"><strong>For a reliable reading</strong><span>• Keep all digits visible</span><span>• Hold the phone level</span><span>• Check the image is sharp</span></div>
        <div className="tech-bottom-actions"><button className="tech-secondary" disabled={busy} onClick={() => inputRef.current?.click()}><Icon name="camera"/>{busy ? 'Processing…' : 'Open camera'}</button></div>
      </>}

      {!state.loading && !state.error && screen === 'review' && selected && ocr && <>
        <div className="tech-review-top"><img src={preview} alt="Captured hubometer"/><div><span>{vehicleLabel(selected.lrvId)}</span><strong>{requiresManualOcrReview(ocr.confidence) ? 'Manual review required' : 'Reading detected'}</strong><small>OCR confidence {Math.round(Number(ocr.confidence) * 100)}%{ocr.mode === 'openai_vision' ? '' : ' · demo'}</small></div></div>
        <div className="tech-reading-comparison"><div><span>Detected reading</span><label><input inputMode="decimal" type="number" min="0" step="0.1" value={reading} onChange={(event) => { setReading(event.target.value); setReviewed(false) }}/><b>km</b></label></div><div><span>On-board device estimate</span><strong>{formatKm(selected.deviceMileage, 1)}</strong></div><div><span>Difference</span><strong className={Math.abs(Number(reading) - selected.deviceMileage) >= 50 ? 'danger' : ''}>{formatSignedKm(Number(reading) - selected.deviceMileage)}</strong></div></div>
        {requiresManualOcrReview(ocr.confidence)
          ? <label className="tech-review-required"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)}/><span><strong>Check every digit against the photo</strong>Low-confidence readings cannot be sent until manually verified.</span></label>
          : <div className="tech-confidence-ok"><Icon name="check"/><span><strong>High-confidence OCR result</strong>Edit the reading above if the displayed digits differ.</span></div>}
        <label className="tech-id-field">Technician ID<input value={technicianId} maxLength="40" onChange={(event) => setTechnicianId(event.target.value)}/></label>
        <div className="tech-bottom-actions tech-review-actions"><button className="tech-secondary" disabled={busy} onClick={beginCapture}>Retake</button><button className="tech-primary" disabled={busy || (requiresManualOcrReview(ocr.confidence) && !reviewed)} onClick={submit}>{busy ? 'Completing…' : 'Confirm and complete'}</button></div>
      </>}

      {!state.loading && !state.error && screen === 'success' && <TechState icon="check" title="Maintenance completed" text={`${vehicleLabel(completedLrvId)} has a new physical mileage anchor. The checked maintenance cycles and OCC views are now updated.`} action={<button className="tech-primary" onClick={reset}>Back to expected LRVs</button>}/>}
      {error && <div className="tech-error" role="alert"><Icon name="alert"/><span>{error}</span><button aria-label="Dismiss" onClick={() => setError(null)}>×</button></div>}
    </main>
  </section></div>
}

function buildJobs(data) {
  if (!data) return []
  const summaries = new Map(data.mileage.map((row) => [row.lrv_id, row]))
  const forecastsByVehicle = new Map()
  data.forecasts.forEach((row) => {
    const rows = forecastsByVehicle.get(row.lrv_id) || []
    rows.push(row); forecastsByVehicle.set(row.lrv_id, rows)
  })
  const faults = new Map(data.faults.map((row) => [row.id, row]))
  return data.bookings.map((booking) => {
    const summary = summaries.get(booking.lrv_id) || {}
    const assignedCycles = (booking.bundled_cycles || []).map(Number).sort((a, b) => a - b)
    const vehicleForecasts = forecastsByVehicle.get(booking.lrv_id) || []
    const forecast = vehicleForecasts.find((row) => Number(row.cycle_type) === Number(booking.primary_cycle))
      || vehicleForecasts.sort((a, b) => Number(b.priority_score) - Number(a.priority_score))[0]
    const workType = booking.work_type || 'preventive'
    const fault = booking.fault_id ? faults.get(booking.fault_id) : null
    const scope = workType === 'corrective' ? 'Corrective repair' : `${cycleLabel(booking.primary_cycle)} maintenance`
    return {
      booking, lrvId: booking.lrv_id, workType, forecast, fault, scope, assignedCycles,
      forecastDays: forecast?.forecast_days,
      bayName: String(booking.bay_id || '').replace('SPLRT-BAY-', 'Bay '),
      deviceMileage: Number(summary.device_odo_km || 0),
      lastPhysicalCheck: Number(summary.last_physical_check_km || 0),
      lastPhysicalCheckAt: summary.last_physical_check_at,
      description: maintenanceDescription(workType, booking.primary_cycle, fault),
      assignmentSummary: workType === 'corrective' ? (fault?.description || 'Fault diagnosis and repair') : `${forecastLabel(forecast?.forecast_days)} · ${assignedCycles.map(cycleLabel).join(' + ')}`,
    }
  }).sort((a, b) => new Date(a.booking.start_at) - new Date(b.booking.start_at))
}

function maintenanceDescription(workType, primaryCycle, fault) {
  if (workType === 'corrective') return fault?.description || 'Diagnose the reported fault and complete the assigned corrective repair.'
  return {
    2000: 'Routine safety inspection, consumables and functional checks.',
    13000: 'Expanded inspection including the complete 2K service scope.',
    40000: 'Heavy maintenance including the complete 2K and 13K service scope.',
    120000: 'Major maintenance including the 2K, 13K and 40K service scope.',
    360000: 'Full overhaul package covering every preventive maintenance cycle.',
  }[Number(primaryCycle)] || 'Complete the preventive maintenance scope assigned by planning.'
}

function occursOnDay(booking, day) {
  const start = new Date(`${day}T00:00:00+08:00`)
  const end = new Date(start.getTime() + 86400000)
  return new Date(booking.start_at) < end && new Date(booking.end_at) > start
}
function singaporeDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date())
}
function shiftDay(day, amount) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10)
}
function formatDay(day) {
  return new Intl.DateTimeFormat('en-SG', { day: 'numeric', month: 'short', weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
}
function heading(screen) {
  return { queue: 'Expected maintenance', detail: 'LRV work summary', capture: 'Capture hubometer', review: 'Review reading' }[screen]
}
function headingEyebrow(screen) {
  return { queue: 'Workshop arrivals', detail: 'Complete workshop job', capture: 'Physical mileage', review: 'OCR validation' }[screen]
}
function formatSignedKm(value) {
  if (!Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('en-SG', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`
}
function TechState({ icon, title, text, action }) {
  return <div className="tech-state"><span><Icon name={icon} size={32}/></span><h1>{title}</h1><p>{text}</p>{action}</div>
}
