# Railtech — LRV Mileage Tracking

Telemetry firmware and cloud ingest path for an IoT LRV mileage-tracking
prototype (SGRTGC 2026 Open Innovation Challenge). Companion documents:
`Prototype_Development_Plan_v3.0`, `TDD_LRV_Mileage_Tracking_v1.2`,
`Firmware_Cloud_Build_Plan_v1.0`.

## Repository layout

```
firmware/
  src/              pure-logic modules -- compile for host (gcc) and target (PlatformIO) alike
                     (event_serializer, seq_store, gnss_parser, map_matcher, imu_state;
                     track_types.h is the shared type-only header track_data.h #includes;
                     imu_mpu6050.* is target-only, no host-testable logic there)
  test/             plain-C, assert-based host test programs, one per module
  config.example.h  documents every config.h field (WiFi, MQTT, LRV id, IMU_ENABLED); copy to
                     config.h (gitignored)
  pins_board.h      modem UART/power/GNSS/SD/Qwiic-I2C pin assignments, each cited to its source
                     (LilyGo reference sketches / user-confirmed schematic trace) in its own comments
  harness/
    stage3/         Stage 3 Wi-Fi hotspot harness, also doing Stage 6 SD store-and-forward
                     logging (one running /lrv_log/events.ndjson, appended to across every boot)
    stage5/         Stage 5: real GNSS (direct AT+CGNSSINFO, 1 Hz) + map matcher + optional
                     IMU stationary gate. Serial + SD only, no Wi-Fi/MQTT (deferred to Stage 7)
tools/
  track_pipeline.py       GeoJSON + loop_lengths.csv -> segments.csv + track_data.h
  test_track_pipeline.py  self-tests (synthetic fixture, one violation per rule)
supabase/
  schema.sql          core tables (Build Plan Sec 8, TDD Sec 5.8)
  seed.example.sql    example vehicle seed rows
ingest/
  event_mapper.js     pure Tier 1 JSON -> segment_traversals row mapping (host-testable)
  index.js            MQTT -> Supabase bridge wiring
  test_index.js       host tests for event_mapper.js
  .env.example        documents every required env var; copy to .env (gitignored)
platformio.ini      PlatformIO project config -- src_dir is project-global, so every harness
                     stage lives under firmware/harness/<stage>/ with a per-env build_src_filter
                     selecting just its own subfolder
run_tests.sh        builds and runs the full host test suite; keep green at all times
```

## Running tests

```
./run_tests.sh
```

Host tests cover the pure-logic modules only. The target builds
(`pio run -e stage3-wifi-hotspot` / `-e stage5-gnss-matcher`) additionally
need `firmware/config.h` (copy from `firmware/config.example.h`) and
PlatformIO's ESP32 platform package, which requires network access to
PlatformIO's registry. `stage5-gnss-matcher` also needs a real
`firmware/src/track_data.h`, generated per the next section -- it is
intentionally not committed as a placeholder.

## Regenerating the track dataset

Whenever `track.geojson` or `loop_lengths.csv` changes, regenerate
`segments.csv` and `track_data.h` -- a stale header is the silent failure
mode the build plan calls out (Sec 10):

```
python3 tools/track_pipeline.py \
    --geojson track.geojson \
    --loop-lengths loop_lengths.csv \
    --out-dir firmware/src/ \
    [--loop-name NAME]   # required only for Option B (raw/unsegmented trace) input
```

The pipeline fails loudly (non-zero exit, specific `ERROR:` message naming
the offending seg_id/coordinates) on every dataset rule violation in Build
Plan Sec 4.2 -- see `tools/test_track_pipeline.py` for one worked example
of each. The generated `track_data.h` `#include`s the committed
`firmware/src/track_types.h` for its struct types rather than redefining
them, so `map_matcher.c` (and its host tests) can operate on the same
types without depending on any one generated dataset.

### Uploading your own track data

Drop your GeoJSON + loop-lengths CSV anywhere in the repo (the project
root, alongside `track.dummy.geojson`/`loop_lengths.dummy.csv`, is the
usual spot) -- `--geojson`/`--loop-lengths` take any path, so your own
filenames (e.g. `Track_sections.geojson`, `Loop_length.csv`) work as-is,
no renaming required. Just point the two flags at whatever you uploaded:

```
python3 tools/track_pipeline.py \
    --geojson Track_sections.geojson \
    --loop-lengths Loop_length.csv \
    --out-dir firmware/src/
```

Two names you *can't* change: the pipeline always writes its output as
`firmware/src/segments.csv` and `firmware/src/track_data.h` (fixed by
`--out-dir` + hardcoded basenames in `track_pipeline.py`), and
`firmware/harness/stage5/main_gnss_matcher.cpp` `#include`s
`track_data.h` by that exact name -- so every run simply overwrites
whatever track dataset was committed there before, regardless of what
you named your input files.

## Supabase / ingest bridge setup (NOTES)

1. Create a Supabase project, run `supabase/schema.sql` in the SQL editor.
2. Copy `supabase/seed.example.sql`, adjust `lrv_id` values to match your
   devices' `config.h` `MQTT_LRV_ID`/`MQTT_FLEET`, run it -- the FK on
   `segment_traversals` rejects events for any vehicle not seeded here
   (intentional).
3. `cd ingest && npm install && cp .env.example .env` and fill in
   `MQTT_URL` and `SUPABASE_SERVICE_ROLE_KEY` (service-role key only --
   never put it on the device).
4. `npm start`.

## Supabase / ingest bridge setup (DETAILS)
Supabase Password: kZoJXfkKlq87mGea

## Build stages

See `Firmware_Cloud_Build_Plan_v1.0` for the authoritative stage order and
manual test gates. Each stage lives on its own branch and merges to `main`
only after its host tests pass and its manual test gate has been run.
