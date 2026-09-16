import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import mqtt from 'mqtt'
import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'node:url'

export const SIM_SEQUENCE_START = 950_000_000
const SEGMENTS = [
  ['SIM_SK_A_B', 720], ['SIM_SK_B_C', 690], ['SIM_SK_C_D', 810],
  ['SIM_SK_D_E', 760], ['SIM_SK_E_F', 780], ['SIM_SK_F_A', 740],
]
const SEEDED_ODOMETER_OVERRIDES = {
  D07: 128473.9, D09: 142880.3, D12: 167220.4,
  D18: 212480.0, D21: 156680.0, D23: 186300.0,
}
const VALID_SCENARIOS = new Set(['normal', 'mixed_quality', 'weak_gnss'])

function seededOdometer(lrvId) {
  if (SEEDED_ODOMETER_OVERRIDES[lrvId] !== undefined) return SEEDED_ODOMETER_OVERRIDES[lrvId]
  const number = Number(lrvId.replace(/\D/g, '')) || 1
  return Math.round((52_000 + number * 5_321.7 + (number % 4) * 8_100) * 10) / 10
}

export function createInitialVehicleState(lrvId) {
  return { seq: SIM_SEQUENCE_START, segmentIndex: 0, odoKm: seededOdometer(lrvId) }
}

export function buildNextEvent(lrvId, state, options = {}) {
  const scenario = options.scenario || 'normal'
  const speed = Number(options.speed ?? 1)
  if (!VALID_SCENARIOS.has(scenario)) throw new Error(`SIM_SCENARIO must be one of ${[...VALID_SCENARIOS].join(', ')}`)
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('SIM_SPEED must be a finite number greater than zero')

  const [seg, distanceM] = SEGMENTS[Number(state.segmentIndex) % SEGMENTS.length]
  const nextState = {
    seq: Math.max(SIM_SEQUENCE_START, Number(state.seq)) + 1,
    segmentIndex: (Number(state.segmentIndex) + 1) % SEGMENTS.length,
    odoKm: Math.round((Number(state.odoKm) + distanceM / 1000) * 1000) / 1000,
  }
  const weak = scenario === 'weak_gnss' || (scenario === 'mixed_quality' && nextState.seq % 5 === 0)
  const event = {
    v: 1, lrv: lrvId, seq: nextState.seq, t: Math.floor(Date.now() / 1000),
    ev: 'SEG_DONE', seg, dir: Math.floor(nextState.seq / SEGMENTS.length) % 2 ? 'W' : 'E',
    d_m: distanceM, odo_km: nextState.odoKm, hdop: weak ? 2.8 : 0.9,
    nsv: weak ? 7 : 19, dwell_s: Math.max(1, Math.round(80 / speed)),
  }
  return { event, nextState }
}

export function loadState(statePath, vehicles) {
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  return Object.fromEntries(vehicles.map((lrvId) => [lrvId, saved[lrvId] || createInitialVehicleState(lrvId)]))
}

export function mergeRemoteState(localState, remoteState) {
  const merged = structuredClone(localState)
  for (const [lrvId, remote] of Object.entries(remoteState)) {
    if (!merged[lrvId]) merged[lrvId] = createInitialVehicleState(lrvId)
    if (Number.isFinite(Number(remote.seq)) && Number(remote.seq) > Number(merged[lrvId].seq)) {
      merged[lrvId].seq = Number(remote.seq)
      if (Number.isFinite(Number(remote.segmentIndex))) merged[lrvId].segmentIndex = Number(remote.segmentIndex) % SEGMENTS.length
    }
    if (Number.isFinite(Number(remote.odoKm))) merged[lrvId].odoKm = Math.max(Number(merged[lrvId].odoKm), Number(remote.odoKm))
  }
  return merged
}

export function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const temporary = `${statePath}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(temporary, statePath)
}

async function loadRemoteState(environment, vehicles) {
  if (!environment.SUPABASE_URL || !environment.SUPABASE_SERVICE_ROLE_KEY) return {}
  const supabase = createClient(environment.SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const entries = await Promise.all(vehicles.map(async (lrvId) => {
    const [latest, simulated] = await Promise.all([
      supabase.from('segment_traversals').select('odo_km').eq('lrv_id', lrvId).lte('ts', new Date(Date.now() + 10 * 60_000).toISOString()).order('ts', { ascending: false }).limit(1),
      supabase.from('segment_traversals').select('seq').eq('lrv_id', lrvId).gte('seq', SIM_SEQUENCE_START).order('seq', { ascending: false }).limit(1),
    ])
    if (latest.error) throw new Error(`cannot read latest odometer for ${lrvId}: ${latest.error.message}`)
    if (simulated.error) throw new Error(`cannot read simulator sequence for ${lrvId}: ${simulated.error.message}`)
    const seq = Number(simulated.data?.[0]?.seq)
    return [lrvId, {
      odoKm: latest.data?.[0]?.odo_km,
      seq: Number.isFinite(seq) ? seq : undefined,
      segmentIndex: Number.isFinite(seq) ? (seq - SIM_SEQUENCE_START) % SEGMENTS.length : undefined,
    }]
  }))
  return Object.fromEntries(entries)
}

function readConfiguration(environment) {
  const vehicles = (environment.SIM_VEHICLES || 'D07,D08,D12,D23').split(',').map((value) => value.trim()).filter(Boolean)
  const baseIntervalMs = Number(environment.SIM_INTERVAL_MS || 1500)
  const speed = Number(environment.SIM_SPEED || 1)
  const scenario = environment.SIM_SCENARIO || 'normal'
  if (!vehicles.length || vehicles.some((value) => !/^[A-Z][A-Z0-9_-]{0,31}$/.test(value))) throw new Error('SIM_VEHICLES must contain at least one valid comma-separated vehicle ID')
  if (!Number.isFinite(baseIntervalMs) || baseIntervalMs < 250) throw new Error('SIM_INTERVAL_MS must be a finite number of at least 250')
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('SIM_SPEED must be a finite number greater than zero')
  if (!VALID_SCENARIOS.has(scenario)) throw new Error(`SIM_SCENARIO must be one of ${[...VALID_SCENARIOS].join(', ')}`)
  return { vehicles, speed, scenario, intervalMs: Math.max(100, Math.round(baseIntervalMs / speed)) }
}

export async function runSimulator(environment = process.env) {
  const broker = environment.MQTT_URL || 'mqtt://test.mosquitto.org:1883'
  const { vehicles, speed, scenario, intervalMs } = readConfiguration(environment)
  const statePath = path.resolve(environment.SIM_STATE_PATH || './.simulator-state.json')
  const localState = loadState(statePath, vehicles)
  const remoteState = await loadRemoteState(environment, vehicles)
  const state = mergeRemoteState(localState, remoteState)
  saveState(statePath, state)

  const connection = mqtt.connect(broker, {
    username: environment.MQTT_USERNAME || undefined,
    password: environment.MQTT_PASSWORD || undefined,
    reconnectPeriod: 2000,
    clean: true,
    clientId: `railtech-simulator-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  })
  await new Promise((resolve, reject) => {
    connection.once('connect', resolve)
    connection.once('error', reject)
  })
  console.log(`[simulator] connected; ${vehicles.join(', ')} every ${intervalMs} ms (${speed}x rate)`)

  let vehicleIndex = 0
  const publishNext = () => {
    const lrvId = vehicles[vehicleIndex % vehicles.length]
    vehicleIndex += 1
    const { event, nextState } = buildNextEvent(lrvId, state[lrvId], { scenario, speed })
    connection.publish(`lrv/splrt/${lrvId}/events`, JSON.stringify(event), { qos: 1 }, (error) => {
      if (error) return console.error(`[simulator] publish failed: ${error.message}`)
      state[lrvId] = nextState
      saveState(statePath, state)
      console.log(`[simulator] ${lrvId} seq=${event.seq} ${event.seg} +${event.d_m}m odo=${event.odo_km}`)
    })
  }
  publishNext()
  const timer = setInterval(publishNext, intervalMs)
  const stop = () => { clearInterval(timer); connection.end(false, () => process.exit(0)) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) runSimulator().catch((error) => { console.error(`[simulator] ${error.message}`); process.exitCode = 1 })
