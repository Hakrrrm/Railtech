import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import catalog from './trackSegments.json'
import { resolveSegment, segmentLabel, segmentDirection, routeForSegment } from './trackSegments'

describe('Sengkang East Loop display', () => {
  it('matches the source track metadata exactly', () => {
    const track = JSON.parse(readFileSync(new URL('../../../track.geojson', import.meta.url), 'utf8'))
    expect(catalog).toEqual(track.features.map(feature => feature.properties))
  })
  it('supports every real segment and both directed loops', () => {
    for (const segment of catalog) {
      expect(resolveSegment(segment.seg_id, 'W')).toEqual(segment)
      expect(segmentLabel(segment.seg_id)).toBe(`${segment.from} → ${segment.to}`)
      expect(routeForSegment(segment.seg_id)).toHaveLength(6)
    }
  })
  it('forms continuous chronological laps in both directions', () => {
    const ids = ['SIM_SK_A_B', 'SIM_SK_B_C', 'SIM_SK_C_D', 'SIM_SK_D_E', 'SIM_SK_E_F', 'SIM_SK_F_A']
    for (const dir of ['E', 'W']) {
      const lap = ids.map(id => resolveSegment(id, dir))
      expect(lap[0].from).toBe('Sengkang')
      expect(lap.at(-1).to).toBe('Sengkang')
      lap.slice(1).forEach((segment, i) => expect(segment.from).toBe(lap[i].to))
    }
  })
  it('displays legacy demo packets without mutating their evidence', () => {
    const packet = Object.freeze({ lrv_id: 'D18', seg_id: 'SIM_SK_A_B', dir: 'W', length_m: 720, odo_km: 212480 })
    expect(segmentLabel(packet.seg_id, packet.dir)).toBe('Sengkang → Ranggung')
    expect(segmentDirection(packet.seg_id, packet.dir)).toBe('East loop · Inner')
    expect(packet.seg_id).toBe('SIM_SK_A_B')
    expect(packet.odo_km).toBe(212480)
    expect(resolveSegment('unknown')).toBeNull()
  })
})
