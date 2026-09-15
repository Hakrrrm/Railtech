import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildNextEvent, createInitialVehicleState, loadState, saveState, SIM_SEQUENCE_START } from './simulator.js'
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

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'railtech-sim-'))
const statePath = path.join(folder, 'state.json')
saveState(statePath, { D07: built.nextState })
assert.deepEqual(loadState(statePath, ['D07']).D07, built.nextState)
assert.equal(loadState(statePath, ['D07', 'D23']).D23.seq, SIM_SEQUENCE_START)
fs.rmSync(folder, { recursive: true })

console.log('simulator tests passed')
