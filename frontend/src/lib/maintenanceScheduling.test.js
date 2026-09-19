import { describe, expect, it } from 'vitest'
import { findAvailableSlot } from './maintenanceScheduling'

const now = new Date('2026-09-19T00:00:00+08:00')
const bays = [
  { bay_id: 'BAY-1', bay_type: 'universal', opens_at: '06:00:00', closes_at: '23:00:00', active: true },
  { bay_id: 'BAY-2', bay_type: 'heavy', opens_at: '06:00:00', closes_at: '23:00:00', active: true },
]

describe('maintenance auto scheduling', () => {
  it('keeps a turnaround buffer and preserves the lunch hour', () => {
    const bookings = [{
      lrv_id: 'D01', bay_id: 'BAY-1', status: 'confirmed',
      start_at: '2026-09-19T06:00:00+08:00', end_at: '2026-09-19T10:00:00+08:00',
    }]
    const slot = findAvailableSlot(
      { duration_minutes: 120, compatible_bay_type: 'universal' },
      [bays[0]], bookings, [], 'D02', 0, now,
    )
    expect(slot.start.toISOString()).toBe('2026-09-19T05:00:00.000Z')
    expect(slot.end.toISOString()).toBe('2026-09-19T07:00:00.000Z')
  })

  it('uses the less-loaded compatible bay on the preferred day', () => {
    const bookings = [{
      lrv_id: 'D01', bay_id: 'BAY-1', status: 'confirmed',
      start_at: '2026-09-19T06:00:00+08:00', end_at: '2026-09-19T10:00:00+08:00',
    }]
    const slot = findAvailableSlot(
      { duration_minutes: 120, compatible_bay_type: 'universal' },
      bays, bookings, [], 'D02', 0, now,
    )
    expect(slot.bay.bay_id).toBe('BAY-2')
    expect(slot.start.toISOString()).toBe('2026-09-18T22:00:00.000Z')
  })

  it('spills work into the next day when the due day is heavily loaded', () => {
    const bookings = [
      { lrv_id: 'D01', bay_id: 'BAY-1', status: 'confirmed', start_at: '2026-09-19T06:00:00+08:00', end_at: '2026-09-19T12:00:00+08:00' },
      { lrv_id: 'D03', bay_id: 'BAY-2', status: 'confirmed', start_at: '2026-09-19T06:00:00+08:00', end_at: '2026-09-19T12:00:00+08:00' },
    ]
    const slot = findAvailableSlot(
      { duration_minutes: 120, compatible_bay_type: 'universal' },
      bays, bookings, [], 'D02', 0, now,
    )
    expect(slot.start.toISOString().slice(0, 10)).toBe('2026-09-19')
    expect(slot.start.getUTCHours()).toBe(22)
  })
})
