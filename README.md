# Railtech — LRV Mileage Tracking

Telemetry firmware and cloud ingest path for an IoT LRV mileage-tracking
prototype (SGRTGC 2026 Open Innovation Challenge). Companion documents:
`Prototype_Development_Plan_v3.0`, `TDD_LRV_Mileage_Tracking_v1.2`,
`Firmware_Cloud_Build_Plan_v1.0`.

## Repository layout

```
firmware/
  src/     pure-logic modules -- compile for host (gcc) and target (PlatformIO) alike
  test/    plain-C, assert-based host test programs, one per module
run_tests.sh   builds and runs the full host test suite; keep green at all times
```

PlatformIO project files (`platformio.ini`, target-only sketches, `pins_board.h`,
`config.example.h`) land with Stage 3, the first stage that runs on the device.

## Running tests

```
./run_tests.sh
```

## Build stages

See `Firmware_Cloud_Build_Plan_v1.0` for the authoritative stage order and
manual test gates. Each stage lives on its own branch and merges to `main`
only after its host tests pass and its manual test gate has been run.
