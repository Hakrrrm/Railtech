// Optional network smoke test for the same broker/topic/payload path used by
// the simulator and firmware. Run explicitly with: npm run test:mqtt

import 'dotenv/config'
import assert from 'node:assert/strict'
import mqtt from 'mqtt'
import { buildNextEvent, createInitialVehicleState } from './simulator.js'
import { parseEvent } from './event_mapper.js'

const broker = process.env.MQTT_URL || 'mqtt://test.mosquitto.org:1883'
const fleet = `audit${Date.now()}`
const topic = `lrv/${fleet}/D07/events`
const client = mqtt.connect(broker, {
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
  reconnectPeriod: 0,
  clean: true,
  clientId: `railtech-audit-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
})

const timeout = setTimeout(() => {
  client.end(true)
  console.error('MQTT round-trip timed out')
  process.exitCode = 1
}, 15_000)

client.once('connect', () => {
  client.subscribe(topic, { qos: 1 }, (error) => {
    if (error) throw error
    const { event } = buildNextEvent('D07', createInitialVehicleState('D07'))
    client.publish(topic, JSON.stringify(event), { qos: 1 })
  })
})

client.once('message', (receivedTopic, payload) => {
  const parsed = parseEvent(payload, { topic: receivedTopic })
  assert.equal(receivedTopic, topic)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.row.lrv_id, 'D07')
  clearTimeout(timeout)
  console.log('MQTT round-trip passed: simulator payload survived broker transport and ingest validation')
  client.end()
})

client.once('error', (error) => {
  clearTimeout(timeout)
  console.error(`MQTT round-trip failed: ${error.message}`)
  process.exitCode = 1
})
