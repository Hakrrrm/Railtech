import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
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
