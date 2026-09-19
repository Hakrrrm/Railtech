import { expect, it } from 'vitest'
import { buildMaintenanceModel } from './MaintenancePlanning'
import { buildModel } from './FleetOverview'
it('uses the same seven priority vehicles as overview, not all future forecasts', () => {
  const data = { vehicles: Array.from({ length: 12 }, (_, i) => ({ lrv_id: `D${String(i+1).padStart(2,'0')}`, status: 'in_service' })), mileage: [], bookings: [], faults: [], bays: [] }
  data.forecasts = data.vehicles.map((v,i) => ({ lrv_id: v.lrv_id, cycle_type: 2000, km_to_next: 100, forecast_days: i < 7 ? i : 20 }))
  expect(buildMaintenanceModel(data).queue.map(v => v.lrv_id)).toEqual(buildModel(data).priority.map(v => v.lrv_id))
  expect(buildMaintenanceModel(data).queue).toHaveLength(7)
})
