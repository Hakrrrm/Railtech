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
 */
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>

extern "C" {
#include "event_serializer.h"
#include "seq_store.h"
}

#include "../config.h"

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

/* Diagnostic only -- lets a failed retry say *why* instead of just
 * "timed out", since that distinction (no SSID seen vs. auth rejected
 * vs. generic disconnect) narrows down real Wi-Fi issues fast. */
static const char *wifi_status_name(wl_status_t status)
{
    switch (status) {
        case WL_IDLE_STATUS:     return "WL_IDLE_STATUS";
        case WL_NO_SSID_AVAIL:   return "WL_NO_SSID_AVAIL (SSID not seen -- out of range or wrong name)";
        case WL_SCAN_COMPLETED:  return "WL_SCAN_COMPLETED";
        case WL_CONNECTED:       return "WL_CONNECTED";
        case WL_CONNECT_FAILED:  return "WL_CONNECT_FAILED (likely wrong password)";
        case WL_CONNECTION_LOST: return "WL_CONNECTION_LOST";
        case WL_DISCONNECTED:    return "WL_DISCONNECTED";
        default:                 return "WL_UNKNOWN";
    }
}

static void ensure_wifi_connected()
{
    if (WiFi.status() == WL_CONNECTED) {
        return;
    }
    Serial.println("[wifi] connecting...");
    /* Clear any stale connection/auth state before retrying -- calling
     * begin() repeatedly on top of a half-connected or lost session is a
     * known source of the ESP32 Wi-Fi driver getting stuck. */
    WiFi.disconnect();
    delay(100);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
        delay(250);
        Serial.print(".");
    }
    Serial.println();
    wl_status_t status = WiFi.status();
    if (status == WL_CONNECTED) {
        Serial.print("[wifi] connected, ip=");
        Serial.println(WiFi.localIP());
    } else {
        Serial.print("[wifi] connect timed out, will retry (status=");
        Serial.print((int)status);
        Serial.print(" ");
        Serial.print(wifi_status_name(status));
        Serial.println(")");
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
    delay(200);

    seq_store_init();
    Serial.print("[boot] resumed seq=");
    Serial.println(seq_store_get_seq());

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
