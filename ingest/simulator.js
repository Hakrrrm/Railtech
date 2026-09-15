import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import mqtt from 'mqtt'
import { fileURLToPath } from 'node:url'

export const SIM_SEQUENCE_START = 950_000_000
const segments = [
  ['SIM_SK_A_B', 720], ['SIM_SK_B_C', 690], ['SIM_SK_C_D', 810],
  ['SIM_SK_D_E', 760], ['SIM_SK_E_F', 780], ['SIM_SK_F_A', 740],
]
const defaultOdometers = { D07: 128473.9, D08: 102286.4, D09: 142880.3, D12: 167220.4, D23: 186300.0 }

export function createInitialVehicleState(lrvId) {
  return { seq: SIM_SEQUENCE_START, segmentIndex: 0, odoKm: defaultOdometers[lrvId] || 50_000 + Number(lrvId.replace(/\D/g, '') || 1) * 5_321.7 }
}

export function buildNextEvent(lrvId, state, options = {}) {
  const scenario = options.scenario || 'normal'
  const speed = Math.max(0.1, Number(options.speed || 1))
  const [seg, baseLength] = segments[state.segmentIndex % segments.length]
  const distanceM = Math.round(baseLength * speed * 10) / 10
  const nextState = {
    seq: Math.max(SIM_SEQUENCE_START, Number(state.seq)) + 1,
    segmentIndex: (Number(state.segmentIndex) + 1) % segments.length,
    odoKm: Math.round((Number(state.odoKm) + distanceM / 1000) * 1000) / 1000,
  }
  const weak = scenario === 'weak_gnss' || (scenario === 'mixed_quality' && nextState.seq % 5 === 0)
  const event = {
    v: 1, lrv: lrvId, seq: nextState.seq, t: Math.floor(Date.now() / 1000),
    ev: 'SEG_DONE', seg, dir: Math.floor(nextState.seq / segments.length) % 2 ? 'W' : 'E',
    d_m: distanceM, odo_km: nextState.odoKm, hdop: weak ? 2.8 : 0.9,
    nsv: weak ? 7 : 19, dwell_s: Math.round(80 / speed),
  }
  return { event, nextState }
}

export function loadState(statePath, vehicles) {
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return Object.fromEntries(vehicles.map((lrvId) => [lrvId, saved[lrvId] || createInitialVehicleState(lrvId)]))
}

export function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const temporary = `${statePath}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(temporary, statePath)
}

export async function runSimulator(environment = process.env) {
  const broker = environment.MQTT_URL || 'mqtt://test.mosquitto.org:1883'
  const vehicles = (environment.SIM_VEHICLES || 'D07,D08,D12,D23').split(',').map((value) => value.trim()).filter(Boolean)
  const intervalMs = Math.max(250, Number(environment.SIM_INTERVAL_MS || 1500))
  const scenario = environment.SIM_SCENARIO || 'normal'
  const speed = Number(environment.SIM_SPEED || 1)
  const statePath = path.resolve(environment.SIM_STATE_PATH || './.simulator-state.json')
  const state = loadState(statePath, vehicles)
  const connection = mqtt.connect(broker, {
    username: environment.MQTT_USERNAME || undefined,
    password: environment.MQTT_PASSWORD || undefined,
    reconnectPeriod: 2000,
  })

  await new Promise((resolve, reject) => {
    connection.once('connect', resolve)
    connection.once('error', reject)
  })
  console.log(`[simulator] connected to ${broker}; ${vehicles.join(', ')} every ${intervalMs} ms`)

  let vehicleIndex = 0
  const publishNext = () => {
    const lrvId = vehicles[vehicleIndex % vehicles.length]
    vehicleIndex += 1
    const { event, nextState } = buildNextEvent(lrvId, state[lrvId], { scenario, speed })
    connection.publish(`lrv/splrt/${lrvId}/events`, JSON.stringify(event), { qos: 0 }, (error) => {
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
