import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DataBoundary, MetricCard, Progress } from './UI'

describe('shared dashboard states', () => {
  it('renders a useful database error instead of zero-value cards', () => {
    const html = renderToStaticMarkup(<DataBoundary error="Cycle forecasts: relation missing" onRetry={() => {}}>hidden</DataBoundary>)
    expect(html).toContain('Dashboard data is unavailable')
    expect(html).toContain('Cycle forecasts: relation missing')
    expect(html).not.toContain('>hidden<')
  })

  it('renders metric context and clamps progress', () => {
    const metric = renderToStaticMarkup(<MetricCard label="Mileage today" value="42 km" detail="Live from completed segments"/>)
    const progress = renderToStaticMarkup(<Progress value={140}/>)
    expect(metric).toContain('Mileage today')
    expect(metric).toContain('Live from completed segments')
    expect(progress).toContain('width:100%')
  })
})
