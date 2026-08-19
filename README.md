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
  harness_stage3/   target-only sketches, starting with the Stage 3 Wi-Fi hotspot harness
platformio.ini      PlatformIO project config
run_tests.sh        builds and runs the full host test suite; keep green at all times
```

`pins_board.h` (SPI/I2C/UART pin assignments, cited to the LILYGO schematic)
lands with the first stage that actually wires something up (Stage 6 SD,
Stage 7 modem) -- Stage 3 only uses the ESP32-S3's on-chip Wi-Fi, no
external pins.

## Running tests

```
./run_tests.sh
```

Host tests cover the pure-logic modules only. The target build
(`pio run -e stage3-wifi-hotspot`) additionally needs `firmware/config.h`
(copy from `firmware/config.example.h`) and PlatformIO's ESP32 platform
package, which requires network access to PlatformIO's registry.

## Build stages

See `Firmware_Cloud_Build_Plan_v1.0` for the authoritative stage order and
manual test gates. Each stage lives on its own branch and merges to `main`
only after its host tests pass and its manual test gate has been run.
