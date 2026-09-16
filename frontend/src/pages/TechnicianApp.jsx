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
  const [screen, setScreen] = useState('queue')
  const [selectedId, setSelectedId] = useState(null)
  const [page, setPage] = useState(0)
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [ocr, setOcr] = useState(null)
  const [reading, setReading] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [technicianId, setTechnicianId] = useState('TECH-DEMO')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const selected = jobs.find((job) => job.booking.id === selectedId) || jobs[0]
  const pageCount = Math.max(1, Math.ceil(jobs.length / pageSize))
  const visibleJobs = jobs.slice(page * pageSize, page * pageSize + pageSize)

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const openJob = (job) => { setSelectedId(job.booking.id); setScreen('detail'); setError(null) }
  const goBack = () => {
    if (screen === 'queue') navigate('fleet')
    else if (screen === 'detail') setScreen('queue')
    else { setScreen('detail'); setError(null) }
  }
  const beginCapture = () => {
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
      const result = await readHubometerPhoto(nextFile, { lrvId: selected.lrvId, expectedKm: selected.planningMileage })
      setOcr(result); setReading(Number(result.valueKm).toFixed(1)); setScreen('review')
    } catch (captureError) { setError(captureError.message) }
    finally { setBusy(false); event.target.value = '' }
  }
  const submit = async () => {
    const value = Number(reading)
    const manualRequired = requiresManualOcrReview(ocr?.confidence)
    if (!Number.isFinite(value) || value < 0) { setError('Enter a valid non-negative mileage reading.'); return }
    if (manualRequired && !reviewed) { setError('Check the displayed digits against the photo before submitting.'); return }
    if (!technicianId.trim()) { setError('Technician ID is required.'); return }
    setBusy(true); setError(null)
    try {
      await submitHubometerReading({
        lrvId: selected.lrvId, bookingId: selected.booking.id, valueKm: value,
        ocrValueKm: Number(ocr.valueKm),
        technicianId: technicianId.trim(), confidence: ocr.confidence,
        reviewedManually: manualRequired ? reviewed : value !== Number(ocr.valueKm), file,
      })
      setScreen('success'); state.refresh(true)
    } catch (submitError) { setError(submitError.message) }
    finally { setBusy(false) }
  }
  const reset = () => {
    if (preview) URL.revokeObjectURL(preview)
    setPreview(null); setFile(null); setOcr(null); setReading(''); setReviewed(false); setError(null); setScreen('queue')
  }

  return <div className="technician-stage"><section className="technician-phone">
    <header className="technician-topbar"><button aria-label="Return to dashboard" onClick={() => navigate('fleet')}><Icon name="train"/></button><div><strong>Railtech</strong><span>Technician</span></div><b>Demo</b></header>
    <main className="technician-content">
      {state.loading && <TechState icon="refresh" title="Loading workshop plan" text="Checking expected maintenance arrivals…"/>}
      {state.error && <TechState icon="alert" title="Could not load jobs" text={state.error} action={<button className="tech-primary" onClick={() => state.refresh()}>Try again</button>}/>}
      {!state.loading && !state.error && screen !== 'success' && <div className="tech-screen-heading"><button className="tech-back" aria-label="Back" onClick={goBack}><Icon name="arrow"/></button><div><span>{headingEyebrow(screen)}</span><h1>{heading(screen)}</h1></div>{screen === 'queue' && <em>{jobs.length}</em>}</div>}

      {!state.loading && !state.error && screen === 'queue' && <>
        <p className="tech-intro">Select the LRV you are receiving or working on.</p>
        <div className="tech-job-list">{visibleJobs.map((job) => <button key={job.booking.id} className="tech-job" onClick={() => openJob(job)}>
          <span className={`tech-job-icon ${job.workType === 'corrective' ? 'fault' : ''}`}><Icon name={job.workType === 'corrective' ? 'alert' : 'train'}/></span>
          <span className="tech-job-copy"><strong>{vehicleLabel(job.lrvId)} · {job.scope}</strong><small>{formatDate(job.booking.start_at)} · {formatTime(job.booking.start_at)} · {job.bayName}</small><small>{job.workType === 'corrective' ? job.fault?.description : forecastLabel(job.forecastDays)}</small></span>
          <span className={`tech-status ${job.booking.status}`}>{job.booking.status}</span><Icon name="chevron"/>
        </button>)}</div>
        {jobs.length === 0 && <TechState icon="check" title="No expected arrivals" text="There are no proposed or confirmed depot visits to action."/>}
        {jobs.length > pageSize && <div className="tech-pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="arrow"/></button><span>{page + 1} of {pageCount}</span><button disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}><Icon name="chevron"/></button></div>}
      </>}

      {!state.loading && !state.error && screen === 'detail' && selected && <>
        <div className="tech-vehicle-summary"><span><Icon name={selected.workType === 'corrective' ? 'alert' : 'train'} size={23}/></span><div><strong>{vehicleLabel(selected.lrvId)}</strong><small>{selected.scope} · {selected.booking.status}</small></div><b>{selected.bayName}</b></div>
        <div className="tech-visit"><div><span>Expected</span><strong>{formatDate(selected.booking.start_at)} · {formatTime(selected.booking.start_at)}</strong></div><div><span>Work scope</span><strong>{selected.scope}</strong></div></div>
        <div className="tech-metrics"><div><span>Planning mileage</span><strong>{formatKm(selected.planningMileage, 1)}</strong></div><div><span>Next mileage work</span><strong>{selected.workType === 'corrective' ? 'Fault repair' : `${cycleLabel(selected.forecast?.cycle_type)} · ${formatKm(selected.forecast?.km_to_next)}`}</strong></div><div><span>Device reading</span><strong>{formatKm(selected.deviceMileage, 1)}</strong></div><div><span>Last physical check</span><strong>{formatKm(selected.lastPhysicalCheck, 1)}</strong></div></div>
        {selected.workType === 'corrective' && <div className="tech-alert"><Icon name="alert"/><span><strong>{selected.fault?.fault_code}</strong>{selected.fault?.description}</span></div>}
        <div className="tech-bottom-actions"><button className="tech-primary" onClick={beginCapture}><Icon name="camera"/>Record hubometer reading</button><small>This records mileage evidence. It does not complete maintenance.</small></div>
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
        <div className="tech-reading-comparison"><div><span>Detected reading</span><label><input inputMode="decimal" type="number" min="0" step="0.1" value={reading} onChange={(event) => { setReading(event.target.value); setReviewed(false) }}/><b>km</b></label></div><div><span>System estimate</span><strong>{formatKm(selected.planningMileage, 1)}</strong></div><div><span>Difference</span><strong className={Math.abs(Number(reading) - selected.planningMileage) >= 50 ? 'danger' : ''}>{formatSignedKm(Number(reading) - selected.planningMileage)}</strong></div></div>
        {requiresManualOcrReview(ocr.confidence)
          ? <label className="tech-review-required"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)}/><span><strong>Check every digit against the photo</strong>Low-confidence readings cannot be sent until manually verified.</span></label>
          : <div className="tech-confidence-ok"><Icon name="check"/><span><strong>High-confidence OCR result</strong>Edit the reading above if the displayed digits differ.</span></div>}
        <label className="tech-id-field">Technician ID<input value={technicianId} maxLength="40" onChange={(event) => setTechnicianId(event.target.value)}/></label>
        <div className="tech-bottom-actions tech-review-actions"><button className="tech-secondary" disabled={busy} onClick={beginCapture}>Retake</button><button className="tech-primary" disabled={busy || (requiresManualOcrReview(ocr.confidence) && !reviewed)} onClick={submit}>{busy ? 'Sending…' : 'Confirm and send'}</button></div>
      </>}

      {!state.loading && !state.error && screen === 'success' && <TechState icon="check" title="Reading recorded" text={`${vehicleLabel(selected?.lrvId)} now has a new physical mileage anchor. OCC views will update automatically.`} action={<button className="tech-primary" onClick={reset}>Back to expected LRVs</button>}/>}
      {error && <div className="tech-error" role="alert"><Icon name="alert"/><span>{error}</span><button aria-label="Dismiss" onClick={() => setError(null)}>×</button></div>}
    </main>
  </section></div>
}

function buildJobs(data) {
  if (!data) return []
  const summaries = new Map(data.mileage.map((row) => [row.lrv_id, row]))
  const forecasts = new Map()
  data.forecasts.forEach((row) => {
    const current = forecasts.get(row.lrv_id)
    if (!current || Number(row.priority_score) > Number(current.priority_score)) forecasts.set(row.lrv_id, row)
  })
  const faults = new Map(data.faults.map((row) => [row.id, row]))
  return data.bookings.map((booking) => {
    const summary = summaries.get(booking.lrv_id) || {}
    const forecast = forecasts.get(booking.lrv_id)
    const workType = booking.work_type || 'preventive'
    return {
      booking, lrvId: booking.lrv_id, workType, forecast,
      forecastDays: forecast?.forecast_days,
      fault: booking.fault_id ? faults.get(booking.fault_id) : null,
      scope: workType === 'corrective' ? 'Corrective repair' : `${cycleLabel(booking.primary_cycle)} maintenance`,
      bayName: String(booking.bay_id || '').replace('SPLRT-BAY-', 'Bay '),
      planningMileage: Number(summary.lifetime_planning_mileage_km || summary.device_odo_km || 0),
      deviceMileage: Number(summary.device_odo_km || 0),
      lastPhysicalCheck: Number(summary.last_physical_check_km || 0),
    }
  }).sort((a, b) => new Date(a.booking.start_at) - new Date(b.booking.start_at))
}

function heading(screen) {
  return { queue: 'Expected maintenance', detail: 'LRV work summary', capture: 'Capture hubometer', review: 'Review reading' }[screen]
}
function headingEyebrow(screen) {
  return { queue: 'Workshop arrivals', detail: 'Before work starts', capture: 'Physical mileage', review: 'OCR validation' }[screen]
}
function formatSignedKm(value) {
  if (!Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('en-SG', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`
}
function TechState({ icon, title, text, action }) {
  return <div className="tech-state"><span><Icon name={icon} size={32}/></span><h1>{title}</h1><p>{text}</p>{action}</div>
}
