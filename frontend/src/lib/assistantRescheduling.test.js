import { describe, it, expect } from 'vitest'
import { buildReschedulePlan, rescheduleSchema } from '../../../supabase/functions/_shared/assistantRescheduling.js'
import { assistantSyntheticFixture } from './assistantSyntheticFixture.js'

const now = new Date('2026-09-19T11:00:00+08:00')
const bay2 = 'SPLRT-BAY-2'
const request = { vehicleIds: ['V23', 'V24'], bayIds: [bay2], startDate: null, endDate: null, startTime: null }
function fixture() {
  const data = assistantSyntheticFixture()
  data.bookings.push({ id: 'seed-D23', lrv_id: 'D23', work_type: 'preventive', primary_cycle: 40000,
    bundled_cycles: [2000, 13000, 40000], bay_id: 'SPLRT-BAY-1', start_at: '2026-09-21T06:00:00+08:00',
    end_at: '2026-09-21T12:00:00+08:00', status: 'confirmed', notes: 'Check suspension noise', updated_at: '2026-09-18T03:00:00Z' })
  return data
}
const plan = (data = fixture(), input = request, clock = now) => buildReschedulePlan(data, input, clock)
describe('confirmed booking rescheduling', () => {
  it('moves V23 and V24 together without a new-job horizon rejecting Sept 21', () => {
    const result = plan()
    expect(result.kind).toBe('reschedule')
    expect(result.bookings).toHaveLength(2)
    expect(result.bookings.map((item) => [item.lrvId, item.bayId, item.startAt, item.endAt])).toEqual([
      ['D23', bay2, '2026-09-20T22:00:00.000Z', '2026-09-21T04:00:00.000Z'],
      ['D24', bay2, '2026-09-21T05:00:00.000Z', '2026-09-21T09:00:00.000Z'],
    ])
    expect(rescheduleSchema.properties).not.toHaveProperty('horizonDays')
    expect(rescheduleSchema.additionalProperties).toBe(false)
    expect(rescheduleSchema.required.sort()).toEqual(Object.keys(rescheduleSchema.properties).sort())
  })
  it('preserves work orders, original versions and notes despite absent forecasts', () => {
    const data = fixture(); data.forecasts = []
    const before = structuredClone(data)
    const result = plan(data)
    expect(result.bookings[0]).toMatchObject({ bookingId: 'seed-D23', primaryCycle: 40000, bundledCycles: [2000, 13000, 40000], notes: 'Check suspension noise',
      original: { id: 'seed-D23', bayId: 'SPLRT-BAY-1', startAt: '2026-09-21T06:00:00+08:00', updatedAt: '2026-09-18T03:00:00Z' } })
    expect(result.bookings[1].primaryCycle).toBe(13000)
    expect(data).toEqual(before)
  })
  it('deduplicates internal and display aliases', () => {
    expect(plan(fixture(), { ...request, vehicleIds: ['V23', 'D23'] }).bookings).toHaveLength(1)
  })
  it('does not move started, completed, proposed or ambiguous jobs', () => {
    for (const mutate of [
      (data) => { data.bookings.find((b) => b.lrv_id === 'D23').status = 'completed' },
      (data) => { data.bookings.find((b) => b.lrv_id === 'D23').status = 'proposed' },
      (data) => { data.bookings.push({ ...data.bookings.find((b) => b.lrv_id === 'D23'), id: 'duplicate' }) },
      (data) => { data.bookings.find((b) => b.lrv_id === 'D23').start_at = now.toISOString() },
    ]) {
      const data = fixture(); mutate(data)
      expect(plan(data).bookings).toEqual([])
      expect(plan(data).skipped.length).toBeGreaterThan(0)
    }
  })
  it('retains sources when any joint move fails', () => {
    const data = fixture()
    data.duties.push({ lrv_id: 'D24', status: 'planned', duty_start: '2026-09-21T00:00:00+08:00', duty_end: '2026-09-22T00:00:00+08:00' })
    const before = structuredClone(data.bookings)
    expect(plan(data).bookings).toEqual([])
    expect(plan(data).skipped[0].reason).toContain('operating duties')
    expect(data.bookings).toEqual(before)
  })
  it('does not silently change an explicitly requested time or day', () => {
    const data = fixture()
    data.bookings.push({ id: 'other', lrv_id: 'D01', bay_id: bay2, status: 'confirmed', start_at: '2026-09-21T06:00:00+08:00', end_at: '2026-09-21T10:00:00+08:00' })
    const fixed = plan(data, { ...request, vehicleIds: ['V23'], startDate: '2026-09-21', startTime: '06:00' })
    expect(fixed.bookings).toEqual([])
    const flexible = plan(data, { ...request, vehicleIds: ['V23'] })
    expect(flexible.bookings[0].startAt).toBe('2026-09-21T05:00:00.000Z')
    expect(flexible.warnings.some((message) => message.includes('13:00'))).toBe(true)
  })
  it('enforces lunch, bay compatibility and turnaround', () => {
    const data = fixture()
    expect(plan(data, { ...request, vehicleIds: ['V23'], startTime: '08:00' }).bookings).toEqual([])
    data.bays[1].bay_type = 'routine'
    expect(plan(data).skipped[0].reason).toContain('compatible')
    data.bays[1].bay_type = 'heavy'
    data.bookings.push({ id: 'other', lrv_id: 'D01', bay_id: bay2, status: 'confirmed', start_at: '2026-09-21T17:00:00+08:00', end_at: '2026-09-21T19:00:00+08:00' })
    expect(plan(data, { ...request, vehicleIds: ['V24'], startTime: '13:00' }).bookings).toEqual([])
  })
  it('rejects fleet service minimum violations', () => {
    const data = fixture(); data.settings.minimum_service_vehicles = 22
    expect(plan(data).bookings).toEqual([])
    expect(plan(data).skipped[0].reason).toContain('fleet service minimum')
  })
  it('keeps faults and their duration/scope intact', () => {
    const data = fixture()
    data.bookings.push({ id: 'fault-booking', lrv_id: 'D30', fault_id: 'fault-D30', work_type: 'corrective', primary_cycle: null, bundled_cycles: [],
      status: 'confirmed', bay_id: 'SPLRT-BAY-1', start_at: '2026-09-21T13:00:00+08:00', end_at: '2026-09-21T17:00:00+08:00', notes: 'Tracking inspection' })
    expect(plan(data, { ...request, vehicleIds: ['V30'] }).bookings[0]).toMatchObject({ workType: 'corrective', primaryCycle: null, bundledCycles: [], faultId: 'fault-D30', notes: 'Tracking inspection' })
  })
  it('allows long reservations beyond the start-date window and accounts for every occupied day', () => {
    const data = fixture()
    const input = { ...request, vehicleIds: ['V26'], bayIds: ['SPLRT-BAY-1'], startDate: '2026-09-23', endDate: '2026-09-23' }
    const result = plan(data, input)
    expect(result.bookings[0]).toMatchObject({ startAt: '2026-09-23T00:00:00.000Z', endAt: '2026-09-24T00:00:00.000Z' })
    expect(result.warnings.some((message) => message.includes('continuous'))).toBe(true)
    data.bookings.push({ id: 'next-day', lrv_id: 'D01', bay_id: 'SPLRT-BAY-1', status: 'confirmed', start_at: '2026-09-24T07:00:00+08:00', end_at: '2026-09-24T23:00:00+08:00' })
    expect(plan(data, input).bookings).toEqual([])
  })
  it('can search only an explicitly permitted date range', () => {
    const data = fixture()
    data.bookings.push({ id: 'blocked', lrv_id: 'D01', bay_id: bay2, status: 'confirmed', start_at: '2026-09-21T00:00:00+08:00', end_at: '2026-09-22T00:00:00+08:00' })
    const input = { ...request, vehicleIds: ['V24'], startDate: '2026-09-21', endDate: '2026-09-22', startTime: '15:00' }
    expect(plan(data, input).bookings[0].startAt).toBe('2026-09-22T07:00:00.000Z')
    expect(plan(data, { ...input, endDate: null }).bookings).toEqual([])
  })
  it('rejects unsafe constraints and missing planning configuration', () => {
    for (const patch of [{ horizonDays: 1 }, { vehicleIds: [] }, { vehicleIds: ['V99'] }, { startDate: '2026-11-01' }, { startDate: '2026-02-30' }, { startTime: '24:00' }, { endDate: '2026-09-21' }, { bayIds: ['unknown'] }]) {
      expect(() => plan(fixture(), { ...request, ...patch })).toThrow()
    }
    const data = fixture(); data.settings = null
    expect(plan(data).bookings).toEqual([])
  })
})
