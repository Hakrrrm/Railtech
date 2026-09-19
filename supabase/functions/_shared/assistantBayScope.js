import { buildReschedulePlan } from './assistantRescheduling.js'

export function sourceBayBookings(data, scope) {
  const start = Date.parse(`${scope.date}T00:00:00+08:00`)
  return (data.bookings || []).filter(b => (scope.bayId === 'ALL' || b.bay_id === scope.bayId) && ['confirmed', 'proposed'].includes(b.status) && Date.parse(b.start_at) < start + 86400000 && Date.parse(b.end_at) > start)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))
}

export function validateSourceBay(data, args, scope) {
  const rows = sourceBayBookings(data, scope)
  if (!Array.isArray(args.vehicleIds) || !args.vehicleIds.length) throw new Error('Select the actual bookings occupying the source bay.')
  if (args.vehicleIds.some(id => !rows.some(b => [b.lrv_id, b.lrv_id.replace(/^D/, 'V')].includes(id.toUpperCase())))) throw new Error('The selected LRVs are not all booked in the source bay on that date. Refresh the bay schedule before proposing moves.')
}

export function buildBayClearancePlan(data, scope, now) {
  const source = sourceBayBookings(data, scope)
  const movable = source.filter(b => b.status === 'confirmed' && Date.parse(b.start_at) > now.getTime())
  const blocked = source.filter(b => !movable.includes(b))
  if (!movable.length) return { kind: 'reschedule', bookings: [], skipped: blocked.map(b => ({ lrvId: b.lrv_id, reason: b.status === 'proposed' ? 'Confirm or edit the existing draft booking first.' : 'This visit has already started; use the booking editor to review work in progress.' })), warnings: [], summary: 'No future confirmed bookings can be moved.' }
  const otherBays = scope.bayId === 'ALL' ? [] : data.bays.filter(b => b.active && b.bay_id !== scope.bayId).map(b => b.bay_id)
  const args = { vehicleIds: movable.map(b => b.lrv_id), bayIds: otherBays, startDate: scope.date, endDate: scope.date, startTime: null }
  let plan = otherBays.length ? buildReschedulePlan(data, args, now) : null
  if (!plan?.bookings.length) {
    const last = new Date(now.getTime() + 8 * 3600000 + 42 * 86400000).toISOString().slice(0,10)
    const tomorrow = new Date(Date.parse(`${scope.date}T00:00:00Z`) + 86400000).toISOString().slice(0,10)
    if (tomorrow > last) return { kind: 'reschedule', bookings: [], skipped: movable.map(b => ({ lrvId: b.lrv_id, reason: 'No later date remains in the 42-day planning window.' })), warnings: [], summary: 'No moves available within the planning window.' }
    plan = buildReschedulePlan(data, { ...args, bayIds: data.bays.filter(b => b.active).map(b => b.bay_id), startDate: tomorrow, endDate: last }, now)
    if (plan.bookings.length) plan.warnings.push('The selected work moves to the earliest feasible dates after the clearance day.')
  }
  if (blocked.length) plan.warnings.push('Some source visits are drafts or already started and remain in place; these moves alone will not fully clear the bay.')
  return plan
}
