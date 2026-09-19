import { expect, it } from 'vitest'
import { buildModel } from './FleetOverview'
it('removes confirmed vehicles and counters, restoring them after cancellation', () => {
  const data = { vehicles: [{ lrv_id: 'D12', status: 'in_service' }], mileage: [], forecasts: [{ lrv_id: 'D12', cycle_type: 2000, forecast_days: 0, km_to_next: 0 }], bookings: [] }
  expect(buildModel(data).priority).toHaveLength(1)
  const booking = { lrv_id: 'D12', status: 'confirmed', start_at: '2099-01-01T00:00:00Z', end_at: '2099-01-01T02:00:00Z' }
  const booked = buildModel({ ...data, bookings: [booking] })
  expect(booked.priority).toHaveLength(0)
  expect(booked.attention).toHaveLength(0)
  expect(booked.dueSoon).toHaveLength(0)
  expect(booked.next.title).toBe('No unbooked priority work')
  expect(buildModel({ ...data, bookings: [{ ...booking, status: 'cancelled' }] }).priority).toHaveLength(1)
  expect(buildModel({ ...data, bookings: [{ ...booking, status: 'proposed' }] }).priority).toHaveLength(1)
})
