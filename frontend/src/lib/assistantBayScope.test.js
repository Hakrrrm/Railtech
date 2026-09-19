import { describe, expect, it, vi } from 'vitest'
import { sourceBayBookings, validateSourceBay, buildBayClearancePlan } from '../../../supabase/functions/_shared/assistantBayScope.js'
import { runAssistantTurn } from '../../../supabase/functions/_shared/assistantAgent.js'
const now = new Date('2026-09-19T13:00:00+08:00')
const data = { vehicles: ['D12', 'D30'].map(lrv_id => ({ lrv_id, status: 'in_service', fleet: 'splrt' })), rules: [{ cycle_type: 2000, duration_minutes: 120, compatible_bay_type: 'routine' }], settings: { minimum_service_vehicles: 0 }, forecasts: [], bays: [{ bay_id: 'SPLRT-BAY-1', active: true, bay_type: 'universal', opens_at: '06:00', closes_at: '23:00' }, { bay_id: 'SPLRT-BAY-2', active: true, bay_type: 'universal', opens_at: '06:00', closes_at: '23:00' }], bookings: [
  { id: 'a', lrv_id: 'D30', bay_id: 'SPLRT-BAY-1', status: 'confirmed', work_type: 'corrective', start_at: '2026-09-19T13:30:00+08:00', end_at: '2026-09-19T17:30:00+08:00' },
  { id: 'b', lrv_id: 'D12', bay_id: 'SPLRT-BAY-2', status: 'confirmed', work_type: 'preventive', primary_cycle: 2000, start_at: '2026-09-19T18:30:00+08:00', end_at: '2026-09-19T20:30:00+08:00' },
] }

const call = (name, args = {}) => ({ output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: name }] })
const reply = text => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] })
const scope = { bayId: 'SPLRT-BAY-2', date: '2026-09-19' }
function providerFor(mode, action, args) {
 return vi.fn().mockResolvedValueOnce(call('interpret_request', { mode, acceptsPreviousPlan: false, sourceBayId: scope.bayId, sourceDate: scope.date, question: null }))
 .mockResolvedValueOnce(call('get_fleet_status')).mockResolvedValueOnce(call(action, args)).mockResolvedValueOnce(reply('Computed options are shown below.'))
}
describe('authoritative source selection after model interpretation', () => {
 it.each(['I need that bay empty', 'Please make space in the second bay', 'yes, that arrangement works'])('prepares only source bookings for %s', async message => {
   const saveProposal = vi.fn().mockResolvedValue({ id: 'saved', status: 'proposed' })
   const result = await runAssistantTurn({ message, now, loadData: async () => data, saveProposal, provider: providerFor('propose','propose_bay_clearance') })
   expect(result.plan.bookings.map(b => b.bookingId)).toEqual(['b'])
   expect(result.plan.bookings[0].bayId).toBe('SPLRT-BAY-1')
   expect(result.batch.id).toBe('saved')
 })
 it('previews without a write', async () => {
   const saveProposal = vi.fn()
   const result = await runAssistantTurn({ message: 'What are my options?', now, loadData: async () => data, saveProposal, provider: providerFor('preview','preview_bay_clearance') })
   expect(result.plan.bookings.map(b => b.bookingId)).toEqual(['b'])
   expect(saveProposal).not.toHaveBeenCalled()
 })
 it('rejects out-of-bay vehicles selected by the planning model', async () => {
   const saveProposal = vi.fn()
   const result = await runAssistantTurn({ message: 'move them', now, loadData: async () => data, saveProposal, provider: providerFor('propose','propose_reschedule', { vehicleIds: ['V30'], bayIds: ['SPLRT-BAY-1'], startDate: null, endDate: null, startTime: null }) })
   expect(saveProposal).not.toHaveBeenCalled()
   expect(result.audit.some(a => a.outcome === 'rejected')).toBe(true)
 })
 it('detects stale source selections', () => {
   expect(() => validateSourceBay({ ...data, bookings: [] }, { vehicleIds: ['V12'] }, scope)).toThrow()
   expect(() => validateSourceBay(data, { vehicleIds: [] }, scope)).toThrow()
 })
 it('uses day overlap and excludes cancelled records', () => {
   expect(sourceBayBookings({ ...data, bookings: [{ ...data.bookings[1], start_at: '2026-09-18T00:00:00+08:00' }, { ...data.bookings[0], bay_id: scope.bayId, status: 'cancelled' }] }, scope).map(b => b.id)).toEqual(['b'])
 })
 it('handles empty bays without saving a proposal', async () => {
   const saveProposal = vi.fn()
   await runAssistantTurn({ message: 'clear it', now, loadData: async () => ({ ...data, bookings: [] }), saveProposal, provider: providerFor('propose','propose_bay_clearance') })
   expect(saveProposal).not.toHaveBeenCalled()
 })
})

describe('acceptance of an exact reviewed preview', () => {
 it.each([false, true])('revalidates the reviewed request; changed=%s', async changed => {
   const saveProposal = vi.fn().mockResolvedValue({ id: 'saved', status: 'proposed' })
   const preview = await runAssistantTurn({ message: 'options please', now, loadData: async () => data, saveProposal, provider: providerFor('preview', 'preview_bay_clearance') })
   const provider = vi.fn().mockResolvedValue(call('interpret_request', { mode: 'propose', acceptsPreviousPlan: true, sourceBayId: scope.bayId, sourceDate: scope.date, question: null }))
   const result = await runAssistantTurn({ message: 'that looks good to me', history: [{ role: 'assistant', content: preview.text }], planningPreferences: preview.planningPreferences, now,
     loadData: async () => changed ? { ...data, bookings: [] } : data, saveProposal, provider })
   if (changed) { expect(saveProposal).not.toHaveBeenCalled(); expect(result.text).toContain('schedule has changed') }
   else { expect(saveProposal).toHaveBeenCalledOnce(); expect(result.plan.bookings).toEqual(preview.plan.bookings) }
   expect(provider).toHaveBeenCalledOnce()
 })
})


describe('whole-day clearance', () => {
 const wholeDay = { bayId: 'ALL', date: '2026-09-20' }
 const fixture = () => ({ ...data, bookings: data.bookings.map(b => ({ ...b,
   work_type: 'preventive', primary_cycle: 2000,
   start_at: '2026-09-20T14:00:00+08:00', end_at: '2026-09-20T16:00:00+08:00'
 })) })
 it('selects both bays and moves every booking outside the day', () => {
   const plan = buildBayClearancePlan(fixture(), wholeDay, now)
   expect(plan.bookings.map(b => b.bookingId).sort()).toEqual(['a','b'])
   expect(plan.bookings.every(b => Date.parse(b.startAt) >= Date.parse('2026-09-21T00:00:00+08:00'))).toBe(true)
 })
 it('searches later dates if the following day is unavailable', () => {
   const input = fixture()
   input.bookings.push(...input.bays.map((b,i) => ({ id: `busy${i}`, lrv_id: `OTHER${i}`, bay_id: b.bay_id, status: 'confirmed', start_at: '2026-09-21T00:00:00+08:00', end_at: '2026-09-22T00:00:00+08:00' })))
   const plan = buildBayClearancePlan(input, wholeDay, now)
   expect(plan.bookings).toHaveLength(2)
   expect(plan.bookings.every(b => Date.parse(b.startAt) >= Date.parse('2026-09-22T00:00:00+08:00'))).toBe(true)
 })
 it('includes overlapping long stays and flags work already started', () => {
   const input = fixture()
   input.bookings[0].start_at = '2026-09-18T08:00:00+08:00'
   expect(sourceBayBookings(input, wholeDay)).toHaveLength(2)
   const plan = buildBayClearancePlan(input, wholeDay, now)
   expect(plan.bookings.map(b => b.bookingId)).toEqual(['b'])
   expect(plan.warnings.join(' ')).toContain('will not fully clear')
 })
 it('creates a persisted blue proposal from an interpreted all-bay request', async () => {
   const saveProposal = vi.fn().mockResolvedValue({ id: 'day-plan', status: 'proposed' })
   const provider = vi.fn().mockResolvedValueOnce(call('interpret_request', { mode: 'propose', acceptsPreviousPlan: false, sourceBayId: 'ALL', sourceDate: wholeDay.date, question: null }))
     .mockResolvedValueOnce(call('get_fleet_status')).mockResolvedValueOnce(call('propose_bay_clearance'))
   const result = await runAssistantTurn({ message: 'Both bays will be closed tomorrow, help me reschedule', now, loadData: async () => fixture(), saveProposal, provider })
   expect(saveProposal).toHaveBeenCalledOnce()
   expect(result.plan.bookings).toHaveLength(2)
   expect(result.batch.id).toBe('day-plan')
 })
})
