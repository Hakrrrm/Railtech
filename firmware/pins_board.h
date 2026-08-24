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
 * Stage 3's Wi-Fi/MQTT logic itself does not use any of these -- it only
 * touches the ESP32-S3's on-chip Wi-Fi. The modem pins become
 * load-bearing at Stage 5 (real matcher / GNSS) and Stage 7 (LTE MQTT).
 * The SD_SPI_* pins below are the exception: the Stage 3 harness now
 * also does Stage 6 SD logging, so those four are load-bearing today.
 *
 * QWIIC_I2C_*_PIN: RESOLVED. The Standard board's KiCad schematic
 * (T-A7670X-S3-Standard Rev1.0) confirmed a dedicated Qwiic-I2C
 * connector (CN4, with its own 10k pull-ups) exists -- the MPU6050 just
 * plugs into it, no manual wiring -- but flattened PDF text extraction
 * couldn't recover which two ESP32-S3 GPIOs back that connector's
 * SDA/SCL nets. Resolved instead from LilyGo's own QWIIC_I2C_Scan.ino
 * example, which hardcodes SDA=IO3/SCL=IO2 "by default" for "Standard
 * Series" boards (this board's exact family) -- the same class of
 * working-reference-sketch source already used for the modem UART pins
 * above and MODEM_GPS_MODE/GNSS enable. That sketch also shows a second,
 * independent I2C bus available by repurposing the Qwiic-UART
 * connector's TX/RX (IO43/IO44) via Wire1 -- unused here, noted for
 * later if a second I2C device is ever needed.
 *
 * PSRAM: RESOLVED, confirmed three independent ways -- the board id
 * itself (N16R2), LilyGo's KiCad schematic for the shared Standard-series
 * PCB (T-A7670X-S3-Standard Rev1.0, labelled "SIM7670G/A7670X
 * compatibility design", MCU ESP32-S3-WROOM-1(N16R2)), and
 * boards/esp32-s3-wroom-1-n16r2.json's own name field ("16M Flash 2M
 * QSPI PSRAM"), pulled from a working LilyGo project. It's 2 MB, not the
 * 8 MB TDD Sec 5.1 states -- that's a TDD correction to make, not a
 * remaining firmware question.
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

/* microSD card, SPI bus (Stage 6, store-and-forward logging). Confirmed
 * against the board schematic by the user directly (CS = IO10); MOSI/
 * SCLK/MISO follow the standard ESP32-S3 default SPI pinout used
 * elsewhere on this board family. */
#define SD_SPI_MOSI_PIN 11
#define SD_SPI_SCLK_PIN 12
#define SD_SPI_MISO_PIN 13
#define SD_SPI_CS_PIN   10

/* Qwiic I2C (Stage 5, MPU6050 IMU). Confirmed via LilyGo's own
 * QWIIC_I2C_Scan.ino example for this board family -- see note above. */
#define QWIIC_I2C_SDA_PIN 3
#define QWIIC_I2C_SCL_PIN 2

#endif /* PINS_BOARD_H */
