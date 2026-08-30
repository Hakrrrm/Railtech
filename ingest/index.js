// Thin MQTT -> Supabase ingest bridge (Build Plan Sec 8).
//
// Subscribes to lrv/+/+/events, maps each Tier 1 SEG_DONE payload to a
// segment_traversals row, and upserts it with ignoreDuplicates so a
// duplicate delivery (QoS 1 redelivery, SD backlog replay, manual
// reprocess) is a silent no-op -- the DB's unique(lrv_id, seq) constraint
// is the single source of idempotency (TDD Sec 5.6/5.7).
//
// Malformed JSON, and any insert error other than "already exists" (e.g.
// an unknown lrv_id rejected by the FK -- desirable per Build Plan Sec 8),
// goes to a dead-letter ndjson log. The bridge never crashes on bad input:
// it is stateless and restart-safe by construction, because the DB holds
// all state.

import "dotenv/config";
import fs from "node:fs";
import mqtt from "mqtt";
import { createClient } from "@supabase/supabase-js";
import { parseEvent } from "./event_mapper.js";

const MQTT_URL = process.env.MQTT_URL; // e.g. mqtts://host:8883 or mqtt://host:1883
const MQTT_USERNAME = process.env.MQTT_USERNAME || undefined;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || undefined;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEAD_LETTER_PATH = process.env.DEAD_LETTER_PATH || "./dead_letter.ndjson";
const EVENTS_TOPIC = "lrv/+/+/events";

for (const [name, val] of Object.entries({ MQTT_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!val) {
    console.error(`FATAL: environment variable ${name} is required (see .env.example)`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function deadLetter(reason, raw, topic) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(), topic, reason, raw,
  });
  fs.appendFile(DEAD_LETTER_PATH, entry + "\n", (err) => {
    if (err) {
      // Last resort: nothing else we can do without risking a crash loop.
      console.error(`FAILED TO WRITE DEAD LETTER LOG: ${err.message}; entry was: ${entry}`);
    }
  });
  console.warn(`[dead-letter] ${reason} (topic=${topic})`);
}

async function handleMessage(topic, payload) {
  const parsed = parseEvent(payload);

  if (!parsed.ok) {
    deadLetter(parsed.reason, parsed.raw, topic);
    return;
  }
  if (parsed.row === null) {
    return; // valid, understood, nothing to ingest (e.g. non-SEG_DONE event)
  }

  const { error } = await supabase
    .from("segment_traversals")
    .upsert(parsed.row, { onConflict: "lrv_id,seq", ignoreDuplicates: true });

  if (error) {
    // Includes the FK rejection for an unseeded vehicle -- desirable per
    // Build Plan Sec 8, but still needs to be visible, not silently lost.
    deadLetter(`insert failed: ${error.message}`, JSON.stringify(parsed.row), topic);
    return;
  }

  console.log(`[ingested] ${parsed.row.lrv_id} seq=${parsed.row.seq} seg=${parsed.row.seg_id}`);
}

function main() {
  const client = mqtt.connect(MQTT_URL, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    reconnectPeriod: 2000,
  });

  client.on("connect", () => {
    console.log(`connected to ${MQTT_URL}, subscribing ${EVENTS_TOPIC}`);
    client.subscribe(EVENTS_TOPIC, { qos: 1 }, (err) => {
      if (err) {
        console.error(`FATAL: subscribe failed: ${err.message}`);
        process.exit(1);
      }
    });
  });

  client.on("message", (topic, payload) => {
    handleMessage(topic, payload).catch((e) => {
      // Should be unreachable (handleMessage catches its own errors via
      // parseEvent/supabase error objects), but the bridge must never die.
      deadLetter(`unexpected error: ${e.message}`, payload.toString("utf-8"), topic);
    });
  });

  client.on("error", (err) => {
    console.error(`mqtt error: ${err.message}`);
  });

  client.on("reconnect", () => {
    console.log("mqtt reconnecting...");
  });
}

main();
