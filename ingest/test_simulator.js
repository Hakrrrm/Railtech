import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildNextEvent, createInitialVehicleState, loadState, mergeRemoteState, saveState, SIM_SEQUENCE_START } from './simulator.js'
import { parseEvent } from './event_mapper.js'

const first = createInitialVehicleState('D07')
const built = buildNextEvent('D07', first, { speed: 1, scenario: 'normal' })
assert.equal(built.event.ev, 'SEG_DONE')
assert.equal(built.event.seq, SIM_SEQUENCE_START + 1)
assert.equal(built.nextState.odoKm, first.odoKm + built.event.d_m / 1000)
assert.equal(parseEvent(JSON.stringify(built.event)).ok, true)

const weak = buildNextEvent('D09', first, { scenario: 'weak_gnss' })
assert.ok(weak.event.hdop >= 2)
assert.ok(weak.event.nsv > 0)

const faster = buildNextEvent('D07', first, { speed: 4 })
assert.equal(faster.event.d_m, built.event.d_m, 'speed changes cadence, not calibrated segment length')
assert.ok(faster.event.dwell_s < built.event.dwell_s)
assert.equal(createInitialVehicleState('D08').odoKm, 94573.6, 'defaults match the deterministic SQL seed')
assert.throws(() => buildNextEvent('D07', first, { speed: Number.NaN }), /SIM_SPEED/)

const reconciled = mergeRemoteState({ D07: first }, { D07: { seq: SIM_SEQUENCE_START + 20, odoKm: first.odoKm + 10, segmentIndex: 2 } })
assert.equal(reconciled.D07.seq, SIM_SEQUENCE_START + 20)
assert.equal(reconciled.D07.odoKm, first.odoKm + 10)
assert.equal(reconciled.D07.segmentIndex, 2)

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'railtech-sim-'))
const statePath = path.join(folder, 'state.json')
saveState(statePath, { D07: built.nextState })
assert.deepEqual(loadState(statePath, ['D07']).D07, built.nextState)
assert.equal(loadState(statePath, ['D07', 'D23']).D23.seq, SIM_SEQUENCE_START)
fs.rmSync(folder, { recursive: true })

console.log('simulator tests passed')
