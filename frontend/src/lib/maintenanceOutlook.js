import { singaporeDate } from './format'

export function buildMaintenanceOutlook(bookings, dates = Array.from({ length: 14 }, (_, offset) => singaporeDate(offset))) {
  return dates.map(date => {
    const start = Date.parse(`${date}T00:00:00+08:00`)
    const end = start + 86400000
    const visits = bookings.filter(booking => ['proposed', 'confirmed'].includes(booking.status)
      && Date.parse(booking.start_at) < end && Date.parse(booking.end_at) > start)
      .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || a.lrv_id.localeCompare(b.lrv_id))
    return { date, count: visits.length, bookings: visits }
  })
}
