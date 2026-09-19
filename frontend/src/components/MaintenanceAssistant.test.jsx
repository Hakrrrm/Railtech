import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScheduleRow } from '../pages/MaintenancePlanning'
import { withRescheduleOverlays } from '../lib/maintenanceRescheduleView'
import { AssistantPlan, MaintenanceAssistant } from './MaintenanceAssistant'

describe('maintenance assistant operator review', () => {
  it('shows proposed dates and work without silently confirming them', () => {
    const html = renderToStaticMarkup(<AssistantPlan batch={{ status: 'proposed' }} plan={{ bookings: [{ lrvId: 'D12', bayId: 'Bay 1', workType: 'preventive', primaryCycle: 2000, startAt: '2026-09-19T01:00:00Z', endAt: '2026-09-19T03:00:00Z' }], skipped: [{ lrvId: 'D29', reason: 'No compatible bay available' }], warnings: ['Review staffing before confirmation.'] }}/>)
    expect(html).toContain('Proposed schedule')
    expect(html).toContain('09:00')
    expect(html).toContain('11:00')
    expect(html).toContain('All times SGT')
    expect(html).toContain('No compatible bay available')
    expect(html).toContain('Review staffing')
    expect(html).not.toContain('Confirmed schedule')
  })

  it('renders untrusted plan notes as text instead of executable HTML', () => {
    const html = renderToStaticMarkup(<AssistantPlan plan={{ bookings: [], warnings: ['<img src=x onerror=alert(1)>'] }}/>)
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })

  it('provides a bounded, labelled conversation and discloses operator confirmation', () => {
    const html = renderToStaticMarkup(<MaintenanceAssistant open onClose={() => {}}/>)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('maxLength="2000"')
    expect(html).toContain('GPT-4.1 mini')
    expect(html).toContain('confirm bookings separately')
    expect(html).toContain('Close maintenance assistant')
  })
})

describe('reschedule review', () => {
  const original = { id: 'existing-booking', status: 'confirmed', lrv_id: 'D24', bay_id: 'B1', start_at: '2026-09-21T05:00:00Z', end_at: '2026-09-21T09:00:00Z', primary_cycle: 13000 }
  const plan = { kind: 'reschedule', bookings: [{ bookingId: original.id, lrvId: 'D24', bayId: 'B2', startAt: original.start_at, endAt: original.end_at, primaryCycle: 13000, original: { id: original.id, bayId: 'B1', startAt: original.start_at, endAt: original.end_at } }] }
  it('preserves the green original and adds a distinct blue preview without mutating data', () => {
    const rows = withRescheduleOverlays([original], plan)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toBe(original)
    expect(rows[0].bay_id).toBe('B1')
    expect(rows[1]).toMatchObject({ status: 'proposed', bay_id: 'B2', rescheduleOverlay: true })
    expect(rows[1].id).not.toBe(original.id)
    expect(withRescheduleOverlays([original], null)).toEqual([original])
    expect(withRescheduleOverlays([{ ...original, status: 'cancelled' }], plan)).toHaveLength(1)
  })
  it('labels original and proposed locations in review and the calendar', () => {
    const review = renderToStaticMarkup(<AssistantPlan batch={{ status: 'proposed' }} plan={plan}/>)
    expect(review).toContain('Proposed reschedule')
    expect(review).toContain('Currently booked')
    expect(review).toContain('B1')
    expect(review).toContain('Move to')
    expect(review).toContain('B2')
    const calendar = renderToStaticMarkup(<ScheduleRow bay={{ bay_id: 'B2', name: 'Bay 2', opens_at: '06:00', closes_at: '23:00' }} days={['2026-09-21']} bookings={withRescheduleOverlays([original], plan)} onEdit={() => {}}/>)
    expect(calendar).toContain('booking-proposed')
    expect(calendar).toContain('Proposed move')
    expect(calendar).toContain('Review proposed move for V24')
  })
})
