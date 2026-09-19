import { supabase, supabaseConfigError } from '../supabaseClient'

function client() {
  if (!supabase) throw new Error(supabaseConfigError)
  return supabase
}

async function result(query, label) {
  const { data, error } = await query
  if (error) throw new Error(`${label}: ${error.message}`)
  return data || []
}

export async function loadFleetOverview() {
  const db = client()
  const [vehicles, mileage, forecasts, bookings, settings, faults] = await Promise.all([
    result(db.from('vehicles').select('*').order('lrv_id'), 'Vehicles'),
    result(db.from('vehicle_mileage_summary').select('*').order('lrv_id'), 'Mileage summary'),
    result(db.from('cycle_forecasts').select('*').order('priority_score', { ascending: false }), 'Cycle forecasts'),
    result(db.from('maintenance_bookings').select('*').in('status', ['proposed', 'confirmed']).order('start_at'), 'Bookings'),
    result(db.from('planning_settings').select('*').eq('fleet', 'splrt').limit(1), 'Planning settings'),
    result(db.from('maintenance_faults').select('*').in('status', ['open', 'scheduled']).order('reported_at'), 'Maintenance faults'),
  ])
  return { vehicles, mileage, forecasts, bookings, settings: settings[0] || null, faults }
}

export async function loadVehicleDetail(lrvId) {
  const db = client()
  const [summary, forecasts, traversals, anchors, events, bookings, rules, observations] = await Promise.all([
    result(db.from('vehicle_mileage_summary').select('*').eq('lrv_id', lrvId).limit(1), 'Vehicle summary'),
    result(db.from('cycle_forecasts').select('*').eq('lrv_id', lrvId).order('cycle_type'), 'Maintenance cycles'),
    result(db.from('segment_traversals').select('*').eq('lrv_id', lrvId).order('ts', { ascending: false }).limit(5000), 'Segment activity'),
    result(db.from('mileage_anchors').select('*').eq('lrv_id', lrvId).order('ts', { ascending: false }).limit(30), 'Mileage evidence'),
    result(db.from('maintenance_events').select('*').eq('lrv_id', lrvId).order('completed_at', { ascending: false }).limit(30), 'Maintenance log'),
    result(db.from('maintenance_bookings').select('*').eq('lrv_id', lrvId).order('start_at'), 'Depot visits'),
    result(db.from('maintenance_cycle_rules').select('*').eq('fleet', 'splrt').order('cycle_type'), 'Maintenance rules'),
    result(db.from('technician_observations').select('maintenance_event_id,image_uri').eq('lrv_id', lrvId).order('captured_at'), 'Maintenance photos'),
  ])
  const photos = new Map(observations.map(row => [row.maintenance_event_id, row.image_uri]))
  return { summary: summary[0] || null, forecasts, traversals, anchors, events: events.map(event => ({ ...event, imageUri: photos.get(event.id) || null })), bookings, rules }
}

export async function loadMaintenancePlanning() {
  const db = client()
  const [vehicles, mileage, forecasts, bookings, bays, rules, settings, duties, faults] = await Promise.all([
    result(db.from('vehicles').select('*').order('lrv_id'), 'Vehicles'),
    result(db.from('vehicle_mileage_summary').select('lrv_id,lifetime_planning_mileage_km,device_odo_km').order('lrv_id'), 'Mileage summary'),
    result(db.from('cycle_forecasts').select('*').order('priority_score', { ascending: false }), 'Recall forecasts'),
    result(db.from('maintenance_bookings').select('*').order('start_at'), 'Depot bookings'),
    result(db.from('depot_bays').select('*').order('bay_id'), 'Depot bays'),
    result(db.from('maintenance_cycle_rules').select('*').eq('fleet', 'splrt').order('cycle_type'), 'Maintenance rules'),
    result(db.from('planning_settings').select('*').eq('fleet', 'splrt').limit(1), 'Planning settings'),
    result(db.from('duty_assignments').select('*').in('status', ['planned', 'active']).order('duty_start'), 'Duty assignments'),
    result(db.from('maintenance_faults').select('*').in('status', ['open', 'scheduled']).order('reported_at'), 'Maintenance faults'),
  ])
  return { vehicles, mileage, forecasts, bookings, bays, rules, settings: settings[0] || null, duties, faults }
}

export async function loadDeploymentPlanning() {
  const db = client()
  const [vehicles, assignments, eligibility, changes, bookings] = await Promise.all([
    result(db.from('vehicles').select('*').order('lrv_id'), 'Vehicles'),
    result(db.from('duty_assignments').select('*').order('duty_start'), 'Duty assignments'),
    result(db.from('deployment_eligibility').select('*').order('available_duty_margin_km', { ascending: false }), 'Deployment eligibility'),
    result(db.from('stock_changes').select('*').order('created_at', { ascending: false }), 'Stock changes'),
    result(db.from('maintenance_bookings').select('*').in('status', ['proposed', 'confirmed']).order('start_at'), 'Bookings'),
  ])
  return { vehicles, assignments, eligibility, changes, bookings }
}

export async function loadEvidence() {
  const db = client()
  const [vehicles, events] = await Promise.all([
    result(db.from('vehicle_mileage_summary').select('*').order('lrv_id'), 'LRV database'),
    result(db.from('maintenance_events').select('*').order('completed_at', { ascending: false }), 'Maintenance history'),
  ])
  return { vehicles, events }
}

export async function loadSettings() {
  const db = client()
  const [settings, rules, bays] = await Promise.all([
    result(db.from('planning_settings').select('*').eq('fleet', 'splrt').limit(1), 'Planning settings'),
    result(db.from('maintenance_cycle_rules').select('*').eq('fleet', 'splrt').order('cycle_type'), 'Cycle rules'),
    result(db.from('depot_bays').select('*').eq('fleet', 'splrt').order('bay_id'), 'Depot bays'),
  ])
  return { settings: settings[0] || null, rules, bays }
}

export async function loadTechnicianWork() {
  const db = client()
  const [bookings, mileage, forecasts, faults] = await Promise.all([
    result(db.from('maintenance_bookings').select('*').in('status', ['proposed', 'confirmed']).order('start_at'), 'Expected maintenance arrivals'),
    result(db.from('vehicle_mileage_summary').select('*').order('lrv_id'), 'Vehicle mileage'),
    result(db.from('cycle_forecasts').select('*').order('priority_score', { ascending: false }), 'Maintenance forecasts'),
    result(db.from('maintenance_faults').select('*').in('status', ['open', 'scheduled']).order('reported_at'), 'Maintenance faults'),
  ])
  return { bookings, mileage, forecasts, faults }
}

export async function readHubometerPhoto(file, context) {
  const db = client()
  const imageBase64 = await fileToBase64(file)
  const { data, error } = await db.functions.invoke('ocr-hubometer', {
    body: {
      imageBase64,
      mimeType: file.type || 'image/jpeg',
      expectedKm: Number(context.expectedKm),
      lrvId: context.lrvId,
    },
  })
  if (!error && Number.isFinite(Number(data?.valueKm)) && Number.isFinite(Number(data?.confidence))) return data
  if (import.meta.env.VITE_TECHNICIAN_DEMO_OCR === 'false') throw new Error(error?.message || 'The OCR service did not return a valid reading.')
  return demoOcrResult(context)
}

export async function submitHubometerReading(input) {
  const db = client()
  const extension = (input.file.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg'
  const path = `${input.lrvId}/${Date.now()}-${globalThis.crypto.randomUUID()}.${extension}`
  const upload = await db.storage.from('hubometer-evidence').upload(path, input.file, {
    contentType: input.file.type || 'image/jpeg', cacheControl: '3600', upsert: false,
  })
  if (upload.error) throw new Error(`Photo upload: ${upload.error.message}`)
  const { data, error } = await db.rpc('submit_hubometer_observation', {
    p_lrv_id: input.lrvId,
    p_value_km: Number(input.valueKm),
    p_technician_id: input.technicianId,
    p_image_uri: `hubometer-evidence/${path}`,
    p_ocr_value_km: Number(input.ocrValueKm),
    p_ocr_confidence: Number(input.confidence),
    p_reviewed_manually: Boolean(input.reviewedManually),
    p_booking_id: input.bookingId || null,
    p_completed_cycles: (input.completedCycles || []).map(Number),
    p_completion_notes: input.completionNotes?.trim() || null,
  })
  if (error) {
    await db.storage.from('hubometer-evidence').remove([path])
    throw new Error(error.message)
  }
  return data
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('Could not read the captured photo.'))
    reader.readAsDataURL(file)
  })
}

function demoOcrResult(context) {
  const vehicleNumber = Number(String(context.lrvId).replace(/\D/g, '')) || 1
  const expected = Number(context.expectedKm) || 100000
  const lowConfidence = vehicleNumber % 3 === 0
  return {
    valueKm: Math.round((expected + (vehicleNumber % 5 - 2) * 0.1) * 10) / 10,
    confidence: lowConfidence ? 0.68 : 0.94,
    mode: 'synthetic_fallback',
  }
}

export async function scheduleMaintenance(input) {
  const db = client()
  const { data, error } = await db.rpc('schedule_maintenance', {
    p_lrv_id: input.lrvId, p_primary_cycle: input.workType === 'corrective' ? null : Number(input.primaryCycle),
    p_bundled_cycles: input.workType === 'corrective' ? [] : input.bundledCycles.map(Number), p_bay_id: input.bayId,
    p_start_at: input.startAt, p_end_at: input.endAt, p_status: input.status,
    p_notes: input.notes || null, p_booking_id: input.bookingId || null,
    p_work_type: input.workType || 'preventive', p_fault_id: input.faultId || null,
  })
  if (error) throw new Error(error.message)
  return data
}

export async function completeMaintenance(input) {
  const db = client()
  const { data, error } = await db.rpc('complete_maintenance', {
    p_lrv_id: input.lrvId, p_primary_cycle: input.workType === 'corrective' ? null : Number(input.primaryCycle),
    p_completion_mileage_km: Number(input.mileageKm), p_technician_id: input.technicianId || 'TECH_DEMO',
    p_booking_id: input.bookingId || null, p_notes: input.notes || null,
    p_completed_cycles: input.completedCycles ? input.completedCycles.map(Number) : null,
    p_work_type: input.workType || 'preventive', p_fault_id: input.faultId || null,
  })
  if (error) throw new Error(error.message)
  return data
}

export async function cancelMaintenanceBooking(bookingId, reason = 'Cancelled by OCC planner') {
  const db = client()
  const { error } = await db.rpc('cancel_maintenance_booking', {
    p_booking_id: bookingId, p_reason: reason,
  })
  if (error) throw new Error(error.message)
}

export async function resetDashboardDemo() {
  const db = client()
  const demoLrvIds = Array.from({ length: 30 }, (_, index) => `D${String(index + 1).padStart(2, '0')}`)
  const { data: observations, error: observationError } = await db
    .from('technician_observations')
    .select('image_uri')
    .in('lrv_id', demoLrvIds)
  if (observationError) throw new Error(`Technician evidence: ${observationError.message}`)
  const prefix = 'hubometer-evidence/'
  const imagePaths = [...new Set((observations || [])
    .map((row) => String(row.image_uri || ''))
    .filter((uri) => uri.startsWith(prefix))
    .map((uri) => uri.slice(prefix.length)))]
  for (let offset = 0; offset < imagePaths.length; offset += 1000) {
    const { error: storageError } = await db.storage
      .from('hubometer-evidence')
      .remove(imagePaths.slice(offset, offset + 1000))
    if (storageError) throw new Error(`Technician photo reset: ${storageError.message}`)
  }
  const { error } = await db.rpc('reset_dashboard_demo')
  if (error) throw new Error(error.message)
}

export async function selectStockReplacement(changeId, replacementLrvId) {
  const db = client()
  const { error } = await db.rpc('select_stock_replacement', {
    p_stock_change_id: changeId, p_replacement_lrv_id: replacementLrvId,
  })
  if (error) throw new Error(error.message)
}

export async function confirmStockChange(changeId) {
  const db = client()
  const { data, error } = await db.rpc('confirm_stock_change', {
    p_stock_change_id: changeId, p_decided_by: 'OCC_DEMO',
  })
  if (error) throw new Error(error.message)
  return data
}

export async function savePlanningSettings(settings) {
  const db = client()
  const { error } = await db.from('planning_settings').update({
    forecast_horizon_days: Number(settings.forecast_horizon_days),
    deployment_safety_margin_km: Number(settings.deployment_safety_margin_km),
    stale_telemetry_hours: Number(settings.stale_telemetry_hours),
    minimum_service_vehicles: Number(settings.minimum_service_vehicles),
    updated_at: new Date().toISOString(),
  }).eq('fleet', 'splrt')
  if (error) throw new Error(error.message)
}

export async function saveCycleRule(rule) {
  const db = client()
  const { error } = await db.from('maintenance_cycle_rules').update({
    tolerance_km: Number(rule.tolerance_km), duration_minutes: Number(rule.duration_minutes),
    compatible_bay_type: rule.compatible_bay_type, updated_at: new Date().toISOString(),
  }).eq('fleet', 'splrt').eq('cycle_type', Number(rule.cycle_type))
  if (error) throw new Error(error.message)
}

export async function saveBay(bay) {
  const db = client()
  const { error } = await db.from('depot_bays').update({
    name: bay.name, bay_type: bay.bay_type,
    opens_at: bay.opens_at, closes_at: bay.closes_at, active: Boolean(bay.active),
  }).eq('bay_id', bay.bay_id).eq('fleet', 'splrt')
  if (error) throw new Error(error.message)
}

export async function loadMaintenancePhoto(imageUri) {
  const prefix = 'hubometer-evidence/'
  if (!imageUri?.startsWith(prefix) || !imageUri.slice(prefix.length)) throw new Error('This record has no valid photo reference.')
  const { data, error } = await client().storage.from('hubometer-evidence').createSignedUrl(imageUri.slice(prefix.length), 300)
  if (error) throw new Error('The maintenance photo could not be loaded. Please try again.')
  return data.signedUrl
}
