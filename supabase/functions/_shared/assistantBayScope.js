import { buildReschedulePlan } from './assistantRescheduling.js'
// Resolve source-bay requests from authoritative booking rows, not LLM selection.
export function planningDate(message, now) {
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  const iso = message.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
  const named = message.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?\b/i)
  let date = iso
  if (!date && named) date = `${named[3] || today.slice(0,4)}-${String(months.indexOf(named[2].slice(0,3).toLowerCase()) + 1).padStart(2,'0')}-${named[1].padStart(2,'0')}`
  if (!date && /\btomorrow\b/i.test(message)) date = new Date(Date.parse(today) + 86400000).toISOString().slice(0,10)
  if (!date && /\btoday\b/i.test(message)) date = today
  // Reject impossible dates instead of allowing Date.parse to roll them forward.
  if (!date) return null
  const parsed = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0,10) === date ? date : null
}

export function bayClearanceReply(message, data, now, pendingScope = null) {
  const match = message.match(/\b(?:clear|empty|vacate|free(?: up)?)\s+(?:out\s+)?bay[ -]*(\d+)\b/i)
  const pending = !match && pendingScope?.bayId && planningDate(message, now) ? pendingScope : null
  if (!match && !pending) return null
  const bays = (data.bays || []).filter(bay => pending ? bay.bay_id === pending.bayId : new RegExp(`(?:^|[- ])(?:bay[- ]*)?0*${Number(match[1])}$`, 'i').test(bay.bay_id) || new RegExp(`^Bay\\s+0*${Number(match[1])}\\b`, 'i').test(bay.name || ''))
  if (bays.length !== 1) return { text: 'Which configured bay do you want to clear?', scope: null }
  const date = planningDate(message, now)
  if (!date) return { text: 'Which date should this bay be cleared for?', scope: null, pendingScope: { bayId: bays[0].bay_id } }
  const bayId = bays[0].bay_id
  const rows = sourceBayBookings(data, { bayId, date })
  const title = `Bay ${Number(match?.[1] || bayId.match(/\d+$/)?.[0])} on ${date}`
  if (!rows.length) return { text: `${title} has no active maintenance bookings to move.`, scope: null }
  const text = rows.map(b => {
    const label = b.work_type === 'corrective' ? 'Corrective repair' : `${Number(b.primary_cycle) / 1000}K maintenance`
    const local = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
    return `• ${b.lrv_id.replace(/^D/, 'V')} · ${label} · ${local(b.start_at)}–${local(b.end_at)}${b.status === 'proposed' ? ' (draft)' : Date.parse(b.start_at) <= now.getTime() ? ' (already started; cannot reschedule)' : ''}`
  }).join('\n')
  return { text: `${title}:\n${text}\n\nI can preview moves for the future confirmed bookings; work already started needs operator review.`, scope: { bayId, date } }
}

export function sourceBayBookings(data, scope) {
  const start = Date.parse(`${scope.date}T00:00:00+08:00`)
  return (data.bookings || []).filter(b => b.bay_id === scope.bayId && ['confirmed', 'proposed'].includes(b.status) && Date.parse(b.start_at) < start + 86400000 && Date.parse(b.end_at) > start)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))
}

export function validateSourceBay(data, args, scope) {
  const rows = sourceBayBookings(data, scope)
  if (args.vehicleIds.some(id => !rows.some(b => [b.lrv_id, b.lrv_id.replace(/^D/, 'V')].includes(id.toUpperCase())))) throw new Error('The selected LRVs are not all booked in the source bay on that date. Refresh the bay schedule before proposing moves.')
}

export function buildBayClearancePlan(data, scope, now) {
  const source = sourceBayBookings(data, scope)
  const movable = source.filter(b => b.status === 'confirmed' && Date.parse(b.start_at) > now.getTime())
  const blocked = source.filter(b => !movable.includes(b))
  if (!movable.length) return { kind: 'reschedule', bookings: [], skipped: blocked.map(b => ({ lrvId: b.lrv_id, reason: b.status === 'proposed' ? 'Confirm or edit the existing draft booking first.' : 'This visit has already started; use the booking editor to review work in progress.' })), warnings: [], summary: 'No future confirmed bookings can be moved.' }
  const otherBays = data.bays.filter(b => b.active && b.bay_id !== scope.bayId).map(b => b.bay_id)
  const args = { vehicleIds: movable.map(b => b.lrv_id), bayIds: otherBays, startDate: scope.date, endDate: scope.date, startTime: null }
  let plan = otherBays.length ? buildReschedulePlan(data, args, now) : null
  if (!plan?.bookings.length) {
    const tomorrow = new Date(Date.parse(`${scope.date}T00:00:00Z`) + 86400000).toISOString().slice(0,10)
    plan = buildReschedulePlan(data, { ...args, bayIds: data.bays.filter(b => b.active).map(b => b.bay_id), startDate: tomorrow, endDate: tomorrow }, now)
    if (plan.bookings.length) plan.warnings.push('No same-day alternative fitted. This option moves the selected work to the following day.')
  }
  if (blocked.length) plan.warnings.push('Some source visits are drafts or already started and remain in place; these moves alone will not fully clear the bay.')
  return plan
}
