// Deterministic projection of seed.dashboard_demo.sql, including all 30 LRVs,
// nested rules, faults and relative historical/upcoming bookings. Forecasts use
// a common fleet rate, as in 202609190001_fleet_average_forecasts.sql.
export function assistantSyntheticFixture(today = '2026-09-19') {
  const cycles = [2000, 13000, 40000, 120000, 360000]
  const customDaily = { 7: 410, 9: 92, 12: 400, 18: 105, 21: 148, 23: 402, 24: 84, 25: 96, 26: 78, 27: 86, 28: 82, 29: 110, 30: 75 }
  const overrides = { 'D07:2000': 390, 'D07:13000': 800, 'D12:2000': 0, 'D18:2000': -60,
    'D21:2000': 1480, 'D21:13000': 320, 'D22:360000': 500, 'D23:2000': 1950, 'D23:40000': 420,
    'D24:13000': -20, 'D25:40000': 50, 'D26:120000': 1100, 'D27:2000': 1450, 'D28:2000': 980 }
  const date = (offset) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
  const at = (offset, time) => `${date(offset)}T${time}:00+08:00`
  const vehicles = Array.from({ length: 30 }, (_, index) => {
    const n = index + 1
    return { lrv_id: `D${String(n).padStart(2, '0')}`, fleet: 'splrt', type: 'LRV',
      status: [18, 24, 25, 26].includes(n) ? 'maintenance' : [27, 28].includes(n) ? 'idle' : [29, 30].includes(n) ? 'faulty' : 'in_service' }
  })
  // A projected seven-day fleet rate is fixed so every test runs identically.
  const fleetRate = 118
  const forecasts = vehicles.flatMap((vehicle, index) => cycles.map((cycle, order) => {
    const n = index + 1
    const daily = customDaily[n] ?? 55 + (n * 17) % 66
    const remaining = overrides[`${vehicle.lrv_id}:${cycle}`] ?? Math.min(cycle - 10, Math.max(50, daily * (8 + ((n * 11 + (order + 1) * 17) % 113))))
    const days = remaining <= 0 ? 0 : Math.ceil(remaining / fleetRate)
    return { lrv_id: vehicle.lrv_id, cycle_type: cycle, km_to_next: remaining, km_since: cycle - remaining,
      forecast_days: days, forecast_date: date(days), rolling_daily_rate_km: fleetRate }
  }))
  const booking = (id, cycle, bay, day, start, endDay, end, status = 'confirmed') => ({
    id: `seed-${id}`, lrv_id: id, work_type: 'preventive', primary_cycle: cycle,
    bundled_cycles: cycles.filter((value) => value <= cycle), bay_id: `SPLRT-BAY-${bay}`,
    start_at: at(day, start), end_at: at(endDay, end), status,
  })
  return {
    vehicles, forecasts, mileage: [],
    rules: cycles.map((cycle, index) => ({ fleet: 'splrt', cycle_type: cycle,
      duration_minutes: [120, 240, 360, 1440, 30240][index], compatible_bay_type: index < 2 ? 'universal' : 'heavy', included_cycles: cycles.slice(0, index + 1) })),
    bays: [1, 2].map((bay) => ({ bay_id: `SPLRT-BAY-${bay}`, fleet: 'splrt', name: `Bay ${bay}`, bay_type: bay === 1 ? 'universal' : 'heavy', active: true, opens_at: '06:00:00', closes_at: '23:00:00' })),
    settings: { fleet: 'splrt', minimum_service_vehicles: 18 },
    bookings: [booking('D03', 2000, 1, -4, '07:00', -4, '09:00', 'completed'),
      booking('D14', 40000, 2, -4, '08:00', -4, '14:00', 'completed'),
      booking('D08', 13000, 1, -3, '09:00', -3, '13:00', 'completed'),
      booking('D16', 40000, 2, -2, '08:00', -2, '14:00', 'completed'),
      booking('D20', 2000, 1, -1, '14:00', -1, '16:00', 'completed'),
      booking('D18', 2000, 1, 0, '09:00', 0, '11:00'), booking('D07', 13000, 1, 1, '09:00', 1, '13:00'),
      booking('D24', 13000, 1, 2, '13:00', 2, '17:00'), booking('D25', 40000, 2, 3, '08:00', 3, '14:00'),
      booking('D26', 120000, 2, 4, '08:00', 5, '08:00'), booking('D22', 360000, 2, 6, '08:00', 27, '08:00')],
    faults: [{ id: 'fault-D29', lrv_id: 'D29', fault_code: 'BRAKE_PRESSURE', description: 'Brake pressure fault requires workshop diagnosis and repair', severity: 'critical', reported_at: at(-1, '20:00'), estimated_duration_minutes: 360, required_bay_type: 'heavy', status: 'open' },
      { id: 'fault-D30', lrv_id: 'D30', fault_code: 'TRACKING_CONTROL', description: 'Intermittent tracking and control fault requires workshop assessment', severity: 'high', reported_at: at(-1, '17:00'), estimated_duration_minutes: 240, required_bay_type: 'heavy', status: 'open' }],
    duties: vehicles.filter((_, index) => index + 1 <= 17 && index + 1 !== 9).map((vehicle) => ({ lrv_id: vehicle.lrv_id, duty_start: at(0, '05:30'), duty_end: at(0, '16:30'), status: 'planned' })),
  }
}
