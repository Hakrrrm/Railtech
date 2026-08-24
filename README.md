# Railtech — LRV Mileage Tracking

Telemetry firmware and cloud ingest path for an IoT LRV mileage-tracking
prototype (SGRTGC 2026 Open Innovation Challenge). Companion documents:
`Prototype_Development_Plan_v3.0`, `TDD_LRV_Mileage_Tracking_v1.2`,
`Firmware_Cloud_Build_Plan_v1.0`.

## Repository layout

```
firmware/
  src/              pure-logic modules -- compile for host (gcc) and target (PlatformIO) alike
                     (event_serializer, seq_store, boot_counter, gnss_parser, map_matcher,
                     imu_state; track_types.h is the shared type-only header track_data.h
                     #includes; imu_mpu6050.* is target-only, no host-testable logic there)
  test/             plain-C, assert-based host test programs, one per module
  config.example.h  documents every config.h field (WiFi, MQTT, LRV id, IMU_ENABLED); copy to
                     config.h (gitignored)
  pins_board.h      modem UART/power/GNSS/SD/Qwiic-I2C pin assignments, each cited to its source
                     (LilyGo reference sketches / user-confirmed schematic trace) in its own comments
  harness/
    stage3/         Stage 3 Wi-Fi hotspot harness, also doing Stage 6 SD store-and-forward
                     logging (a fresh /boot_NNNN/ folder per boot)
    stage5/         Stage 5: real GNSS (direct AT+CGNSSINFO, 1 Hz) + map matcher + optional
                     IMU stationary gate. Serial + SD only, no Wi-Fi/MQTT (deferred to Stage 7)
tools/
  track_pipeline.py       GeoJSON + loop_lengths.csv -> segments.csv + track_data.h
  test_track_pipeline.py  self-tests (synthetic fixture, one violation per rule)
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

## Build stages

See `Firmware_Cloud_Build_Plan_v1.0` for the authoritative stage order and
manual test gates. Each stage lives on its own branch and merges to `main`
only after its host tests pass and its manual test gate has been run.
