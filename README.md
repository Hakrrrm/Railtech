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
    stage5/         Stage 5/7: real GNSS (direct AT+CGNSSINFO, 1 Hz) + map matcher + optional
                     IMU stationary gate + cellular MQTT publish (Stage 7) + optional
                     DEBUG_MODE_ENABLED diagnostics -- see "Stage 7: cellular MQTT" below
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
frontend/
  src/App.jsx         React/Vite operations dashboard shell and hash routes
  src/pages/          fleet, vehicle, maintenance, deployment, evidence and settings pages
  src/lib/api.js      page-specific Supabase reads and mutation RPC calls
  .env.example        VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY; copy to .env (gitignored)
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

**bash / WSL / git-bash / Linux / macOS:**
```bash
python3 tools/track_pipeline.py \
    --geojson track.geojson \
    --loop-lengths loop_lengths.csv \
    --out-dir firmware/src/ \
    [--loop-name NAME]   # required only for Option B (raw/unsegmented trace) input
```

**Windows PowerShell** (native, not WSL -- backtick line continuation, `python` instead of `python3`):
```powershell
python tools/track_pipeline.py `
    --geojson track.geojson `
    --loop-lengths loop_lengths.csv `
    --out-dir firmware/src/
    # add --loop-name NAME only for Option B (raw/unsegmented trace) input
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

**bash / WSL / git-bash / Linux / macOS:**
```bash
python3 tools/track_pipeline.py \
    --geojson Track_sections.geojson \
    --loop-lengths Loop_length.csv \
    --out-dir firmware/src/
```

**Windows PowerShell:**
```powershell
python tools/track_pipeline.py `
    --geojson Track_sections.geojson `
    --loop-lengths Loop_length.csv `
    --out-dir firmware/src/
```

Two names you *can't* change: the pipeline always writes its output as
`firmware/src/segments.csv` and `firmware/src/track_data.h` (fixed by
`--out-dir` + hardcoded basenames in `track_pipeline.py`), and
`firmware/harness/stage5/main_gnss_matcher.cpp` `#include`s
`track_data.h` by that exact name -- so every run simply overwrites
whatever track dataset was committed there before, regardless of what
you named your input files.

## Stage 7: cellular MQTT + debug mode

`firmware/harness/stage5/main_gnss_matcher.cpp` publishes completed
segments (SEG_DONE) over the modem's onboard MQTT client once the
device has registered on LTE and connected to the broker -- best-effort
on top of the SD/Serial log, never a dependency for it (see the file's
own header comment for the full bring-up/retry design). Topics are built
from `MQTT_FLEET`/`MQTT_LRV_ID` in `config.h`; with the example values
(`splrt`/`D07`) they are:

| Topic                     | Direction        | Carries                                  |
|----------------------------|-------------------|-------------------------------------------|
| `lrv/splrt/D07/events`     | device -> broker  | SEG_DONE (Tier 1 JSON) -- always, regardless of `DEBUG_MODE_ENABLED` |
| `lrv/splrt/D07/debug`      | device -> broker  | boot diagnostics -- only if `DEBUG_MODE_ENABLED=1` |
| `lrv/splrt/D07/cmd`        | broker -> device  | commands -- only if `DEBUG_MODE_ENABLED=1` |

Any standard MQTT client works against `test.mosquitto.org:1883`
(`MQTT_HOST`/`MQTT_PORT` in `config.h`) -- an app like MQTT Explorer/MQTT
Analyzer, or `mosquitto_sub`/`mosquitto_pub` on a laptop. Subscribing and
publishing are independent actions on the same topic string: to watch
the device, subscribe to a `lrv/...` topic in your client; to send it a
command, publish to `lrv/splrt/D07/cmd` in that same client, no separate
"publish topic" needed.

### Enabling debug mode

Set `DEBUG_MODE_ENABLED 1` in your local `firmware/config.h` (copy the
line from `config.example.h` if it's missing) and reflash
`stage5-gnss-matcher`. `DEBUG_MODE_ENABLED=0` (the default) leaves every
byte of the regular behaviour unchanged -- this whole feature compiles
out entirely, same convention as `IMU_ENABLED`.

### Testing the automatic boot sequence

With `DEBUG_MODE_ENABLED=1`, subscribe your MQTT client to
`lrv/splrt/D07/debug` and power on the board. You should see, in order:

1. `{"ev":"DEBUG_HEARTBEAT",...}` once a second while the GNSS engine
   has no fix yet.
2. One `{"ev":"DEBUG_GPS_LOCKED",...}` the moment the first fix arrives.
3. Five `{"ev":"GNSS_RAW",...}` packets (the same shape SD's
   `gnss_raw.ndjson` gets, one per fix) immediately after.
4. This one-shot sequence goes quiet after that -- `events` keeps
   publishing SEG_DONE as normal whenever a segment completes, and
   `debug` switches to the ongoing status heartbeat described below;
   nothing else from this specific sequence happens again until the next
   `debug_start_session` command or reboot.

No SD folder is created for this automatic run -- it logs to the default
`/lrv_log/events.ndjson` / `/lrv_log/gnss_raw.ndjson`, same files as
`DEBUG_MODE_ENABLED=0` always uses.

### Ongoing status heartbeat (watching a test without the Serial monitor)

Independent of the one-shot sequence above, and for as long as the
device is powered on, `lrv/splrt/D07/debug` also gets a status heartbeat
every 30 seconds:

```json
{"v":1,"ev":"DEBUG_STATUS","lrv":"D07","gps_fix_mode":3,"gps_nsv":30,"gps_hdop":0.5,"gps_lat":1.353855,"gps_lon":103.688933,"sd_ready":true,"sd_session":"default"}
```

- `gps_fix_mode`/`gps_nsv`/`gps_hdop`/`gps_lat`/`gps_lon`: the most
  recently polled GNSS state (0/2/3 = no fix/2D/3D). Reflects the last
  successful poll even if the most recent tick's poll failed or was
  skipped (e.g. the vehicle was briefly stationary) -- these fields are
  omitted entirely (not zeroed) if no successful poll has happened yet
  at all, e.g. in the first second or two after boot.
- `sd_ready`: whether the SD card initialised correctly.
- `sd_session`: `"default"` normally, or the active `/lrv_log/dbgN` path
  if a `debug_start_session` command is currently in effect.

This is the actual "monitor a test entirely over MQTT" capability --
the one-shot sequence above only ever answers "did it lock, what did the
first few fixes look like" and then falls silent; this heartbeat is what
still tells you something an hour into a test if GPS drops out or the SD
card fails. It does NOT currently cover cellular/MQTT link health (if
the link itself is down, no heartbeat can arrive at all -- watch for the
heartbeat simply stopping) or IMU/matcher activity (`events`' own
SEG_DONE messages are still the way to see segments actually
completing).

### Testing the `debug_start_session` command

With the device already booted (locked or not) and subscribed, publish
this exact payload to `lrv/splrt/D07/cmd`:

```json
{"cmd":"debug_start_session"}
```

Expect, on `lrv/splrt/D07/debug`:

1. `{"ev":"DEBUG_SESSION_START","folder":"/lrv_log/dbgN",...}` once the
   new SD folder (and its two empty `events.ndjson`/`gnss_raw.ndjson`
   files) has actually been created -- `N` increments each time the
   command is sent, starting at 1 for the first command since boot.
2. The same heartbeat/lock/5-raw-packets sequence as the automatic run,
   but this time SD-logged into `/lrv_log/dbgN/` instead of the default
   files. If GNSS was already locked before the command arrived, step 2
   starts straight at `DEBUG_GPS_LOCKED` rather than replaying
   heartbeats for a lock that already happened.

Sending the command again starts a new folder (`dbgN+1`) and repeats the
sequence.

**Confirmed working end-to-end on real hardware** (SIM7670G-MNGV
V1.9.05): subscribing is `AT+CMQTTSUB=<client_index>,<topic_len>,<qos>,
<dup>` directly (there is no `AT+CMQTTSUBTOPIC` on this firmware -- an
earlier version of this code assumed a two-step split and was wrong),
and a `debug_start_session` command sent from a real MQTT client has
been received, parsed, and acted on (SD folder created, MQTT ack
published). If it's not working for you, check the Serial monitor first
(`[cmd]`/`[mqtt]`-prefixed lines) -- one real gotcha already hit during
bring-up: some MQTT clients auto-convert straight quotes to curly/smart
quotes as you type the payload, which used to be rejected outright as
an unrecognised command (fixed -- the match is quote-style-agnostic
now, but worth knowing if you ever add a stricter command later).

## Supabase / ingest bridge setup (NOTES)

1. Create a Supabase project and run `supabase/schema.sql` in the SQL editor.
   For a project that already has the original four tables, run these four
   migrations in order:
   `supabase/migrations/202609150001_dashboard_operations_v2.sql`,
   `supabase/migrations/202609160001_systems_audit_fixes.sql`,
   `supabase/migrations/202609160002_corrective_maintenance.sql`, then
   `supabase/migrations/202609160003_demo_reset.sql`.
2. For the 30-LRV showcase, run `supabase/seed.dashboard_demo.sql` and then
   `supabase/validate.dashboard_demo.sql`. The validation runs its nested-cycle
   function check inside a transaction and rolls it back, so seeded records are
   unchanged. The showcase uses the LTA-confirmed continuous depot/bay stays:
   2K = 2 hours, 13K = 4 hours, 40K = 6 hours, 120K = 24 hours and 360K =
   21 elapsed days. Higher packages include every lower cycle; technicians
   record the actual completed scope and only those cycles reset. For a
   browser-driven restart, use **Admin → Reset demo data**. This restores the
   seeded planning state and removes reserved-range simulator events; stop the
   MQTT simulator first so it does not immediately publish new events. For a
   hardware-only project, copy `supabase/seed.example.sql` and
   adjust `lrv_id` values to match your
   devices' `config.h` `MQTT_LRV_ID`/`MQTT_FLEET`, run it -- the FK on
   `segment_traversals` rejects events for any vehicle not seeded here
   (intentional).
3. `cd ingest && npm install && cp .env.example .env` and fill in
   `MQTT_URL` and `SUPABASE_SERVICE_ROLE_KEY` (service-role key only --
   never put it on the device).
4. `npm start`.

## Dashboard development

The dashboard always reads Supabase. There is no separate browser-only mock
mode, so synthetic and real telemetry exercise the same query paths.

```powershell
cd frontend
Copy-Item .env.example .env
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then:
npm install
npm run dev
```

The seeded records stay static until new telemetry arrives. To demonstrate live
movement, run the normal ingest bridge in one terminal and the optional device
simulator in another. The simulator publishes the firmware's Tier 1 `SEG_DONE`
shape over MQTT and persists its reserved sequence numbers locally; it never
writes directly to Supabase.

```powershell
cd ingest
Copy-Item .env.example .env
# Fill in the MQTT and Supabase bridge values, then in separate terminals:
npm start
npm run simulate
```

Configure `SIM_VEHICLES`, `SIM_INTERVAL_MS`, `SIM_SPEED`, and `SIM_SCENARIO`
(`normal`, `mixed_quality`, or `weak_gnss`) in `ingest/.env`. Stop the simulator
with Ctrl+C. `SIM_SPEED` changes the event cadence and dwell time; calibrated
segment distances never change. On startup the simulator reconciles its local
sequence and odometer with Supabase so a restarted demo cannot move an odometer
backwards. Its local `.simulator-state.json` file is gitignored.

To verify only the broker path without writing to Supabase, run
`npm run test:mqtt` from `ingest/`. This publishes one uniquely named test topic,
receives it back and validates the packet through the production event mapper.

The challenge prototype permits selected unauthenticated dashboard mutations.
Before any operational deployment, add authentication/RBAC, use an authenticated
TLS MQTT broker, and complete the firmware SD-backfill path described below.

## Supabase / ingest bridge setup (DETAILS)

Workflow: whenever you open the Codespace and want to turn the listener on,
you only need to type these two lines:

```
cd ingest
npm start
```

Credentials belong only in `ingest/.env` (gitignored, per `.env.example`) --
never in this file or any other committed source. A real Supabase password
was previously committed here in plaintext; it has been removed and must be
treated as compromised -- rotate it in the Supabase dashboard if that has
not already been done.

## Build stages

See `Firmware_Cloud_Build_Plan_v1.0` for the authoritative stage order and
manual test gates. Each stage lives on its own branch and merges to `main`
only after its host tests pass and its manual test gate has been run.
