// Pure logic: Tier 1 JSON (TDD Sec 5.7) -> segment_traversals row, or a
// rejection reason. No I/O here so this is host-testable without a broker
// or database.

const REQUIRED_FIELDS = {
  v: "number", lrv: "string", seq: "number", t: "number", ev: "string",
  seg: "string", dir: "string", d_m: "number", odo_km: "number",
  hdop: "number", nsv: "number", dwell_s: "number",
};

/**
 * Parses one MQTT message payload (Buffer or string) against the Tier 1
 * contract and, if it's a SEG_DONE event, maps it to a segment_traversals
 * row.
 *
 * Returns one of:
 *   { ok: true, row: {...} }                      -- insert this row
 *   { ok: true, row: null }                        -- valid but not a
 *                                                      SEG_DONE event,
 *                                                      nothing to insert
 *   { ok: false, reason: string, raw: string }      -- malformed, caller
 *                                                      must dead-letter it
 */
export function parseEvent(payload) {
  const raw = Buffer.isBuffer(payload) ? payload.toString("utf-8") : String(payload);

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${e.message}`, raw };
  }

  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, reason: "payload is not a JSON object", raw };
  }

  for (const [field, type] of Object.entries(REQUIRED_FIELDS)) {
    if (!(field in obj)) {
      return { ok: false, reason: `missing required field '${field}'`, raw };
    }
    if (typeof obj[field] !== type) {
      return { ok: false, reason: `field '${field}' must be ${type}, got ${typeof obj[field]}`, raw };
    }
  }

  if (obj.v !== 1) {
    return { ok: false, reason: `unsupported contract version v=${obj.v}`, raw };
  }

  if (obj.ev !== "SEG_DONE") {
    // A valid, understood event type this bridge doesn't ingest yet
    // (e.g. a future heartbeat/state event) -- not malformed, nothing to
    // dead-letter, just nothing to insert.
    return { ok: true, row: null };
  }

  return {
    ok: true,
    row: {
      lrv_id: obj.lrv,
      seq: obj.seq,
      seg_id: obj.seg,
      ts: new Date(obj.t * 1000).toISOString(),
      length_m: obj.d_m,
      confidence: null,
      hdop: obj.hdop,
    },
  };
}
