import { describe, expect, it } from 'vitest'
import { cycleLabel, forecastLabel, formatDuration, formatKm, qualityLabel, statusLabel } from './format'

describe('operator-facing formatting', () => {
  it('translates distances and cycles into scan-friendly labels', () => {
    expect(formatKm(128473.94, 1)).toBe('128,473.9 km')
    expect(cycleLabel(40000)).toBe('40K')
  })

  it('prioritises days and makes missing forecasts explicit', () => {
    expect(forecastLabel(null)).toBe('Insufficient data')
    expect(forecastLabel(-3)).toBe('3d overdue')
    expect(forecastLabel(1)).toBe('Due tomorrow')
  })

  it('maps database slugs and GNSS quality to display values', () => {
    expect(statusLabel('in_service')).toBe('In service')
    expect(qualityLabel(0.8).label).toBe('Strong')
    expect(qualityLabel(2.5).tone).toBe('danger')
  })

  it('renders LTA maintenance occupancy in operator-friendly units', () => {
    expect(formatDuration(120)).toBe('2 hours')
    expect(formatDuration(1440)).toBe('1 day')
    expect(formatDuration(30240)).toBe('21 days')
    expect(statusLabel('partially_completed')).toBe('Partially completed')
  })
})
