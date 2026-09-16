// Pure Tier 1 validation and mapping. Keeping this module free of I/O makes
// the exact boundary used by both simulated and real MQTT traffic testable.

const SEG_DONE_FIELDS = {
  seq: 'number', t: 'number', seg: 'string', dir: 'string', d_m: 'number',
  odo_km: 'number', hdop: 'number', nsv: 'number', dwell_s: 'number',
}

const MIN_EVENT_EPOCH_S = Date.UTC(2024, 0, 1) / 1000
const MAX_FUTURE_SKEW_S = 10 * 60
const UINT32_MAX = 4_294_967_295

function reject(reason, raw) {
  return { ok: false, reason, raw }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Parse lrv/<fleet>/<vehicle>/events without trusting either identifier. */
export function parseEventTopic(topic) {
  const match = /^lrv\/([a-z0-9_-]{1,32})\/([A-Z][A-Z0-9_-]{0,31})\/events$/.exec(String(topic))
  return match ? { fleet: match[1], lrvId: match[2] } : null
}

/**
 * Parse one MQTT payload. Unhandled event types only need the common
 * v/lrv/ev envelope; SEG_DONE receives the full, range-checked validation.
 */
export function parseEvent(payload, options = {}) {
  const raw = Buffer.isBuffer(payload) ? payload.toString('utf-8') : String(payload)
  let obj
  try {
    obj = JSON.parse(raw)
  } catch (error) {
    return reject(`invalid JSON: ${error.message}`, raw)
  }

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return reject('payload is not a JSON object', raw)
  }
  if (!Number.isInteger(obj.v) || obj.v !== 1) {
    return reject(`unsupported contract version v=${String(obj.v)}`, raw)
  }
  if (typeof obj.lrv !== 'string' || !/^[A-Z][A-Z0-9_-]{0,31}$/.test(obj.lrv)) {
    return reject("field 'lrv' must be a valid vehicle identifier", raw)
  }
  if (typeof obj.ev !== 'string' || obj.ev.length === 0) {
    return reject("field 'ev' must be a non-empty string", raw)
  }

  if (obj.ev !== 'SEG_DONE') return { ok: true, row: null, event: obj }

  for (const [field, type] of Object.entries(SEG_DONE_FIELDS)) {
    if (!(field in obj)) return reject(`missing required field '${field}'`, raw)
    if (typeof obj[field] !== type) {
      return reject(`field '${field}' must be ${type}, got ${typeof obj[field]}`, raw)
    }
  }

  const nowMs = options.nowMs ?? Date.now()
  const maxFutureSkewSeconds = options.maxFutureSkewSeconds ?? MAX_FUTURE_SKEW_S
  if (!Number.isInteger(obj.seq) || obj.seq < 1 || obj.seq > UINT32_MAX) {
    return reject("field 'seq' must be an unsigned 32-bit integer greater than zero", raw)
  }
  if (!Number.isInteger(obj.t) || obj.t < MIN_EVENT_EPOCH_S || obj.t > Math.floor(nowMs / 1000) + maxFutureSkewSeconds) {
    return reject("field 't' must be a plausible Unix timestamp (2024 or later, at most 10 minutes ahead)", raw)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(obj.seg)) {
    return reject("field 'seg' must be a non-empty track segment identifier", raw)
  }
  if (!['N', 'S', 'E', 'W'].includes(obj.dir)) {
    return reject("field 'dir' must be one of N, S, E, or W", raw)
  }
  if (!isFiniteNumber(obj.d_m) || obj.d_m <= 0 || obj.d_m > 20_000) {
    return reject("field 'd_m' must be finite and between 0 and 20000 metres", raw)
  }
  if (!isFiniteNumber(obj.odo_km) || obj.odo_km < 0) {
    return reject("field 'odo_km' must be a finite non-negative number", raw)
  }
  if (!isFiniteNumber(obj.hdop) || obj.hdop < 0 || obj.hdop > 99.9) {
    return reject("field 'hdop' must be finite and between 0 and 99.9", raw)
  }
  if (!Number.isInteger(obj.nsv) || obj.nsv < 0 || obj.nsv > 255) {
    return reject("field 'nsv' must be an integer between 0 and 255", raw)
  }
  if (!Number.isInteger(obj.dwell_s) || obj.dwell_s < 0 || obj.dwell_s > 86_400) {
    return reject("field 'dwell_s' must be an integer between 0 and 86400", raw)
  }

  const topic = options.topic ? parseEventTopic(options.topic) : null
  if (options.topic && !topic) return reject(`invalid event topic '${options.topic}'`, raw)
  if (topic && topic.lrvId !== obj.lrv) {
    return reject(`topic vehicle '${topic.lrvId}' does not match payload vehicle '${obj.lrv}'`, raw)
  }

  return {
    ok: true,
    event: obj,
    row: {
      lrv_id: obj.lrv,
      seq: obj.seq,
      seg_id: obj.seg,
      ts: new Date(obj.t * 1000).toISOString(),
      length_m: obj.d_m,
      dir: obj.dir,
      odo_km: obj.odo_km,
      confidence: null,
      hdop: obj.hdop,
    },
  }
}
