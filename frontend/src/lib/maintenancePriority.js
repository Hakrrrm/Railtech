const severityRank = { critical: 0, high: 1, medium: 2, low: 3 }

export function compareMaintenancePriority(left, right) {
  const tierDifference = priorityTier(left) - priorityTier(right)
  if (tierDifference) return tierDifference

  if (isCorrective(left) && isCorrective(right)) {
    const severityDifference = faultSeverity(left) - faultSeverity(right)
    if (severityDifference) return severityDifference
    const reportedDifference = timestamp(left.fault?.reported_at) - timestamp(right.fault?.reported_at)
    if (reportedDifference) return reportedDifference
  } else {
    const dateDifference = forecastTime(left) - forecastTime(right)
    if (dateDifference) return dateDifference
    const distanceDifference = maintenanceDistance(left) - maintenanceDistance(right)
    if (distanceDifference) return distanceDifference
  }

  return vehicleNumber(left) - vehicleNumber(right)
}

export function maintenancePriorityCategory(item) {
  if (isCorrective(item)) return 'fault'
  const days = nullableNumber(item.displayForecastDays ?? item.forecast_days)
  if (days === null) return null
  if (days <= 0) return 'today'
  if (days <= 7) return 'week'
  return null
}

export function matchesMaintenancePriorityFilter(item, filter) {
  if (filter === 'all') return true
  const category = maintenancePriorityCategory(item)
  if (filter === 'week') return category === 'today' || category === 'week'
  return category === filter
}

function priorityTier(item) {
  if (!isCorrective(item) && isDueNow(item)) return 0
  if (isCorrective(item)) return 1
  return 2
}

function isCorrective(item) {
  return item.work_type === 'corrective' || item.status === 'faulty' || item.priorityCategory === 'fault'
}

function isDueNow(item) {
  const distance = nullableNumber(item.km_to_next)
  const days = nullableNumber(item.displayForecastDays ?? item.forecast_days)
  return distance !== null && distance <= 0 || days !== null && days <= 0
}

function forecastTime(item) {
  if (item.forecast_date) {
    const value = Date.parse(`${String(item.forecast_date).slice(0, 10)}T00:00:00Z`)
    if (Number.isFinite(value)) return value
  }
  const days = nullableNumber(item.displayForecastDays ?? item.forecast_days)
  return days === null ? Number.POSITIVE_INFINITY : days * 86400000
}

function maintenanceDistance(item) {
  const value = nullableNumber(item.km_to_next)
  return value === null ? Number.POSITIVE_INFINITY : value
}

function faultSeverity(item) {
  return severityRank[item.fault?.severity] ?? severityRank.low
}

function timestamp(value) {
  const parsed = value ? new Date(value).getTime() : Number.POSITIVE_INFINITY
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function vehicleNumber(item) {
  const number = Number(String(item.lrv_id || '').replace(/\D/g, ''))
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER
}
