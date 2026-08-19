# Railtech — LRV Mileage Tracking

Telemetry firmware and cloud ingest path for an IoT LRV mileage-tracking
prototype (SGRTGC 2026 Open Innovation Challenge). Companion documents:
`Prototype_Development_Plan_v3.0`, `TDD_LRV_Mileage_Tracking_v1.2`,
`Firmware_Cloud_Build_Plan_v1.0`.

## Repository layout

```
firmware/
  src/              pure-logic modules -- compile for host (gcc) and target (PlatformIO) alike
  test/             plain-C, assert-based host test programs, one per module
  config.example.h  documents every config.h field (WiFi, MQTT, LRV id); copy to config.h (gitignored)
  pins_board.h      modem UART/power/GNSS pin assignments, cited to LilyGo's own reference repo
  harness_stage3/   target-only sketches, starting with the Stage 3 Wi-Fi hotspot harness
tools/
  track_pipeline.py       GeoJSON + loop_lengths.csv -> segments.csv + track_data.h
  test_track_pipeline.py  self-tests (synthetic fixture, one violation per rule)
platformio.ini      PlatformIO project config
run_tests.sh        builds and runs the full host test suite; keep green at all times
```

`firmware/pins_board.h` isn't used by anything in Stage 3 (Wi-Fi only,
no external wiring) -- it's committed early because verified pin data
became available (LilyGo's own reference example for this exact board
variant), ahead of Stage 5/7 which will actually consume it.

## Running tests

```
./run_tests.sh
```

Host tests cover the pure-logic modules only. The target build
(`pio run -e stage3-wifi-hotspot`) additionally needs `firmware/config.h`
(copy from `firmware/config.example.h`) and PlatformIO's ESP32 platform
package, which requires network access to PlatformIO's registry.

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
of each.

## Build stages

See `Firmware_Cloud_Build_Plan_v1.0` for the authoritative stage order and
manual test gates. Each stage lives on its own branch and merges to `main`
only after its host tests pass and its manual test gate has been run.
