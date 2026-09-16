// MQTT -> Supabase ingest bridge. Database uniqueness on (lrv_id, seq) is
// the final idempotency boundary; this process adds validation, bounded
// retries and per-vehicle ordering before rows reach that boundary.

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import mqtt from 'mqtt'
import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'node:url'
import { parseEvent, parseEventTopic } from './event_mapper.js'

const EVENTS_TOPIC = 'lrv/+/+/events'

export function appendDeadLetter(filePath, reason, raw, topic) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), topic, reason, raw })
  try {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true })
    fs.appendFileSync(filePath, `${entry}\n`, 'utf8')
  } catch (error) {
    console.error(`FAILED TO WRITE DEAD LETTER LOG: ${error.message}`)
  }
  console.warn(`[dead-letter] ${reason} (topic=${topic})`)
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function upsertWithRetry(supabase, row, options = {}) {
  const attempts = options.attempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 250
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { error } = await supabase
      .from('segment_traversals')
      .upsert(row, { onConflict: 'lrv_id,seq', ignoreDuplicates: true })
    if (!error) return
    lastError = error
    if (attempt < attempts) await wait(baseDelayMs * (2 ** (attempt - 1)))
  }
  throw new Error(lastError?.message || 'unknown Supabase insert failure')
}

export function createMessageHandler({ supabase, deadLetterPath, nowMs = () => Date.now() }) {
  return async function handleMessage(topic, payload) {
    const parsed = parseEvent(payload, { topic, nowMs: nowMs() })
    if (!parsed.ok) {
      appendDeadLetter(deadLetterPath, parsed.reason, parsed.raw, topic)
      return { status: 'rejected', reason: parsed.reason }
    }
    if (parsed.row === null) return { status: 'ignored' }

    try {
      await upsertWithRetry(supabase, parsed.row)
      console.log(`[ingested] ${parsed.row.lrv_id} seq=${parsed.row.seq} seg=${parsed.row.seg_id}`)
      return { status: 'ingested', row: parsed.row }
    } catch (error) {
      appendDeadLetter(deadLetterPath, `insert failed after retries: ${error.message}`, JSON.stringify(parsed.row), topic)
      return { status: 'rejected', reason: error.message }
    }
  }
}

function safeBrokerLabel(value) {
  try {
    const parsed = new URL(value)
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
  } catch {
    return '[configured broker]'
  }
}

export function runBridge(environment = process.env) {
  const mqttUrl = environment.MQTT_URL
  const supabaseUrl = environment.SUPABASE_URL
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY
  const deadLetterPath = environment.DEAD_LETTER_PATH || './dead_letter.ndjson'
  for (const [name, value] of Object.entries({ MQTT_URL: mqttUrl, SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey })) {
    if (!value) throw new Error(`environment variable ${name} is required (see .env.example)`)
  }
  if (String(mqttUrl).startsWith('mqtt://')) {
    console.warn('[security] MQTT transport is unencrypted; use mqtts:// with credentials outside local/demo testing')
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  const handleMessage = createMessageHandler({ supabase, deadLetterPath })
  const queues = new Map()
  const client = mqtt.connect(mqttUrl, {
    username: environment.MQTT_USERNAME || undefined,
    password: environment.MQTT_PASSWORD || undefined,
    reconnectPeriod: 2000,
    clean: true,
    clientId: `railtech-ingest-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  })

  const enqueue = (topic, payload) => {
    const queueKey = parseEventTopic(topic)?.lrvId || topic
    const previous = queues.get(queueKey) || Promise.resolve()
    const current = previous
      .then(() => handleMessage(topic, payload))
      .catch((error) => appendDeadLetter(deadLetterPath, `unexpected error: ${error.message}`, payload.toString('utf8'), topic))
      .finally(() => { if (queues.get(queueKey) === current) queues.delete(queueKey) })
    queues.set(queueKey, current)
  }

  client.on('connect', () => {
    console.log(`connected to ${safeBrokerLabel(mqttUrl)}, subscribing ${EVENTS_TOPIC}`)
    client.subscribe(EVENTS_TOPIC, { qos: 1 }, (error) => {
      if (error) console.error(`subscribe failed: ${error.message}; MQTT client will reconnect`)
    })
  })
  client.on('message', enqueue)
  client.on('error', (error) => console.error(`mqtt error: ${error.message}`))
  client.on('reconnect', () => console.log('mqtt reconnecting...'))
  return { client, pending: queues }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try { runBridge() } catch (error) { console.error(`FATAL: ${error.message}`); process.exitCode = 1 }
}
