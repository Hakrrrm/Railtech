import { describe, expect, it, vi } from 'vitest'
import { bayClearanceReply, validateSourceBay } from '../../../supabase/functions/_shared/assistantBayScope'
import { runAssistantTurn } from '../../../supabase/functions/_shared/assistantAgent'
const now = new Date('2026-09-19T13:00:00+08:00')
const data = { bays: [{ bay_id: 'SPLRT-BAY-1' }, { bay_id: 'SPLRT-BAY-2' }], bookings: [
  { id: 'a', lrv_id: 'D30', bay_id: 'SPLRT-BAY-1', status: 'confirmed', work_type: 'corrective', start_at: '2026-09-19T13:30:00+08:00', end_at: '2026-09-19T17:30:00+08:00' },
  { id: 'b', lrv_id: 'D12', bay_id: 'SPLRT-BAY-2', status: 'confirmed', work_type: 'preventive', primary_cycle: 2000, start_at: '2026-09-19T18:30:00+08:00', end_at: '2026-09-19T20:30:00+08:00' },
] }
describe('source bay accuracy', () => {
  it('answers the reported Bay 2 query without importing V30 from Bay 1', async () => {
    const provider = vi.fn(), saveProposal = vi.fn()
    const result = await runAssistantTurn({ message: 'i need to clear bay 2 today, how can i reschedule', now, loadData: async () => data, provider, saveProposal })
    expect(result.text).toContain('V12')
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
  const provider = vi.fn().mockResolvedValueOnce(call('get_fleet_status')).mockResolvedValueOnce(call('propose_reschedule', { vehicleIds: ['V12', 'V30'], bayIds: ['SPLRT-BAY-1'], startDate: null, endDate: null, startTime: null }))
  const saveProposal = vi.fn()
  const result = await runAssistantTurn({ message: 'Reschedule them', loadData: async () => fleet, provider, saveProposal, now, planningPreferences: { sourceScope: { bayId: 'SPLRT-BAY-2', date: '2026-09-19' } } })
  expect(result.text).toContain('not all booked in the source bay')
  expect(saveProposal).not.toHaveBeenCalled()
})
