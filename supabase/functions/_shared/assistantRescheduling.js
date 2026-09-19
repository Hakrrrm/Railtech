// Pure rescheduling of existing work orders. Forecasts never redefine booked scope.
const MINUTE = 60000
const DAY = 86400000
const BUFFER = 30 * MINUTE
const fields = ['vehicleIds', 'bayIds', 'startDate', 'endDate', 'startTime']
export const rescheduleSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    vehicleIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
    bayIds: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Allowed destination bay IDs. Empty keeps each original bay.' },
    startDate: { type: ['string', 'null'], description: 'Requested Singapore start date YYYY-MM-DD. Null preserves each original booking date.' },
    endDate: { type: ['string', 'null'], description: 'Optional latest start date. Null uses startDate, or each original date when both are null.' },
    startTime: { type: ['string', 'null'], description: 'Explicit fixed Singapore start time HH:mm; null prefers each original time.' },
  }, required: fields,
}

export function buildReschedulePlan(data, input, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('A valid planning clock is required.')
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !fields.includes(key))) throw new Error('Unsupported rescheduling constraints.')
  const constraints = { bayIds: [], startDate: null, endDate: null, startTime: null, ...input }
  for (const field of ['vehicleIds', 'bayIds']) {
    if (!Array.isArray(constraints[field]) || constraints[field].length > (field === 'vehicleIds' ? 12 : 20)
      || constraints[field].some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new Error(`Invalid ${field}.`)
  }
  if (!constraints.vehicleIds.length) throw new Error('Select the LRVs to reschedule.')
  const today = dateOf(now.getTime()), last = addDays(today, 42)
  for (const field of ['startDate', 'endDate']) if (constraints[field] !== null && (!validDate(constraints[field]) || constraints[field] < today || constraints[field] > last)) throw new Error(`${field} must be today through 42 days ahead.`)
  if (constraints.endDate && !constraints.startDate) throw new Error('Specify a start date with an end date.')
  if (constraints.endDate && constraints.endDate < constraints.startDate) throw new Error('The end date cannot precede the start date.')
  if (constraints.startTime !== null && (typeof constraints.startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(constraints.startTime))) throw new Error('Use HH:mm for the requested start time.')
  if (constraints.bayIds.some((id) => !(data.bays || []).some((bay) => bay.bay_id === id))) throw new Error('The requested bay does not exist.')
  const selected = new Map(), skipped = [], warnings = []
  for (const id of new Set(constraints.vehicleIds)) {
    const matches = (data.vehicles || []).filter((vehicle) => [vehicle.lrv_id, displayId(vehicle.lrv_id)].some((value) => value.toUpperCase() === id.toUpperCase()))
    if (matches.length !== 1) throw new Error(`Unknown or ambiguous LRV identifier: ${id}`)
    const vehicle = matches[0]
    const sources = (data.bookings || []).filter((booking) => booking.lrv_id === vehicle.lrv_id && ['proposed', 'confirmed'].includes(booking.status))
    if (sources.length !== 1 || sources[0].status !== 'confirmed') { skipped.push({ lrvId: vehicle.lrv_id, reason: 'Select an LRV with exactly one confirmed unresolved booking.' }); continue }
    const source = sources[0]
    if (source.work_type === 'preventive' && vehicle.status === 'faulty') { skipped.push({ lrvId: vehicle.lrv_id, reason: 'This vehicle is faulty; review its repair status before moving a preventive booking.' }); continue }
    if (!Number.isFinite(Date.parse(source.start_at)) || Date.parse(source.start_at) <= now.getTime()) { skipped.push({ lrvId: vehicle.lrv_id, reason: 'Only bookings that have not started can be rescheduled.' }); continue }
    selected.set(vehicle.lrv_id, { vehicle, source })
  }
  if (skipped.length) return result([], skipped, warnings)
  const sourceIds = new Set([...selected.values()].map(({ source }) => source.id))
  const occupied = (data.bookings || []).filter((booking) => ['proposed', 'confirmed'].includes(booking.status) && !sourceIds.has(booking.id)).slice()
  const bookings = []
  // Earlier source starts first gives stable, predictable joint moves.
  for (const { vehicle, source } of [...selected.values()].sort((a, b) => Date.parse(a.source.start_at) - Date.parse(b.source.start_at) || a.vehicle.lrv_id.localeCompare(b.vehicle.lrv_id))) {
    const duration = (Date.parse(source.end_at) - Date.parse(source.start_at)) / MINUTE
    const rule = source.work_type === 'corrective'
      ? (data.faults || []).find((fault) => fault.id === source.fault_id && fault.lrv_id === vehicle.lrv_id && ['open', 'scheduled'].includes(fault.status))
      : (data.rules || []).find((item) => Number(item.cycle_type) === Number(source.primary_cycle) && (!item.fleet || item.fleet === vehicle.fleet))
    const required = source.work_type === 'corrective' ? rule?.required_bay_type : rule?.compatible_bay_type
    const minimumDuration = Number(source.work_type === 'corrective' ? rule?.estimated_duration_minutes : rule?.duration_minutes)
    const settings = Array.isArray(data.settings) ? data.settings.find((item) => item.fleet === vehicle.fleet) : data.settings
    if (!['preventive', 'corrective'].includes(source.work_type) || !Number.isInteger(duration) || duration <= 0 || duration > 43200
      || !Number.isInteger(minimumDuration) || minimumDuration <= 0 || duration < minimumDuration || !['routine', 'heavy', 'universal'].includes(required)
      || !settings || settings.fleet && settings.fleet !== vehicle.fleet || !Number.isInteger(settings.minimum_service_vehicles) || settings.minimum_service_vehicles < 0) {
      skipped.push({ lrvId: vehicle.lrv_id, reason: 'Booked duration, bay requirement or fleet service minimum is invalid.' }); break
    }
    const from = constraints.startDate || dateOf(Date.parse(source.start_at))
    const until = constraints.endDate || from
    if (from < today || until > last) { skipped.push({ lrvId: vehicle.lrv_id, reason: 'The original date is beyond 42 days; specify a nearer date.' }); break }
    const bays = (data.bays || []).filter((bay) => bay.active === true && (!bay.fleet || bay.fleet === vehicle.fleet)
      && (constraints.bayIds.length ? constraints.bayIds.includes(bay.bay_id) : bay.bay_id === source.bay_id)
      && (required === 'heavy' ? ['heavy', 'universal'].includes(bay.bay_type) : ['routine', 'heavy', 'universal'].includes(bay.bay_type)))
    const blockers = new Set()
    let slot
    for (let date = from; date <= until && !slot; date = addDays(date, 1)) {
      const candidates = []
      for (const bay of bays) {
        const open = minutes(bay.opens_at), close = minutes(bay.closes_at)
        if (!Number.isFinite(open) || !Number.isFinite(close) || open >= close) { blockers.add('bay opening hours'); continue }
        const preferred = constraints.startTime === null ? localMinute(Date.parse(source.start_at)) : minutes(constraints.startTime)
        const starts = constraints.startTime !== null ? [preferred] : [...new Set([preferred, ...Array.from({ length: Math.ceil((close - open) / 30) }, (_, index) => Math.ceil(open / 30) * 30 + index * 30).filter((minute) => minute >= preferred)])]
        for (const minute of starts) {
          const start = timestamp(date) + minute * MINUTE, end = start + duration * MINUTE
          if (start < now.getTime() || minute < open || minute >= close || localMinute(end) < open || localMinute(end) > close || duration < 1440 && minute + duration > close) { blockers.add('opening hours or elapsed times'); continue }
          if (duration < 1440 && minute < 780 && minute + duration > 720) { blockers.add('12:00–13:00 lunch'); continue }
          if (occupied.some((booking) => booking.bay_id === bay.bay_id && overlaps(start, end, Date.parse(booking.start_at) - BUFFER, Date.parse(booking.end_at) + BUFFER))) { blockers.add('bay occupancy and 30-minute turnaround'); continue }
          if (occupied.some((booking) => booking.lrv_id === vehicle.lrv_id && overlaps(start, end, Date.parse(booking.start_at), Date.parse(booking.end_at)))) { blockers.add('vehicle booking'); continue }
          if ((data.duties || []).some((duty) => duty.lrv_id === vehicle.lrv_id && ['planned', 'active'].includes(duty.status) && overlaps(start, end, Date.parse(duty.duty_start), Date.parse(duty.duty_end)))) { blockers.add('operating duties'); continue }
          if (!preservesMinimum(data, vehicle, settings.minimum_service_vehicles, occupied, start, end)) { blockers.add('fleet service minimum'); continue }
          candidates.push({ bay, start, end, deviation: Math.abs(minute - preferred) })
          break
        }
      }
      slot = candidates.sort((a, b) => a.deviation - b.deviation || a.start - b.start || a.bay.bay_id.localeCompare(b.bay.bay_id))[0]
    }
    if (!slot) { skipped.push({ lrvId: vehicle.lrv_id, reason: bays.length ? `No feasible slot on the requested dates: ${[...blockers].join('; ')}.` : 'No compatible active destination bay.' }); break }
    const proposal = { bookingId: source.id, lrvId: vehicle.lrv_id, workType: source.work_type,
      primaryCycle: source.primary_cycle ?? null, bundledCycles: [...(source.bundled_cycles || [])], faultId: source.fault_id ?? null,
      bayId: slot.bay.bay_id, startAt: new Date(slot.start).toISOString(), endAt: new Date(slot.end).toISOString(), notes: source.notes ?? null,
      original: { id: source.id, bayId: source.bay_id, startAt: source.start_at, endAt: source.end_at, updatedAt: source.updated_at ?? null } }
    if (proposal.bayId === source.bay_id && slot.start === Date.parse(source.start_at)) {
      skipped.push({ lrvId: vehicle.lrv_id, reason: 'The requested slot is unchanged; specify a different date, time or bay.' }); break
    }
    bookings.push(proposal)
    occupied.push({ lrv_id: vehicle.lrv_id, bay_id: proposal.bayId, start_at: proposal.startAt, end_at: proposal.endAt, status: 'proposed' })
    if (localMinute(slot.start) !== localMinute(Date.parse(source.start_at))) warnings.push(`${displayId(vehicle.lrv_id)} starts at ${localTime(slot.start)} SGT instead of ${localTime(Date.parse(source.start_at))} SGT.`)
    const due = (data.forecasts || []).filter((forecast) => forecast.lrv_id === vehicle.lrv_id && validDate(forecast.forecast_date)).map((forecast) => forecast.forecast_date).sort()[0]
    if (due && dateOf(slot.start) > due) warnings.push(`${displayId(vehicle.lrv_id)} starts after its forecast due date ${due}.`)
    if (duration >= 1440) warnings.push(`${displayId(vehicle.lrv_id)} retains its continuous ${duration / 1440}-day bay reservation, including nights and lunch.`)
    if (dateOf(slot.end) > until) warnings.push(`${displayId(vehicle.lrv_id)} finishes after the start-date window on ${dateOf(slot.end)}.`)
  }
  // A partial move might occupy the retained source of an unsuccessful move.
  // Return no proposal unless the entire requested group can move together.
  if (skipped.length) return result([], skipped, ['No bookings moved; the complete selection must have feasible slots.'])
  return result(bookings, skipped, warnings)
}
function result(bookings, skipped, warnings) { return { kind: 'reschedule', bookings, skipped, warnings, summary: `${bookings.length} booking move${bookings.length === 1 ? '' : 's'} proposed. ${bookings.length ? 'Existing slots remain confirmed until you confirm the changes.' : 'No changes proposed.'}` } }
function preservesMinimum(data, vehicle, minimum, occupied, start, end) {
  const serviceable = new Set((data.vehicles || []).filter((item) => item.fleet === vehicle.fleet && item.status === 'in_service').map((item) => item.lrv_id))
  const relevant = occupied.filter((item) => serviceable.has(item.lrv_id) && overlaps(start, end, Date.parse(item.start_at), Date.parse(item.end_at)))
  return [start, ...relevant.map((item) => Date.parse(item.start_at)).filter((time) => time >= start && time < end)].every((time) => {
    const unavailable = new Set(relevant.filter((item) => Date.parse(item.start_at) <= time && Date.parse(item.end_at) > time).map((item) => item.lrv_id))
    if (serviceable.has(vehicle.lrv_id)) unavailable.add(vehicle.lrv_id)
    return serviceable.size - unavailable.size >= minimum
  })
}
function displayId(id) { return id.replace(/^D(?=\d+$)/, 'V') }
function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value }
function dateOf(time) { return new Date(time + 8 * 60 * MINUTE).toISOString().slice(0, 10) }
function timestamp(date) { return Date.parse(`${date}T00:00:00+08:00`) }
function addDays(date, days) { return dateOf(timestamp(date) + days * DAY) }
function localMinute(time) { return ((time + 8 * 60 * MINUTE) % DAY) / MINUTE }
function localTime(time) { return new Date(time + 8 * 60 * MINUTE).toISOString().slice(11, 16) }
function minutes(time) { if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time)) return NaN; const [hour, minute] = time.split(':').map(Number); return hour * 60 + minute }
function overlaps(a, b, c, d) { return a < d && b > c }
