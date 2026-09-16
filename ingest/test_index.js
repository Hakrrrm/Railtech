// Host tests for event_mapper.js. Plain assert-based, no framework, no
// network -- runs the same way as the firmware C and pipeline Python
// tests. Run: node ingest/test_index.js

import assert from "node:assert/strict";
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEvent, parseEventTopic } from './event_mapper.js'
import { createMessageHandler, upsertWithRetry } from './index.js'

function referencePayload(overrides = {}) {
  return JSON.stringify({
    v: 1, lrv: "D07", seq: 48213, t: 1785560670, ev: "SEG_DONE",
    seg: "PE3_PE4_E", dir: "E", d_m: 612.4, odo_km: 128473.9,
    hdop: 1.4, nsv: 19, dwell_s: 47, ...overrides,
  });
}

function test_valid_seg_done_maps_to_row() {
  const result = parseEvent(referencePayload());
  assert.equal(result.ok, true);
  assert.deepEqual(result.row, {
    lrv_id: "D07", seq: 48213, seg_id: "PE3_PE4_E",
    ts: new Date(1785560670 * 1000).toISOString(),
    length_m: 612.4, dir: "E", odo_km: 128473.9, confidence: null, hdop: 1.4,
  });
  console.log("[ok] valid SEG_DONE payload maps to a segment_traversals row");
}

function test_accepts_buffer_payload() {
  const result = parseEvent(Buffer.from(referencePayload(), "utf-8"));
  assert.equal(result.ok, true);
  assert.equal(result.row.lrv_id, "D07");
  console.log("[ok] Buffer payload (as delivered by mqtt.js) parses the same as a string");
}

function test_non_seg_done_event_ignored_not_dead_lettered() {
  const result = parseEvent(JSON.stringify({ v: 1, lrv: 'D07', ev: 'HEARTBEAT' }));
  assert.equal(result.ok, true);
  assert.equal(result.row, null);
  console.log("[ok] a valid but unhandled event type is ignored, not dead-lettered");
}

function test_topic_and_payload_identity_must_match() {
  assert.deepEqual(parseEventTopic('lrv/splrt/D07/events'), { fleet: 'splrt', lrvId: 'D07' })
  assert.equal(parseEventTopic('lrv/splrt/D07/debug'), null)
  const result = parseEvent(referencePayload(), { topic: 'lrv/splrt/D08/events' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /does not match/)
  console.log('[ok] topic and payload vehicle identities must agree')
}

function test_numeric_ranges_are_enforced() {
  const invalid = [
    { seq: 1.5 }, { t: 1 }, { d_m: 0 }, { d_m: Number.POSITIVE_INFINITY },
    { odo_km: -1 }, { hdop: -0.1 }, { nsv: 2.5 }, { dwell_s: -1 }, { dir: 'Q' },
  ]
  invalid.forEach((override) => assert.equal(parseEvent(referencePayload(override)).ok, false, JSON.stringify(override)))
  console.log('[ok] unsafe sequence, timestamp, distance, odometer and GNSS ranges are rejected')
}

async function test_supabase_retries_and_dead_letter() {
  let attempts = 0
  const retrying = { from: () => ({ upsert: async () => ({ error: ++attempts < 3 ? { message: 'temporary' } : null }) }) }
  await upsertWithRetry(retrying, {}, { attempts: 3, baseDelayMs: 0 })
  assert.equal(attempts, 3)

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'railtech-ingest-'))
  const deadLetterPath = path.join(folder, 'dead.ndjson')
  const failing = { from: () => ({ upsert: async () => ({ error: { message: 'database unavailable' } }) }) }
  const handle = createMessageHandler({ supabase: failing, deadLetterPath, nowMs: () => Date.now() })
  const result = await handle('lrv/splrt/D07/events', referencePayload({ t: Math.floor(Date.now() / 1000) }))
  assert.equal(result.status, 'rejected')
  const entry = JSON.parse(fs.readFileSync(deadLetterPath, 'utf8').trim())
  assert.match(entry.reason, /after retries/)
  fs.rmSync(folder, { recursive: true })
  console.log('[ok] transient database errors retry and exhausted rows are durably dead-lettered')
}

function test_malformed_json_dead_lettered() {
  const result = parseEvent("{not json");
  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid JSON/);
  assert.equal(result.raw, "{not json");
  console.log("[ok] malformed JSON is rejected with the raw payload preserved");
}

function test_missing_field_rejected() {
  const obj = JSON.parse(referencePayload());
  delete obj.seq;
  const result = parseEvent(JSON.stringify(obj));
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing required field 'seq'/);
  console.log("[ok] payload missing a required field is rejected");
}

function test_wrong_type_rejected() {
  const result = parseEvent(referencePayload({ seq: "48213" })); // string, not number
  assert.equal(result.ok, false);
  assert.match(result.reason, /field 'seq' must be number/);
  console.log("[ok] payload with a wrong field type is rejected");
}

function test_unsupported_version_rejected() {
  const result = parseEvent(referencePayload({ v: 2 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /unsupported contract version/);
  console.log("[ok] unsupported contract version is rejected");
}

function test_non_object_payload_rejected() {
  for (const bad of ["[1,2,3]", "null", '"just a string"', "42"]) {
    const result = parseEvent(bad);
    assert.equal(result.ok, false, `expected rejection for ${bad}`);
  }
  console.log("[ok] non-object JSON payloads (array/null/string/number) rejected");
}

async function main() {
  test_valid_seg_done_maps_to_row();
  test_accepts_buffer_payload();
  test_non_seg_done_event_ignored_not_dead_lettered();
  test_topic_and_payload_identity_must_match();
  test_numeric_ranges_are_enforced();
  test_malformed_json_dead_lettered();
  test_missing_field_rejected();
  test_wrong_type_rejected();
  test_unsupported_version_rejected();
  test_non_object_payload_rejected();
  await test_supabase_retries_and_dead_letter();
  console.log("all tests passed");
}

await main();
