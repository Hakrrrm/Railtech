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
  const [vehicles, mileage, forecasts, bookings, settings] = await Promise.all([
    result(db.from('vehicles').select('*').order('lrv_id'), 'Vehicles'),
    result(db.from('vehicle_mileage_summary').select('*').order('lrv_id'), 'Mileage summary'),
    result(db.from('cycle_forecasts').select('*').order('priority_score', { ascending: false }), 'Cycle forecasts'),
    result(db.from('maintenance_bookings').select('*').in('status', ['proposed', 'confirmed']).order('start_at'), 'Bookings'),
    result(db.from('planning_settings').select('*').eq('fleet', 'splrt').limit(1), 'Planning settings'),
  ])
  return { vehicles, mileage, forecasts, bookings, settings: settings[0] || null }
}

export async function loadVehicleDetail(lrvId) {
  const db = client()
  const [summary, forecasts, traversals, anchors, events, bookings, rules] = await Promise.all([
    result(db.from('vehicle_mileage_summary').select('*').eq('lrv_id', lrvId).limit(1), 'Vehicle summary'),
    result(db.from('cycle_forecasts').select('*').eq('lrv_id', lrvId).order('cycle_type'), 'Maintenance cycles'),
    result(db.from('segment_traversals').select('*').eq('lrv_id', lrvId).order('ts', { ascending: false }).limit(5000), 'Segment activity'),
    result(db.from('mileage_anchors').select('*').eq('lrv_id', lrvId).order('ts', { ascending: false }).limit(30), 'Mileage evidence'),
    result(db.from('maintenance_events').select('*').eq('lrv_id', lrvId).order('completed_at', { ascending: false }).limit(30), 'Maintenance log'),
    result(db.from('maintenance_bookings').select('*').eq('lrv_id', lrvId).order('start_at'), 'Depot visits'),
    result(db.from('maintenance_cycle_rules').select('*').eq('fleet', 'splrt').order('cycle_type'), 'Maintenance rules'),
  ])
  return { summary: summary[0] || null, forecasts, traversals, anchors, events, bookings, rules }
}

export async function loadMaintenancePlanning() {
  const db = client()
  const [vehicles, mileage, forecasts, bookings, bays, rules, settings, duties] = await Promise.all([
    result(db.from('vehicles').select('*').order('lrv_id'), 'Vehicles'),
    result(db.from('vehicle_mileage_summary').select('lrv_id,lifetime_planning_mileage_km,device_odo_km').order('lrv_id'), 'Mileage summary'),
    result(db.from('cycle_forecasts').select('*').order('priority_score', { ascending: false }), 'Recall forecasts'),
    result(db.from('maintenance_bookings').select('*').order('start_at'), 'Depot bookings'),
    result(db.from('depot_bays').select('*').order('bay_id'), 'Depot bays'),
    result(db.from('maintenance_cycle_rules').select('*').eq('fleet', 'splrt').order('cycle_type'), 'Maintenance rules'),
    result(db.from('planning_settings').select('*').eq('fleet', 'splrt').limit(1), 'Planning settings'),
    result(db.from('duty_assignments').select('*').in('status', ['planned', 'active']).order('duty_start'), 'Duty assignments'),
  ])
  return { vehicles, mileage, forecasts, bookings, bays, rules, settings: settings[0] || null, duties }
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
  const [anchors, events, changes, rules] = await Promise.all([
    result(db.from('mileage_anchors').select('*').order('ts', { ascending: false }).limit(120), 'Mileage evidence'),
    result(db.from('maintenance_events').select('*').order('completed_at', { ascending: false }).limit(120), 'Maintenance evidence'),
    result(db.from('stock_changes').select('*').order('created_at', { ascending: false }).limit(120), 'Deployment evidence'),
    result(db.from('maintenance_cycle_rules').select('*').eq('fleet', 'splrt').order('cycle_type'), 'Maintenance rules'),
  ])
  return { anchors, events, changes, rules }
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

export async function scheduleMaintenance(input) {
  const db = client()
  const { data, error } = await db.rpc('schedule_maintenance', {
    p_lrv_id: input.lrvId, p_primary_cycle: Number(input.primaryCycle),
    p_bundled_cycles: input.bundledCycles.map(Number), p_bay_id: input.bayId,
    p_start_at: input.startAt, p_end_at: input.endAt, p_status: input.status,
    p_notes: input.notes || null, p_booking_id: input.bookingId || null,
  })
  if (error) throw new Error(error.message)
  return data
}

export async function completeMaintenance(input) {
  const db = client()
  const { data, error } = await db.rpc('complete_maintenance', {
    p_lrv_id: input.lrvId, p_primary_cycle: Number(input.primaryCycle),
    p_completion_mileage_km: Number(input.mileageKm), p_technician_id: input.technicianId || 'TECH_DEMO',
    p_booking_id: input.bookingId || null, p_notes: input.notes || null,
    p_completed_cycles: input.completedCycles ? input.completedCycles.map(Number) : null,
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
