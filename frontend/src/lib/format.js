export const SINGAPORE_TIMEZONE = 'Asia/Singapore'

export function formatKm(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return `${Number(value).toLocaleString('en-SG', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} km`
}

export function formatDate(value, options = {}) {
  if (!value) return '—'
  const { year, ...intlOptions } = options
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: SINGAPORE_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: year ? 'numeric' : undefined,
    ...intlOptions,
  }).format(new Date(value))
}

export function formatDateTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: SINGAPORE_TIMEZONE,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

export function formatTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-SG', {
    timeZone: SINGAPORE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

export function singaporeDate(offset = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SINGAPORE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const date = new Date(`${values.year}-${values.month}-${values.day}T00:00:00+08:00`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export function daysFromToday(value) {
  if (!value) return null
  const today = new Date(`${singaporeDate()}T00:00:00+08:00`)
  const target = new Date(`${String(value).slice(0, 10)}T00:00:00+08:00`)
  return Math.round((target - today) / 86400000)
}

export function forecastLabel(days) {
  if (days === null || days === undefined) return 'Insufficient data'
  if (days < 0) return `${Math.abs(days)}d overdue`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `${days} days`
}

export function statusLabel(status) {
  return {
    in_service: 'In service', maintenance: 'Maintenance', idle: 'Idle reserve', faulty: 'Faulty',
    proposed: 'Proposed', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled',
    active: 'Active', withdrawn: 'Withdrawn', planned: 'Planned',
  }[status] || status || 'Unknown'
}

export function cycleLabel(cycle) {
  return Number(cycle) >= 1000 ? `${Number(cycle) / 1000}K` : String(cycle)
}

export function qualityLabel(hdop) {
  if (hdop === null || hdop === undefined) return { label: 'No fix', tone: 'muted' }
  if (Number(hdop) < 1) return { label: 'Strong', tone: 'success' }
  if (Number(hdop) < 2) return { label: 'Fair', tone: 'warning' }
  return { label: 'Weak', tone: 'danger' }
}
