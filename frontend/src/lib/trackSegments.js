import segments from './trackSegments.json'

// Station metadata mirrors track.geojson. Keep source IDs (including its
// 'Senkang' spelling) intact for matching real GNSS packets.
const legacy = ['SIM_SK_A_B', 'SIM_SK_B_C', 'SIM_SK_C_D', 'SIM_SK_D_E', 'SIM_SK_E_F', 'SIM_SK_F_A']
const outer = segments.filter(segment => segment.loop.endsWith('Outer')).sort((a, b) => a.order - b.order)

export function resolveSegment(id, direction) {
  const exact = segments.find(segment => segment.seg_id === id)
  if (exact) return exact
  // Display-only compatibility for existing synthetic packets. Never rewrite
  // telemetry, odometers or V18's OCR test evidence to relabel the demo route.
  const pair = outer[legacy.indexOf(id)]
  if (!pair) return null
  return direction === 'W' ? segments.find(segment => segment.from === pair.to && segment.to === pair.from) : pair
}

export function segmentLabel(id, direction) {
  const segment = resolveSegment(id, direction)
  return segment ? `${segment.from} → ${segment.to}` : id || 'No position'
}

export function segmentDirection(id, direction) {
  const segment = resolveSegment(id, direction)
  return segment ? `East loop · ${segment.loop.endsWith('Inner') ? 'Inner' : 'Outer'}` : direction || 'Direction unavailable'
}

export function routeForSegment(id, direction) {
  const loop = resolveSegment(id, direction)?.loop || outer[0].loop
  return segments.filter(segment => segment.loop === loop).sort((a, b) => a.order - b.order)
}
