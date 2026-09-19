import { describe, expect, it } from 'vitest'
import { buildMaintenanceOutlook } from './maintenanceOutlook'

const dates = ['2026-09-19', '2026-09-20', '2026-09-21']
const booking = { id: 'one', lrv_id: 'D12', status: 'confirmed', start_at: '2026-09-19T08:00:00+08:00', end_at: '2026-09-19T10:00:00+08:00' }
const counts = bookings => buildMaintenanceOutlook(bookings, dates).map(day => day.count)
describe('maintenance outlook uses calendar bookings', () => {
  it('tracks additions, reschedules and cancellations instead of forecast dates', () => {
    expect(counts([])).toEqual([0, 0, 0])
    expect(counts([booking])).toEqual([1, 0, 0])
    expect(counts([{ ...booking, start_at: '2026-09-20T08:00:00+08:00', end_at: '2026-09-20T10:00:00+08:00' }])).toEqual([0, 1, 0])
    expect(counts([{ ...booking, status: 'cancelled' }])).toEqual([0, 0, 0])
  })
  it('includes every occupied Singapore date, excluding the end boundary', () => {
    expect(counts([{ ...booking, start_at: '2026-09-18T22:00:00Z', end_at: '2026-09-20T16:00:00Z' }])).toEqual([1, 1, 0])
  })
  it('keeps popup entries identical to counts and includes draft reservations', () => {
    const days = buildMaintenanceOutlook([booking, { ...booking, id: 'draft', lrv_id: 'D24', status: 'proposed' }, { ...booking, id: 'done', status: 'completed' }], dates)
    expect(days[0].count).toBe(2)
    expect(days[0].bookings.map(row => row.lrv_id)).toEqual(['D12', 'D24'])
  })
})
