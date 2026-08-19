# Railtech — LRV Mileage Tracking

Telemetry firmware and cloud ingest path for an IoT LRV mileage-tracking
prototype (SGRTGC 2026 Open Innovation Challenge). Companion documents:
`Prototype_Development_Plan_v3.0`, `TDD_LRV_Mileage_Tracking_v1.2`,
`Firmware_Cloud_Build_Plan_v1.0`.

## Repository layout

```
tools/
  track_pipeline.py       GeoJSON + loop_lengths.csv -> segments.csv + track_data.h
  test_track_pipeline.py  self-tests (synthetic fixture, one violation per rule)
run_tests.sh               builds and runs the full host test suite; keep green at all times
```

## Running tests

```
./run_tests.sh
```

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
