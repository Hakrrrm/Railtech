/*
 * Stage 3 -- Wi-Fi hotspot MQTT harness (Build Plan Sec 3).
 *
 * End-to-end proof of serialise -> persist -> publish over the ESP32-S3's
 * native Wi-Fi. A fake matcher task on Core 0 emits a synthetic SEG_DONE
 * every 15 s through the same FreeRTOS queue the real matcher (Stage 5)
 * will use. Payloads and topics are production-identical; only the
 * transport differs -- see "Known deltas from production" below.
 *
 * Core 0: fake_matcher_task (stand-in for sensor acquisition).
 * Core 1: Arduino's default loop() -- Wi-Fi/MQTT connection management,
 *         commit-before-publish, and queue draining. This is the minimal
 *         two-task split for the MVP (TDD Sec 5.3).
 *
 * Known deltas from production (intentional, Build Plan Sec 3):
 *   - PubSubClient publishes QoS 0 only; the LTE client in Stage 7 does
 *     true QoS 1. The idempotent ingest tolerates either.
 *   - Timestamp is millis()-derived (seconds since boot), not GNSS time.
 *   - hdop/nsv are hardcoded; the real build reads them from the GNSS
 *     parser (Stage 5).
 *   - No TLS on the hotspot path; TLS with per-device credentials
 *     arrives with Stage 7 (TDD Sec 5.11).
 *
 * Stage 6 (SD store-and-forward) is folded into this harness rather than
 * its own: every event is appended to one fixed events.ndjson on the SD
 * card, published or not -- see the SD block below for why this is
 * broader than the plan doc's "backlog on failure only" wording.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <SPI.h>
#include <SD.h>

extern "C" {
#include "event_serializer.h"
#include "seq_store.h"
}

#include "../../config.h"
#include "../../pins_board.h"

/* ---- fake matcher -> net task queue message ---------------------- */

/* event_serializer.h doesn't define a segment-id buffer size (segment ids
 * are caller-owned strings), so size the fake matcher's own buffer here. */
#define FAKE_SEG_ID_MAX 32

struct FakeSegDone {
    char seg_id[FAKE_SEG_ID_MAX];
    char dir;
    int32_t d_mm;
    int16_t hdop_x10;
    uint8_t nsv;
    uint16_t dwell_s;
};

static QueueHandle_t s_matcher_queue;

static WiFiClient s_wifi_client;
static PubSubClient s_mqtt(s_wifi_client);
static char s_topic_events[64];

/* ---- SD card store-and-forward (Stage 6) --------------------------
 * One fixed directory/file, appended to across every boot -- earlier
 * revisions created a fresh /boot_NNNN/ folder per boot, but that grew
 * unboundedly across routine test resets with no benefit, so it was
 * dropped in favour of a single running log. Every event -- published
 * or not -- is appended to events.ndjson, per the user's explicit
 * request. This is broader than the Build Plan's Sec 6 wording
 * ("backlog only on publish failure"): logging here is unconditional,
 * so the SD card also serves as a full local audit trail, not just a
 * failure backlog. Flagged as an intentional deviation from the plan
 * doc, not an oversight.
 *
 * SD absent/write-failed must never halt matching or publishing --
 * log loudly once and keep going (Build Plan Sec 6). */
#define SD_LOG_DIR  "/lrv_log"
#define SD_LOG_FILE SD_LOG_DIR "/events.ndjson"

static bool s_sd_ready = false;

/* Cycles through a tiny fake loop so segment IDs in mosquitto_sub look
 * plausible rather than constant. */
static const struct { const char *seg_id; int32_t d_mm; } FAKE_SEGMENTS[] = {
    {"A_B", 612400},
    {"B_C", 415000},
    {"C_A", 733100},
};
#define NUM_FAKE_SEGMENTS (sizeof(FAKE_SEGMENTS) / sizeof(FAKE_SEGMENTS[0]))

/* ---- Core 0: fake matcher task ------------------------------------ */

static void fake_matcher_task(void *arg)
{
    (void)arg;
    size_t idx = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(15000));

        FakeSegDone msg;
        snprintf(msg.seg_id, sizeof(msg.seg_id), "%s", FAKE_SEGMENTS[idx].seg_id);
        msg.dir = 'E';
        msg.d_mm = FAKE_SEGMENTS[idx].d_mm;
        msg.hdop_x10 = 14;   /* hardcoded -- Stage 5 reads this from GNSS */
        msg.nsv = 19;        /* hardcoded -- Stage 5 reads this from GNSS */
        msg.dwell_s = 20;

        idx = (idx + 1) % NUM_FAKE_SEGMENTS;

        if (xQueueSend(s_matcher_queue, &msg, 0) != pdTRUE) {
            Serial.println("[matcher] queue full, dropping synthetic event");
        }
    }
}

/* ---- Core 1 (Arduino loop): Wi-Fi/MQTT + commit-before-publish ---- */

static void ensure_wifi_connected()
{
    if (WiFi.status() == WL_CONNECTED) {
        return;
    }
    Serial.println("[wifi] connecting...");
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
        delay(250);
        Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
        Serial.print("[wifi] connected, ip=");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("[wifi] connect timed out, will retry");
    }
}

static void ensure_mqtt_connected()
{
    if (s_mqtt.connected()) {
        return;
    }
    Serial.print("[mqtt] connecting...");
    char client_id[48];
    snprintf(client_id, sizeof(client_id), "lrv-%s-%lu", MQTT_LRV_ID, (unsigned long)millis());
    if (s_mqtt.connect(client_id)) {
        Serial.println(" ok");
    } else {
        Serial.print(" failed, rc=");
        Serial.println(s_mqtt.state());
    }
}

static void sd_log_json(const char *json)
{
    if (!s_sd_ready) {
        return;
    }
    File f = SD.open(SD_LOG_FILE, FILE_APPEND);
    if (!f) {
        Serial.println("[sd FAIL] could not open events.ndjson for append -- continuing without SD log");
        return;
    }
    f.println(json);
    f.close();
}

static void sd_init_log_dir()
{
    SPI.begin(SD_SPI_SCLK_PIN, SD_SPI_MISO_PIN, SD_SPI_MOSI_PIN, SD_SPI_CS_PIN);
    if (!SD.begin(SD_SPI_CS_PIN)) {
        Serial.println("[sd FAIL] SD.begin() failed -- card absent or unreadable, continuing without SD logging");
        return;
    }

    if (!SD.exists(SD_LOG_DIR) && !SD.mkdir(SD_LOG_DIR)) {
        Serial.println("[sd FAIL] mkdir failed for " SD_LOG_DIR);
        return;
    }

    s_sd_ready = true;
    Serial.println("[sd] logging to " SD_LOG_FILE " (appending across boots)");
}

static void handle_fake_seg_done(const FakeSegDone &fake)
{
    /* Commit-before-publish, non-negotiable (Build Plan Sec 2): odometer
     * accumulates in integer metres with half-up rounding from mm. */
    uint32_t new_seq = seq_store_get_seq() + 1;
    int64_t d_m = (fake.d_mm + 50) / 100; /* mm -> 0.1 m, then below -> m */
    d_m = (d_m + 5) / 10;                 /* 0.1 m -> whole m, half-up */
    int64_t new_odo_m = seq_store_get_odo_m() + d_m;

    if (seq_store_commit(new_seq, new_odo_m) != 0) {
        Serial.println("[commit FAIL] NVS commit failed -- event NOT published (commit-before-publish)");
        return; /* A failed commit blocks publication of this event entirely. */
    }

    evt_seg_done_t ev = {};
    ev.lrv_id = MQTT_LRV_ID;
    ev.seq = new_seq;
    ev.t = (uint32_t)(millis() / 1000); /* stand-in for GNSS time, Stage 5 */
    ev.seg_id = fake.seg_id;
    ev.dir = fake.dir;
    ev.d_mm = fake.d_mm;
    ev.odo_m = new_odo_m;
    ev.hdop_x10 = fake.hdop_x10;
    ev.nsv = fake.nsv;
    ev.dwell_s = fake.dwell_s;

    char json[EVT_JSON_MAX];
    int n = evt_serialize_seg_done(&ev, json, sizeof(json));
    if (n < 0) {
        Serial.println("[serialize FAIL] evt_serialize_seg_done rejected the event");
        return;
    }

    sd_log_json(json);

    if (!s_mqtt.connected()) {
        Serial.println("[pub FAIL] mqtt not connected, event committed but not published (Stage 6 backlog will cover this)");
        return;
    }

    bool ok = s_mqtt.publish(s_topic_events, (const uint8_t *)json, n, false);
    if (ok) {
        Serial.print("[pub ok] ");
        Serial.println(json);
    } else {
        Serial.println("[pub FAIL] mqtt.publish() returned false (broker/buffer issue -- check setBufferSize)");
    }
}

void setup()
{
    Serial.begin(115200);
    /* This board uses native USB-CDC serial (build_flags has
     * ARDUINO_USB_CDC_ON_BOOT=1) -- a reset/power-cycle re-enumerates the
     * USB device, dropping and reconnecting the host's COM port, and a
     * fixed short delay isn't enough to cover that reconnect handshake.
     * A first attempt waited on Serial's own "connected" flag, but that
     * flag isn't a fully reliable signal in practice across ESP32 Arduino
     * core versions/host OSes -- it can read true as soon as the OS
     * finishes USB enumeration, before a terminal has actually attached,
     * so the wait resolved instantly and the boot lines were still lost.
     * Belt-and-braces fix: keep the bounded wait as a fast path, then
     * repeat the boot line itself for a few seconds so a monitor
     * attaching anywhere in that window still catches it. */
    unsigned long serial_wait_start = millis();
    while (!Serial && millis() - serial_wait_start < 3000) {
        delay(10);
    }
    delay(100); /* small settle margin after the port opens */

    seq_store_init();
    sd_init_log_dir();

    char boot_banner[80];
    snprintf(boot_banner, sizeof(boot_banner), "[boot] resumed seq=%lu, sd=%s",
             (unsigned long)seq_store_get_seq(), s_sd_ready ? "ok" : "FAILED");
    for (int i = 0; i < 5; i++) {
        Serial.println(boot_banner);
        delay(600);
    }

    snprintf(s_topic_events, sizeof(s_topic_events), "lrv/%s/%s/events", MQTT_FLEET, MQTT_LRV_ID);

    s_matcher_queue = xQueueCreate(8, sizeof(FakeSegDone));

    s_mqtt.setServer(MQTT_HOST, MQTT_PORT);
    s_mqtt.setBufferSize(512); /* PubSubClient default (256) includes the
                                  topic; events fit, but 512 removes the
                                  risk if fields grow (Build Plan Sec 3). */

    xTaskCreatePinnedToCore(fake_matcher_task, "fake_matcher", 4096, nullptr, 1, nullptr, 0 /* Core 0 */);
}

void loop()
{
    ensure_wifi_connected();
    if (WiFi.status() == WL_CONNECTED) {
        ensure_mqtt_connected();
        s_mqtt.loop();
    }

    FakeSegDone msg;
    if (xQueueReceive(s_matcher_queue, &msg, 0) == pdTRUE) {
        handle_fake_seg_done(msg);
    }

    delay(20);
}
