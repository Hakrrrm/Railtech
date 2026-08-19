/*
 * LILYGO T-SIM7670G-S3-Standard pin assignments.
 *
 * Source: LilyGo's own LilyGo-Modem-Series repo (github.com/Xinyuan-LilyGO/
 * LilyGo-Modem-Series), tests/GpsOptimisation/GpsOptimisation.ino, which
 * comments its own pin block as "LILYGO T-SIM7670G-S3 Standard board
 * wiring from the repo utilities" (i.e. pulled from that example's
 * utilities.h). Matches the LILYGO_SIM7670G_S3_STAN build flag used in
 * platformio.ini's stage3-wifi-hotspot env. Not independently verified
 * against the physical schematic/silkscreen -- if your board doesn't
 * match, cross-check LilyGo's docs before wiring anything to these pins.
 *
 * Stage 3 (Wi-Fi hotspot harness) does not use any of these -- it only
 * touches the ESP32-S3's on-chip Wi-Fi. These become load-bearing at
 * Stage 5 (real matcher / GNSS) and Stage 7 (LTE MQTT).
 *
 * PSRAM cross-check: LilyGo's KiCad schematic for the shared Standard-
 * series PCB (T-A7670X-S3-Standard Rev1.0, explicitly labelled "SIM7670G/
 * A7670X compatibility design" -- i.e. this wiring is shared across both
 * modem variants) labels the MCU as ESP32-S3-WROOM-1(N16R2): 16 MB flash,
 * 2 MB PSRAM. This contradicts TDD Sec 5.1's stated 8 MB PSRAM -- worth
 * raising as a TDD correction, not just a firmware assumption.
 *
 * UNRESOLVED: tracing that same schematic's net labels suggests
 * MODEM_RX_PIN might actually be GPIO6, not GPIO5 -- net "MODEM_TX" (the
 * modem's TX output) appears to land on ESP32 IO6, which would make IO6
 * the ESP32 RX pin, not IO5. Left at the tested value below (from LilyGo's
 * working example code) rather than overwritten from an uncertain manual
 * schematic trace. Verify on the bench (scope/logic analyzer, or just try
 * both) before relying on this for Stage 5/7 UART traffic.
 */
#ifndef PINS_BOARD_H
#define PINS_BOARD_H

/* Modem UART. SerialAT = Serial1; Arduino's Serial.begin(baud, config,
 * rxPin, txPin) argument order, so MODEM_RX_PIN is the ESP32's RX
 * (receives from the modem's TX) and MODEM_TX_PIN is the ESP32's TX
 * (drives the modem's RX). MODEM_RX_PIN is the unresolved one -- see
 * note above. */
#define MODEM_BAUDRATE 115200
#define MODEM_TX_PIN   4
#define MODEM_RX_PIN   5 /* UNVERIFIED: schematic trace suggests GPIO6 */
#define MODEM_DTR_PIN  7

/* Modem power control. */
#define BOARD_PWRKEY_PIN            46
#define BOARD_POWER_SAVE_MODE_PIN   42
#define MODEM_POWERON_PULSE_WIDTH_MS 100
#define MODEM_START_WAIT_MS         3000

/* GNSS enable, via AT+CGNSSPWR-style GPIO control on the modem itself
 * (not an ESP32 GPIO) -- level convention as used in the reference
 * example's modem.enableGPS(gpio, level) call. */
#define MODEM_GPS_ENABLE_GPIO  1
#define MODEM_GPS_ENABLE_LEVEL 1

/* GNSS constellation mode for AT+CGNSSMODE / modem.setGPSMode(): GPS +
 * GLONASS + Galileo + BeiDou, per TDD D12 ("enable every constellation
 * the receiver supports"). */
#define MODEM_GPS_MODE 15

#endif /* PINS_BOARD_H */
