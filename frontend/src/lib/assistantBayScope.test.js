import { describe, expect, it, vi } from 'vitest'
import { bayClearanceReply, validateSourceBay, planningDate } from '../../../supabase/functions/_shared/assistantBayScope'
import { runAssistantTurn } from '../../../supabase/functions/_shared/assistantAgent'
const now = new Date('2026-09-19T13:00:00+08:00')
const data = { vehicles: ['D12', 'D30'].map(lrv_id => ({ lrv_id, status: 'in_service', fleet: 'splrt' })), rules: [{ cycle_type: 2000, duration_minutes: 120, compatible_bay_type: 'routine' }], settings: { minimum_service_vehicles: 0 }, forecasts: [], bays: [{ bay_id: 'SPLRT-BAY-1', active: true, bay_type: 'universal', opens_at: '06:00', closes_at: '23:00' }, { bay_id: 'SPLRT-BAY-2', active: true, bay_type: 'universal', opens_at: '06:00', closes_at: '23:00' }], bookings: [
  { id: 'a', lrv_id: 'D30', bay_id: 'SPLRT-BAY-1', status: 'confirmed', work_type: 'corrective', start_at: '2026-09-19T13:30:00+08:00', end_at: '2026-09-19T17:30:00+08:00' },
  { id: 'b', lrv_id: 'D12', bay_id: 'SPLRT-BAY-2', status: 'confirmed', work_type: 'preventive', primary_cycle: 2000, start_at: '2026-09-19T18:30:00+08:00', end_at: '2026-09-19T20:30:00+08:00' },
] }
describe('source bay accuracy', () => {
  it('answers the reported Bay 2 query without importing V30 from Bay 1', async () => {
    const provider = vi.fn(), saveProposal = vi.fn()
    const result = await runAssistantTurn({ message: 'i need to clear bay 2 today, how can i reschedule', now, loadData: async () => data, provider, saveProposal })
    expect(result.plan.bookings.map(b => b.lrvId)).toEqual(['D12'])
    expect(result.plan.bookings[0].bayId).toBe('SPLRT-BAY-1')
    expect(result.text).not.toContain('V30')
    expect(result.planningPreferences.sourceScope).toEqual({ bayId: 'SPLRT-BAY-2', date: '2026-09-19' })
    expect(provider).not.toHaveBeenCalled()
    expect(saveProposal).not.toHaveBeenCalled()
  })
  it('rejects out-of-bay selections and sources moved since the earlier reply', () => {
    const scope = { bayId: 'SPLRT-BAY-2', date: '2026-09-19' }
    expect(() => validateSourceBay(data, { vehicleIds: ['V12', 'V30'] }, scope)).toThrow('not all booked')
    expect(() => validateSourceBay(data, { vehicleIds: ['V12'] }, scope)).not.toThrow()
    expect(() => validateSourceBay({ ...data, bookings: [] }, { vehicleIds: ['V12'] }, scope)).toThrow()
  })
  it('uses day overlap and distinguishes started work and cancelled bookings', () => {
    const reply = bayClearanceReply('clear bay 2 today', { ...data, bookings: [
      { ...data.bookings[1], start_at: '2026-09-18T10:00:00+08:00' },
      { ...data.bookings[0], bay_id: 'SPLRT-BAY-2', status: 'cancelled' },
    ] }, now)
    expect(reply.text).toContain('already started')
    expect(reply.text).not.toContain('V30')
  })
})

it('blocks model-selected Bay 1 vehicles in a Bay 2 follow-up before saving', async () => {
  const fleet = { ...data, vehicles: ['D12','D30'].map(lrv_id => ({ lrv_id, status: 'in_service', fleet: 'splrt' })), forecasts: [], rules: [], faults: [], duties: [], settings: {} }
  const call = (name, args = {}) => ({ output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: name }] })
  const provider = vi.fn().mockResolvedValueOnce(call('resolve_followup', { intent: 'other' })).mockResolvedValueOnce(call('get_fleet_status')).mockResolvedValueOnce(call('propose_reschedule', { vehicleIds: ['V12', 'V30'], bayIds: ['SPLRT-BAY-1'], startDate: null, endDate: null, startTime: null }))
  const saveProposal = vi.fn()
  const result = await runAssistantTurn({ message: 'Reschedule those later tomorrow', loadData: async () => fleet, provider, saveProposal, now, planningPreferences: { sourceScope: { bayId: 'SPLRT-BAY-2', date: '2026-09-19' } } })
  expect(result.text).toContain('not all booked in the source bay')
  expect(saveProposal).not.toHaveBeenCalled()
})

it.each(['yeah do that', 'sure do that', 'sounds good, go for it', 'please proceed with your suggestion'])('accepts contextual assent: %s', async message => {
  const saveProposal = vi.fn().mockResolvedValue({ id: 'persisted-batch', status: 'proposed' })
  const result = await runAssistantTurn({ message, loadData: async () => data, provider: vi.fn().mockResolvedValue({ output: [{ type: 'function_call', name: 'resolve_followup', arguments: JSON.stringify({ intent: 'accept_proposal' }) }] }), saveProposal, now,
    history: [{ role: 'assistant', content: '1 move is feasible. Say schedule it to prepare the moves for confirmation.' }], planningPreferences: { sourceScope: { bayId: 'SPLRT-BAY-2', date: '2026-09-19' } } })
  expect(saveProposal).toHaveBeenCalledOnce()
  expect(result.batch.id).toBe('persisted-batch')
  expect(result.plan.bookings[0]).toMatchObject({ bookingId: 'b', bayId: 'SPLRT-BAY-1' })
})

it('keeps a preview acceptance read-only', async () => {
  const saveProposal = vi.fn()
  const result = await runAssistantTurn({ message: 'sounds good', loadData: async () => data, saveProposal, now,
    provider: vi.fn().mockResolvedValue({ output: [{ type: 'function_call', name: 'resolve_followup', arguments: '{"intent":"accept_preview"}' }] }),
    history: [{ role: 'assistant', content: 'Would you like me to explore alternative slots?' }], planningPreferences: { sourceScope: { bayId: 'SPLRT-BAY-2', date: '2026-09-19' } } })
  expect(result.plan.bookings).toHaveLength(1)
  expect(saveProposal).not.toHaveBeenCalled()
})


describe('bay clearance date conversations', () => {
  it.each(['21 sept', '21 September', '21st Sep 2026', '2026-09-21'])('understands %s', text => {
    expect(planningDate(text, now)).toBe('2026-09-21')
  })
  it('rejects impossible dates', () => {
    expect(planningDate('31 Sept', now)).toBeNull()
    expect(planningDate('2026-02-30', now)).toBeNull()
  })
  const future = { ...data, bookings: data.bookings.map(b => ({ ...b, work_type: 'preventive', primary_cycle: 2000, start_at: b.start_at.replace('09-19','09-21'), end_at: b.end_at.replace('09-19','09-21') })) }
  it('handles the exact screenshot request without asking for its date again', async () => {
    const result = await runAssistantTurn({ message: 'i need to clear bay 1 on 21 sept where can i reschedule to?', now, loadData: async () => future, provider: vi.fn(), saveProposal: vi.fn() })
    expect(result.plan.bookings.map(b => b.bookingId)).toEqual(['a'])
    expect(result.plan.bookings[0].bayId).toBe('SPLRT-BAY-2')
    expect(result.planningPreferences.sourceScope.date).toBe('2026-09-21')
  })
  it('retains a bay while asking for its missing date, then handles a date-only reply', async () => {
    const args = { now, loadData: async () => future, provider: vi.fn(), saveProposal: vi.fn() }
    const first = await runAssistantTurn({ ...args, message: 'clear bay 1' })
    expect(first.planningPreferences.pendingSourceScope.bayId).toBe('SPLRT-BAY-1')
    const result = await runAssistantTurn({ ...args, message: '21 sept', planningPreferences: first.planningPreferences,
      history: [{ role: 'user', content: 'clear bay 1' }, { role: 'assistant', content: first.text }] })
    expect(result.plan.bookings.map(b => b.bookingId)).toEqual(['a'])
    expect(args.saveProposal).not.toHaveBeenCalled()
  })
})
