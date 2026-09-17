import { describe, expect, it } from 'vitest'
import { compareMaintenancePriority } from './maintenancePriority'

describe('maintenance priority ordering', () => {
  it('places overdue and due-today work before faults and future recalls', () => {
    const rows = [
      { lrv_id: 'D07', forecast_days: 2, forecast_date: '2026-09-19', km_to_next: 390 },
      { lrv_id: 'D29', work_type: 'corrective', fault: { severity: 'critical', reported_at: '2026-09-16T12:00:00Z' } },
      { lrv_id: 'D12', forecast_days: 0, forecast_date: '2026-09-17', km_to_next: 0 },
      { lrv_id: 'D18', forecast_days: -2, forecast_date: '2026-09-15', km_to_next: -60 },
    ].sort(compareMaintenancePriority)
    expect(rows.map((row) => row.lrv_id)).toEqual(['D18', 'D12', 'D29', 'D07'])
  })

  it('orders faults by severity and then by oldest report', () => {
    const rows = [
      { lrv_id: 'D30', work_type: 'corrective', fault: { severity: 'high', reported_at: '2026-09-16T09:00:00Z' } },
      { lrv_id: 'D28', work_type: 'corrective', fault: { severity: 'critical', reported_at: '2026-09-16T10:00:00Z' } },
      { lrv_id: 'D29', work_type: 'corrective', fault: { severity: 'critical', reported_at: '2026-09-16T08:00:00Z' } },
    ].sort(compareMaintenancePriority)
    expect(rows.map((row) => row.lrv_id)).toEqual(['D29', 'D28', 'D30'])
  })

  it('orders upcoming work by due date, distance and vehicle number', () => {
    const rows = [
      { lrv_id: 'D22', forecast_days: 6, forecast_date: '2026-09-23', km_to_next: 500 },
      { lrv_id: 'D23', forecast_days: 2, forecast_date: '2026-09-19', km_to_next: 420 },
      { lrv_id: 'D07', forecast_days: 2, forecast_date: '2026-09-19', km_to_next: 390 },
      { lrv_id: 'D21', forecast_days: 3, forecast_date: '2026-09-20', km_to_next: 320 },
    ].sort(compareMaintenancePriority)
    expect(rows.map((row) => row.lrv_id)).toEqual(['D07', 'D23', 'D21', 'D22'])
  })
})
