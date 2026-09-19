import { singaporeDate } from './format'

export const MAINTENANCE_TURNAROUND_MINUTES = 30
export const WORKSHOP_LUNCH_START_MINUTES = 12 * 60
export const WORKSHOP_LUNCH_END_MINUTES = 13 * 60

export function findAvailableSlot(rule, bays, bookings, duties, lrvId, preferredOffset, now = new Date()) {
  if (!rule) return null
  const durationMinutes = Number(rule.duration_minutes || 90)
  const durationMs = durationMinutes * 60000
  const bufferMs = MAINTENANCE_TURNAROUND_MINUTES * 60000
  const eligibleBays = bays.filter((bay) => bay.active && isCompatibleBay(rule, bay))
  const occupied = bookings.filter((booking) => ['proposed', 'confirmed'].includes(booking.status))
  const candidates = []

  for (let offset = preferredOffset; offset <= preferredOffset + 42; offset += 1) {
    const date = singaporeDate(offset, now)
    const dayStart = new Date(`${date}T00:00:00+08:00`)
    const dayEnd = new Date(dayStart.getTime() + 86400000)
    const dayLoadMinutes = occupied.reduce((total, booking) => total + overlapMinutes(booking, dayStart, dayEnd), 0)

    for (const bay of eligibleBays) {
      const openMinutes = timeToMinutes(bay.opens_at)
      const closeMinutes = timeToMinutes(bay.closes_at)
      const bayLoadMinutes = occupied
        .filter((booking) => booking.bay_id === bay.bay_id)
        .reduce((total, booking) => total + overlapMinutes(booking, dayStart, dayEnd), 0)

      for (let minute = openMinutes; minute <= closeMinutes; minute += 30) {
        const start = new Date(`${date}T${minutesToTime(minute)}:00+08:00`)
        const end = new Date(start.getTime() + durationMs)
        const endTime = timeToMinutes(new Intl.DateTimeFormat('en-SG', {
          timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(end))
        if (start < now || endTime < openMinutes || endTime > closeMinutes) continue
        if (canFitAroundLunch(durationMinutes, openMinutes, closeMinutes)
          && overlapsMinuteWindow(minute, minute + durationMinutes, WORKSHOP_LUNCH_START_MINUTES, WORKSHOP_LUNCH_END_MINUTES)) continue

        const bayOverlap = occupied.some((booking) => booking.bay_id === bay.bay_id
          && new Date(booking.start_at).getTime() - bufferMs < end.getTime()
          && new Date(booking.end_at).getTime() + bufferMs > start.getTime())
        const vehicleOverlap = occupied.some((booking) => booking.lrv_id === lrvId
          && new Date(booking.start_at) < end && new Date(booking.end_at) > start)
        const dutyOverlap = (duties || []).some((duty) => duty.lrv_id === lrvId
          && new Date(duty.duty_start) < end && new Date(duty.duty_end) > start)
        if (bayOverlap || vehicleOverlap || dutyOverlap) continue

        // One day of lateness costs six hours of load. This keeps work close to
        // its due date while allowing an overloaded day to spill into the next.
        const score = (offset - preferredOffset) * 360 + dayLoadMinutes + bayLoadMinutes * 0.25 + minute / 100
        candidates.push({ bay, start, end, score })
        break
      }
    }
  }

  return candidates.sort((a, b) => a.score - b.score || a.start - b.start || a.bay.bay_id.localeCompare(b.bay.bay_id))[0] || null
}

export function isCompatibleBay(rule, bay) {
  if (rule.compatible_bay_type === 'heavy') return ['heavy', 'universal'].includes(bay.bay_type)
  return ['routine', 'universal', 'heavy'].includes(bay.bay_type)
}

function canFitAroundLunch(durationMinutes, openMinutes, closeMinutes) {
  const morningMinutes = Math.max(0, WORKSHOP_LUNCH_START_MINUTES - openMinutes)
  const afternoonMinutes = Math.max(0, closeMinutes - WORKSHOP_LUNCH_END_MINUTES)
  return durationMinutes <= Math.max(morningMinutes, afternoonMinutes)
}

function overlapsMinuteWindow(start, end, blockedStart, blockedEnd) {
  return start < blockedEnd && end > blockedStart
}

function overlapMinutes(booking, start, end) {
  const overlapStart = Math.max(new Date(booking.start_at).getTime(), start.getTime())
  const overlapEnd = Math.min(new Date(booking.end_at).getTime(), end.getTime())
  return Math.max(0, (overlapEnd - overlapStart) / 60000)
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number)
  return hours * 60 + minutes
}

function minutesToTime(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}
