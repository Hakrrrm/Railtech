/*
 * Stage 5/7 -- real GNSS (direct AT commands) + map matcher + optional
 * IMU stationary gate + cellular MQTT publish (Build Plan Sec 5 / TDD
 * Sec 5.3-5.5, Stage 7).
 *
 * Cellular MQTT publish (Stage 7) is now wired in, reusing the exact
 * AT-command sequence validated standalone in
 * firmware/harness/cellular-mqtt-test/main_cellular_mqtt_test.cpp (SIM
 * ready -> APN -> LTE registration -> AT+NETOPEN -> the modem's onboard
 * AT+CMQTT... client), including that harness's retry-instead-of-halt
 * bring-up hardening. The one architectural difference from that
 * standalone test: this is the PRODUCTION matcher, and Stage 6's SD
 * store-and-forward logging must keep working with or without cellular
 * coverage -- so a cellular/MQTT bring-up failure here does NOT halt the
 * device. It logs the failure, continues running GNSS/matcher/SD/Serial
 * exactly as before, and retries the connection in the background from
 * loop() every MQTT_CHECK_INTERVAL_MS. SD is therefore still the only
 * durability guarantee; MQTT is best-effort on top of it, never a
 * dependency for logging to keep working. Reuses Stage 6's SD
 * store-and-forward pattern: one fixed /lrv_log/ directory, appended
 * to across every boot (not a fresh folder per boot -- that was an
 * earlier design, dropped after it grew unboundedly across routine
 * test resets with no benefit).
 *
 * DEBUG_MODE_ENABLED (config.h, 0/1 compile-time flag, same convention
 * as IMU_ENABLED): 0 leaves every byte of the above unchanged -- only
 * SEG_DONE goes over MQTT, to the events topic, exactly as always. 1
 * additionally, ONCE per boot (or once per debug_start_session command,
 * see below): publishes GNSS diagnostics to a SEPARATE
 * lrv/{FLEET}/{LRV_ID}/debug topic -- heartbeats while no fix has ever
 * been obtained, one lock-acquired notice the moment a fix first
 * arrives, then the next DEBUG_RAW_PACKET_COUNT (5) fixes in the exact
 * same GNSS_RAW JSON shape already written to gnss_raw.ndjson -- then
 * goes quiet on that topic (events keeps working throughout,
 * unaffected). A SEPARATE topic rather than reusing events: events is
 * the ingest bridge's contract (segment_traversals rows), and mixing
 * high-frequency boot diagnostics into it would be noise for any other
 * consumer of that topic, even though the bridge itself would just
 * silently ignore a non-SEG_DONE ev value.
 *
 * Also subscribes to lrv/{FLEET}/{LRV_ID}/cmd (device listens, backend/
 * phone publishes) for one command, {"cmd":"debug_start_session"}: on
 * receipt, creates a fresh numbered SD folder (/lrv_log/dbgN/,
 * events.ndjson + gnss_raw.ndjson inside), publishes a debug-topic ack
 * once it's created, and re-runs the SAME heartbeat/lock/5-raw-packets
 * sequence -- but logging THIS run's SD output into the new folder
 * instead of the default /lrv_log/ files. If a fix lock already existed
 * before the command arrived, the sequence starts straight at the
 * lock-acquired notice rather than replaying heartbeats for a wait that
 * already happened.
 *
 * IMPORTANT, flagged explicitly: the SUBSCRIBE side of this (topic
 * subscription via AT+CMQTTSUB, and parsing the modem's incoming-publish
 * URC sequence, +CMQTTRXSTART/+CMQTTRXTOPIC/+CMQTTRXPAYLOAD/
 * +CMQTTRXEND) is NEW ground for this codebase -- every other AT
 * sequence here was built against real hardware or a confirmed vendor
 * manual section; this one largely was not, and the first guess at it
 * was wrong. Real hardware (SIM7670G-MNGV V1.9.05) confirmed there is
 * NO separate AT+CMQTTSUBTOPIC command on this firmware (it returns
 * ERROR to its own "=?" query) -- the original two-step publish-style
 * TOPIC-then-SUB split mqtt_subscribe() used was rejected outright.
 * AT+CMQTTSUB=? answered "+CMQTTSUB: (0-1),(1-1024),(0-2),(0-1)", so
 * subscribing is ONE data-entry command (client_index, topic_len, qos,
 * dup), same '>' prompt convention as CMQTTTOPIC/CMQTTPAYLOAD (proven in
 * mqtt_publish()) but merged into a single step -- see mqtt_subscribe()'s
 * own comment for exactly what's now confirmed vs. still inferred (the
 * async "+CMQTTSUB: <result>" line specifically). The incoming-message
 * RX URC sequence mqtt_check_incoming() parses remains entirely
 * UNVERIFIED -- bench-test that specifically before trusting
 * DEBUG_MODE_ENABLED's command-triggered path end-to-end. The boot-time
 * heartbeat/lock/raw-packet publish path reuses only already-proven
 * mqtt_publish(), so that half carries no such caveat.
 *
 * Also fixed in passing, while touching SD logging for the debug
 * session folder: sd_append_line() (and therefore sd_log_json()/
 * sd_log_raw_json()) previously had no synchronization at all, despite
 * already being called from BOTH cores (Core 1's handle_seg_done() and
 * Core 0's gnss_matcher_task) -- a pre-existing gap from before Stage 7,
 * same class of bug as the AT-mutex fix elsewhere in this file, just on
 * the SD/SPI peripheral instead of the modem UART. Now guarded by
 * s_sd_mutex. Unconditional, not gated by DEBUG_MODE_ENABLED -- it's a
 * correctness fix that benefits every build, debug mode or not.
 *
 * Core 0 runs two independent tasks, sampled at different rates on
 * purpose -- IMU state recognition needs to react within a few hundred
 * ms, GNSS is inherently a 1 Hz fix:
 *   - imu_task (IMU_ENABLED only): samples the MPU6050 at 20 Hz
 *     (IMU_SAMPLE_INTERVAL_MS) and updates a shared stationary/moving
 *     flag. This used to be piggybacked on gnss_matcher_task's own 1 Hz
 *     loop -- decoupled so the classifier gets a real decision window
 *     (imu_state.h's IMU_STATE_WINDOW_SAMPLES) instead of one sample
 *     per second, which was too coarse to recognise state changes
 *     promptly or reject vibration noise properly.
 *   - gnss_matcher_task: once per second, reads that flag -- if
 *     stationary, skips the GNSS poll entirely (saves modem cycles/
 *     power); otherwise issues a raw AT+CGNSSINFO query, parses it,
 *     and feeds the fix into the map matcher. Every valid fix is
 *     printed/logged to gnss_raw.ndjson on its own -- independent of
 *     the matcher -- so GNSS acquisition can be verified before
 *     trusting matcher output. A completed segment additionally goes
 *     on the queue for Core 1.
 * Core 1 (Arduino loop()): commit-before-publish (seq_store), Serial +
 *         SD logging of completed segments (events.ndjson), queue
 *         draining. No network I/O.
 *
 * Modem/GNSS is driven entirely by direct AT commands over SerialAT,
 * no TinyGSM -- explicit user request, and also the pragmatic choice:
 * the publicly published vshymanskyy/TinyGSM package has no SIM7670G
 * modem definition at all (confirmed by inspecting its source), so the
 * team's earlier reference sketch's `#define TINY_GSM_MODEM_SIM7670G`
 * only ever compiled against LilyGo's own vendored fork, never the
 * registry package PlatformIO actually resolves here. Every AT command
 * used (AT+CGNSSPWR, AT+CGNSSMODE, AT+CGNSSINFO) is confirmed against
 * SIMCOM's own SIM767XX Series_AT Command Manual_V1.06, but the CALL
 * ORDER in gnss_bringup() follows the reference sketch's own proven
 * structure (mode set once before power-on, not after) rather than the
 * manual's stated "CGNSSMODE is valid after GNSS power on" -- see
 * gnss_bringup()'s own comment for why.
 *
 * Known simplifications (flagged, not silent):
 *   - dir ('E'/'W') is a Stage 5 placeholder for forward/reverse
 *     traversal, not a real cardinal direction -- see map_matcher.h.
 *   - firmware/src/track_data.h currently holds a throwaway dummy
 *     dataset (track.dummy.geojson), not a real surveyed track --
 *     fine for testing GNSS/IMU visibility, not for matcher accuracy.
 *     Regenerate via tools/track_pipeline.py once real track data
 *     exists (Build Plan Sec 4 / README).
 *   - lat/lon are parsed as plain decimal degrees (gnss_parser.c), per
 *     the reference sketch's own hardware observation on this exact
 *     modem -- the AT manual's own printed CGNSSINFO example looks
 *     more like NMEA ddmm.mmmm instead, an unresolved conflict worth a
 *     sanity check against a known location on the very first real fix.
 */
#include <string.h>

#include <Arduino.h>
#include <Wire.h>

extern "C" {
#include "event_serializer.h"
#include "seq_store.h"
#include "gnss_parser.h"
#include "map_matcher.h"
#include "imu_state.h"
#include "imu_mpu6050.h"
}

#include <SPI.h>
#include <SD.h>

#include "../../config.h"
#include "../../pins_board.h"
#include "track_data.h" /* TRACK_SEGMENTS, TRACK_NUM_SEGMENTS, TRACK_NEXT_FWD(_COUNT) --
                          * generated by tools/track_pipeline.py, see header comment above */

#define SerialAT Serial1
#define SAMPLE_INTERVAL_MS 1000UL /* 1 Hz, TDD */
#define RAW_GPS_TIMEOUT_MS 800UL
#define IMU_SAMPLE_INTERVAL_MS 50UL /* 20 Hz -- decoupled from GNSS's 1 Hz, see imu_task */
#define IMU_HEARTBEAT_INTERVAL_MS 10000UL /* periodic "still alive, state is X" line, see imu_task */

/* Cellular MQTT (Stage 7) -- same constants/values as
 * cellular-mqtt-test/main_cellular_mqtt_test.cpp, proven on real
 * hardware there. MQTT_CLIENT_INDEX_MATCHER and the "-matcher" client-id
 * suffix below are deliberately distinct from that standalone harness's
 * "-cell" suffix so the two can never collide with the same MQTT client
 * id on the broker if both happened to run against the same LRV_ID at
 * once (e.g. bring-up test left running while flashing the real
 * matcher). */
#define MQTT_CLIENT_INDEX 0
#define MQTT_KEEPALIVE_S 60UL
#define MQTT_CHECK_INTERVAL_MS 60000UL /* how often loop() checks/retries the cellular MQTT link */
/* Two different attempt budgets for cellular_mqtt_bringup(), depending
 * on who's calling -- see that function's own comment for why setup()
 * and loop() need different values here. */
#define MQTT_BRINGUP_BOOT_MAX_ATTEMPTS      5
#define MQTT_BRINGUP_RECONNECT_MAX_ATTEMPTS 1
#define RETRY_BACKOFF_MS 3000UL

/* Debug mode (DEBUG_MODE_ENABLED, config.h) -- see this file's header
 * comment for the full design. */
#define DEBUG_RAW_PACKET_COUNT 5 /* how many post-lock raw fixes go to the debug topic */
#define DEBUG_INCOMING_CHECK_INTERVAL_MS 1000UL /* how often loop() polls for an incoming cmd */
#define DEBUG_SD_SESSION_DIR_MAX 32 /* "/lrv_log/dbg" + up to a few digits, well under this */

/* Fix-quality gate, applied before the fix is allowed to move the map
 * matcher. PDOP is the primary figure: it describes the 3D solution
 * geometry, so it is the one that actually says whether the position is
 * trustworthy -- HDOP only characterises the horizontal component and
 * can look healthy while the overall solution is poor. Standard DOP
 * bands put <=2 excellent, 2-5 good, 5-10 moderate, >10 fair-to-poor;
 * 6.0 sits at the "still usable on a partly-obstructed campus loop"
 * end of that. The HDOP limit is a much looser backstop for the
 * pathological horizontal outlier.
 *
 * A rejected fix is not discarded quietly -- it counts as a miss inside
 * the matcher, which is exactly what escalates a run of bad fixes into
 * the blackout re-acquisition path (map_matcher.h). */
#define GNSS_MAX_PDOP_X10 60  /* PDOP 6.0 */
#define GNSS_MAX_HDOP_X10 100 /* HDOP 10.0 -- backstop only */

/* Written only by imu_task, read only by gnss_matcher_task -- a single
 * bool is a single-instruction load/store on this MCU, so `volatile`
 * (defeats compiler caching across loop iterations) is enough here
 * without a mutex; not true in general for multi-word shared state. */
static volatile bool s_imu_stationary = false;

/* Cellular MQTT link state (Stage 7). WRITTEN only from Core 1
 * (handle_seg_done() and loop()'s periodic check) -- single-writer, so
 * no mutex needed for that. s_mqtt_ready is also READ from Core 0 when
 * DEBUG_MODE_ENABLED (debug_publish(), gnss_matcher_task) -- a
 * single-word cross-core read of a bool that's never torn on this MCU,
 * same reasoning already relied on for s_imu_stationary in the other
 * direction; still no volatile needed since Core 0 tolerates reading a
 * value that's one tick stale (worst case, one debug packet is
 * attempted/dropped right as the link flips). s_cellular_provisioned is
 * distinct from s_mqtt_ready: it latches true once (SIM+APN+registration
 * all succeeded during setup()) and is never cleared again -- it's what
 * gates whether loop() should keep retrying the net/MQTT connection at
 * all, separately from whether that connection currently happens to be
 * up. */
static bool s_mqtt_ready = false;
static bool s_cellular_provisioned = false;
static unsigned long s_last_mqtt_check_ms = 0;

#if DEBUG_MODE_ENABLED
/* Debug boot sequence (Stage 7 DEBUG_MODE_ENABLED) -- see this file's
 * header comment for the full design. State is Core-0-owned (driven by
 * GNSS fix arrival in gnss_matcher_task): DEBUG_SEQ_IDLE means nothing
 * to do (either finished, or DEBUG_MODE_ENABLED left it uninitialised --
 * see setup(), which always starts it at DEBUG_SEQ_WAIT_LOCK on boot).
 * s_debug_restart_requested is the ONE field Core 1 writes (on the
 * debug_start_session command) -- a single bool, same
 * single-word-cross-core pattern already used for s_imu_stationary, so
 * no mutex needed for it specifically. */
typedef enum { DEBUG_SEQ_IDLE, DEBUG_SEQ_WAIT_LOCK, DEBUG_SEQ_SEND_RAW } debug_seq_state_t;
static debug_seq_state_t s_debug_seq_state = DEBUG_SEQ_IDLE;
static uint8_t s_debug_raw_sent = 0;
static bool s_gnss_ever_locked = false;
static volatile bool s_debug_restart_requested = false;
#endif /* DEBUG_MODE_ENABLED */

/* Guards every AT-command exchange over SerialAT once gnss_matcher_task
 * (Core 0) and Core 1's MQTT calls can both be running at the same time.
 * Before Stage 7, ALL AT traffic happened in setup(), single-threaded,
 * before any task existed -- no contention was possible. Stage 7 added
 * AT traffic from loop() (MQTT publish on every SEG_DONE, plus a
 * periodic reconnect check) that now runs concurrently with
 * gnss_matcher_task's 1 Hz AT+CGNSSINFO poll on Core 0, both over the
 * SAME UART with no framing between exchanges -- without this mutex,
 * two AT commands (or a command and an unrelated async URC) can
 * interleave on the wire and corrupt whichever read happens to be in
 * progress on either side. Held for the full duration of one logical AT
 * exchange, including any async URC wait that follows it (e.g.
 * AT+CMQTTCONNECT's result line arrives well after its own OK) -- not
 * held for one raw byte at a time, and not held across multiple
 * independent exchanges (e.g. cellular_mqtt_bringup() take/gives it
 * separately inside each of net_open()/mqtt_start()/mqtt_connect()), so
 * GNSS polling can still interleave BETWEEN complete AT exchanges, just
 * never in the middle of one. */
static SemaphoreHandle_t s_at_mutex;

#if DEBUG_MODE_ENABLED
/* Persists ACROSS every AT exchange in this file, not just calls to
 * mqtt_check_incoming() -- see send_at_command_expect()'s own comment
 * for why. Also persists across individual mqtt_check_incoming() polls
 * for a second reason: a local `String resp` there would be destroyed
 * at the end of every call, so a URC that happens to straddle two polls
 * (mqtt_check_incoming() runs once a second; nothing guarantees the
 * modem finishes sending "+CMQTTRXSTART:..." within one poll's
 * non-blocking peek) would have its already-read first half silently
 * discarded, and the second half would arrive on the next poll looking
 * like it never had a "+CMQTTRXSTART:" prefix at all -- a real,
 * found-on-review bug in an earlier version of that function, not
 * hypothetical. Cleared by mqtt_check_incoming() after every attempt
 * that actually saw a "+CMQTTRXSTART:" (success or give-up), so a
 * malformed/incomplete message doesn't wedge future polls; NOT cleared
 * on the common "nothing pending yet" fast path, so a genuinely partial
 * start is retained for the next poll to complete. */
static String s_incoming_buf;
#endif /* DEBUG_MODE_ENABLED */

/* ---- Core 0 -> Core 1 queue message -------------------------------- */

struct SegDoneMsg {
    const char *seg_id; /* points into TRACK_SEGMENTS' static flash strings */
    char        dir;
    int32_t     d_mm;
    uint16_t    dwell_s;
    uint8_t     inferred; /* 1 = credited from map geometry across a GNSS
                           * blackout rather than directly observed */
    int16_t     hdop_x10;
    uint8_t     nsv;
    uint32_t    t; /* unix epoch seconds, from the fix that completed this segment */
    bool        t_is_wall_clock; /* false if t fell back to millis()/1000 -- see
                                   * gnss_matcher_task's now_s comment. Internal
                                   * only, never serialised; guards the Serial-only
                                   * SGT print in handle_seg_done() from rendering
                                   * a bogus 1970 date off a non-epoch value. */
};

static QueueHandle_t s_matcher_queue;

/* ---- SD card store-and-forward (Stage 6 pattern, reused) -----------
 * One fixed directory/file, appended to across every boot -- see the
 * Stage 3/6 harness for why this replaced an earlier per-boot-folder
 * design.
 *
 * gnss_raw.ndjson (Stage 5): every valid GNSS fix, independent of
 * whether the map matcher fires a SEG_DONE -- lets you confirm GNSS
 * acquisition is healthy before trusting/debugging the matcher, since
 * events.ndjson alone stays silent until you're actually on a real
 * track crossing a segment boundary. Written at up to 1 Hz, noticeably
 * more SD I/O than events.ndjson's one-write-per-completed-segment;
 * acceptable for a bring-up/debug harness, flagged in case flash wear
 * matters once this runs for hours unattended. */
#define SD_LOG_DIR      "/lrv_log"
#define SD_LOG_FILE     SD_LOG_DIR "/events.ndjson"
#define SD_RAW_LOG_FILE SD_LOG_DIR "/gnss_raw.ndjson"
static bool s_sd_ready = false;

/* Guards every SD/SPI access (SD.open/mkdir/write/close) across both
 * cores. Before this, sd_append_line() (and so sd_log_json()/
 * sd_log_raw_json()) had NO synchronization despite already being
 * called from BOTH Core 1 (handle_seg_done()) and Core 0
 * (gnss_matcher_task) -- a pre-existing gap from before Stage 7, same
 * class of issue s_at_mutex already fixes for the modem UART. Fixed here
 * while adding the debug session's dynamic SD path below (which needed
 * cross-core-safe access to that path anyway), but the fix itself is
 * unconditional -- it benefits every build, not just
 * DEBUG_MODE_ENABLED=1. */
static SemaphoreHandle_t s_sd_mutex;

/* Debug SD session (Stage 7 DEBUG_MODE_ENABLED) -- empty string means
 * "use the default SD_LOG_FILE/SD_RAW_LOG_FILE paths above" (the normal,
 * always-on case, and the ONLY case when DEBUG_MODE_ENABLED is 0: nothing
 * ever writes to these). Set only by sd_create_debug_session() (Core 1,
 * on the debug_start_session command) under s_sd_mutex; read by
 * sd_write_line() (both cores) under the same mutex, so a path is never
 * read half-written mid-update. */
static char s_debug_session_events_file[64] = "";
static char s_debug_session_raw_file[64] = "";

static void sd_write_line(const char *default_path, const char *session_path, const char *json)
{
    if (!s_sd_ready) {
        return;
    }
    xSemaphoreTake(s_sd_mutex, portMAX_DELAY);
    const char *path = (session_path[0] != '\0') ? session_path : default_path;
    File f = SD.open(path, FILE_APPEND);
    if (!f) {
        Serial.print("[sd FAIL] could not open ");
        Serial.print(path);
        Serial.println(" for append -- continuing without SD log");
        xSemaphoreGive(s_sd_mutex);
        return;
    }
    f.println(json);
    f.close();
    xSemaphoreGive(s_sd_mutex);
}

static void sd_log_json(const char *json)
{
    sd_write_line(SD_LOG_FILE, s_debug_session_events_file, json);
}

static void sd_log_raw_json(const char *json)
{
    sd_write_line(SD_RAW_LOG_FILE, s_debug_session_raw_file, json);
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

#if DEBUG_MODE_ENABLED
/* Creates a new numbered SD folder (SD_LOG_DIR "/dbgN") with fresh
 * events.ndjson/gnss_raw.ndjson touched inside it, and points
 * sd_log_json()/sd_log_raw_json() at those files instead of the default
 * ones via s_debug_session_events_file/raw_file. Only ever called from
 * Core 1 (the debug_start_session command handler). Returns true and
 * fills session_dir_out (>= DEBUG_SD_SESSION_DIR_MAX bytes) with the new
 * directory path on success. */
static bool sd_create_debug_session(char *session_dir_out, size_t session_dir_out_len)
{
    if (!s_sd_ready) {
        Serial.println("[sd FAIL] cannot start a debug session -- SD not ready");
        return false;
    }

    static uint8_t s_debug_session_counter = 0;
    s_debug_session_counter++;
    char dir[DEBUG_SD_SESSION_DIR_MAX];
    snprintf(dir, sizeof(dir), SD_LOG_DIR "/dbg%u", (unsigned)s_debug_session_counter);

    xSemaphoreTake(s_sd_mutex, portMAX_DELAY);
    bool dir_ok = SD.exists(dir) || SD.mkdir(dir);
    if (!dir_ok) {
        Serial.print("[sd FAIL] could not create debug session dir ");
        Serial.println(dir);
        xSemaphoreGive(s_sd_mutex);
        return false;
    }

    char events_path[sizeof(s_debug_session_events_file)];
    char raw_path[sizeof(s_debug_session_raw_file)];
    snprintf(events_path, sizeof(events_path), "%s/events.ndjson", dir);
    snprintf(raw_path, sizeof(raw_path), "%s/gnss_raw.ndjson", dir);

    /* Touch both files now (open+close, no content) so "folder created"
     * means something concrete on the SD card immediately, rather than
     * an empty promise that only becomes true once the first SEG_DONE/
     * raw fix eventually gets written. */
    File fe = SD.open(events_path, FILE_APPEND);
    if (fe) {
        fe.close();
    }
    File fr = SD.open(raw_path, FILE_APPEND);
    if (fr) {
        fr.close();
    }

    strncpy(s_debug_session_events_file, events_path, sizeof(s_debug_session_events_file) - 1);
    s_debug_session_events_file[sizeof(s_debug_session_events_file) - 1] = '\0';
    strncpy(s_debug_session_raw_file, raw_path, sizeof(s_debug_session_raw_file) - 1);
    s_debug_session_raw_file[sizeof(s_debug_session_raw_file) - 1] = '\0';
    xSemaphoreGive(s_sd_mutex);

    strncpy(session_dir_out, dir, session_dir_out_len - 1);
    session_dir_out[session_dir_out_len - 1] = '\0';
    Serial.print("[sd] debug session folder ready: ");
    Serial.println(dir);
    return true;
}
#endif /* DEBUG_MODE_ENABLED */

/* ---- Modem/GNSS bring-up -- direct AT commands, no TinyGSM --------
 * Explicit user request: no TinyGSM dependency anywhere in this
 * harness. This also sidesteps a real problem -- the publicly
 * published vshymanskyy/TinyGSM package has no SIM7670G modem
 * definition at all (confirmed by inspecting its source directly), so
 * `#define TINY_GSM_MODEM_SIM7670G` only ever worked against LilyGo's
 * own vendored/forked copy, never the registry package PlatformIO
 * actually resolves. */

/* Sends one AT command over SerialAT and reads until a terminal token
 * (OK by default -- pass e.g. "+CGNSSPWR: READY!" to wait for a URC
 * that arrives AFTER the OK), an ERROR line, or timeout. Same read
 * loop GpsOptimisation.ino's own rawGpsQuery() uses for AT+CGNSSINFO
 * -- generalised here so bring-up and the 1 Hz poll share one
 * implementation.
 *
 * DEBUG_MODE_ENABLED only: the "drain whatever's sitting unread" step
 * below used to just discard those bytes -- fine normally, but a real
 * problem once something ELSE (the modem's own unsolicited push-message
 * URC on the subscribed cmd topic) can also legitimately show up in that
 * same buffer. gnss_matcher_task calls this once a second for its own
 * GNSS poll, same cadence as mqtt_check_incoming()'s poll for an
 * incoming command -- so an incoming URC that happened to arrive in the
 * window between the two could get silently eaten right here before
 * mqtt_check_incoming() ever got a chance to see it, no matter how
 * correct that function's own parsing turned out to be. Redirecting the
 * drain into s_incoming_buf instead of discarding it means no AT
 * exchange in this file can silently swallow an unsolicited URC anymore
 * -- whatever shows up here is exactly what mqtt_check_incoming() would
 * otherwise have polled for later. */
static bool send_at_command_expect(const char *cmd, String &response,
                                    const char *expect_token,
                                    unsigned long timeout_ms)
{
    response = "";
    while (SerialAT.available()) {
#if DEBUG_MODE_ENABLED
        s_incoming_buf += (char)SerialAT.read();
#else
        SerialAT.read();
#endif
    }
    SerialAT.println(cmd);

    unsigned long start = millis();
    while (millis() - start < timeout_ms) {
        while (SerialAT.available()) {
            char c = (char)SerialAT.read();
            response += c;
            if (response.indexOf(expect_token) >= 0) {
                return true;
            }
            if (response.indexOf("\r\nERROR\r\n") >= 0) {
                return false;
            }
        }
        delay(1);
    }
    return false;
}

static bool send_at_command(const char *cmd, String &response, unsigned long timeout_ms = 2000)
{
    return send_at_command_expect(cmd, response, "\r\nOK\r\n", timeout_ms);
}

/* Keeps reading without sending anything -- for an async URC that
 * arrives after a command already issued (e.g. AT+CMQTTCONNECT's
 * "+CMQTTCONNECT: <idx>,<result>" line lands well after its own OK, once
 * the broker handshake actually completes), or for the modem's response
 * to raw bytes written directly to SerialAT (the topic/payload writes in
 * mqtt_publish()) rather than to an AT command. Ported verbatim from
 * cellular-mqtt-test/main_cellular_mqtt_test.cpp, already proven on real
 * hardware there -- with one real bug fixed since: the token check used
 * to live ONLY inside the "a new byte just arrived" branch, so if
 * expect_token was already present in `response` BEFORE this function
 * was even called, it would never be noticed -- the function would just
 * burn the full timeout_ms waiting for a byte that would trigger a check
 * that was never going to find anything new, then return false despite
 * the token being right there the whole time. Never mattered at the
 * call sites that reset `response = ""` immediately before calling (an
 * empty string trivially contains no token, so the missing check was a
 * no-op there) -- but real hardware caught it for real in
 * mqtt_check_incoming(), which deliberately does NOT reset s_incoming_buf
 * between waits (it has to keep building on prior content): a short
 * message can arrive over UART fast enough that the ENTIRE sequence,
 * "+CMQTTRXPAYLOAD:" included, was already sitting in the buffer before
 * this function was ever called to wait for it. */
static bool wait_for_token(String &response, const char *expect_token, unsigned long timeout_ms)
{
    if (response.indexOf(expect_token) >= 0) {
        return true;
    }
    unsigned long start = millis();
    while (millis() - start < timeout_ms) {
        while (SerialAT.available()) {
            char c = (char)SerialAT.read();
            response += c;
            if (response.indexOf(expect_token) >= 0) {
                return true;
            }
            if (response.indexOf("\r\nERROR\r\n") >= 0) {
                return false;
            }
        }
        delay(1);
    }
    return false;
}

/*
 * Reads until the line CONTAINING marker is complete, i.e. until a
 * newline appears AFTER marker's own position. Needed because a token
 * match like "+NETOPEN:" or "+CMQTTCONNECT: " fires the instant the
 * token itself lands -- before the result value that follows it on the
 * same line has been received. Ported verbatim from
 * cellular-mqtt-test/main_cellular_mqtt_test.cpp -- see that file's own
 * comment on this function for the full truncation-trap explanation.
 */
static bool finish_line_after(String &response, const char *marker, unsigned long timeout_ms)
{
    int marker_idx = response.indexOf(marker);
    if (marker_idx < 0) {
        return false;
    }
    unsigned int search_from = (unsigned int)(marker_idx + strlen(marker));

    unsigned long start = millis();
    for (;;) {
        if (response.indexOf('\n', search_from) >= 0) {
            return true;
        }
        if (millis() - start >= timeout_ms) {
            return false;
        }
        while (SerialAT.available()) {
            response += (char)SerialAT.read();
        }
        delay(1);
    }
}

static void pulse_pwrkey()
{
    digitalWrite(BOARD_PWRKEY_PIN, LOW);
    delay(100);
    digitalWrite(BOARD_PWRKEY_PIN, HIGH);
    delay(MODEM_POWERON_PULSE_WIDTH_MS);
    digitalWrite(BOARD_PWRKEY_PIN, LOW);
}

static void wait_for_modem()
{
    String resp;
    int retry = 0;
    while (!send_at_command("AT", resp, 1000)) {
        Serial.print(".");
        if (++retry > 30) {
            Serial.println();
            Serial.println("[modem] retrying PWRKEY pulse...");
            pulse_pwrkey();
            retry = 0;
        }
    }
    Serial.println();
}

/*
 * GNSS mode/enable AT commands: AT+CGNSSPWR=1 powers the GNSS module
 * on, AT+CGNSSMODE=<mode> sets the constellation mix (mode 15 =
 * GPS+GLONASS+GALILEO+BEIDOU, matches MODEM_GPS_MODE) -- both
 * confirmed against SIMCOM's own SIM767XX Series_AT Command
 * Manual_V1.06 (Sec 21.2.1, Sec 21.2.7). AT+CGNSSINFO (the 1 Hz poll)
 * is also manual-confirmed -- gnss_parser.c's field layout matches
 * Sec 21.2.21 exactly.
 *
 * Call order/structure here is ported from GpsOptimisation.ino's own
 * TinyGSM-based bring-up (modem.setGPSMode() once, no retry, THEN a
 * while(!modem.enableGPS()) retry loop) rather than the manual's
 * stated "CGNSSMODE is valid after GNSS power on" -- an earlier
 * version of this function followed the manual instead (CGNSSPWR
 * first, with a longer per-attempt timeout) and still never got a
 * fix, on hardware confirmed to have the antenna on the correct
 * connector, outdoors, clear sky, several minutes. Reordering to
 * match the sketch's proven structure exactly, since that sketch is
 * known-working on this exact board/modem and the manual can't see
 * what TinyGSM's actual (invisible-to-us) fork implementation bundles
 * together internally when the two calls appear in this order at the
 * application level.
 */
static void gnss_bringup()
{
    Serial.println("[modem] starting UART...");
    SerialAT.begin(MODEM_BAUDRATE, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);

    pinMode(MODEM_DTR_PIN, OUTPUT);
    digitalWrite(MODEM_DTR_PIN, LOW);
    pinMode(BOARD_PWRKEY_PIN, OUTPUT);
    digitalWrite(BOARD_PWRKEY_PIN, LOW);
    pinMode(BOARD_POWER_SAVE_MODE_PIN, OUTPUT);
    digitalWrite(BOARD_POWER_SAVE_MODE_PIN, HIGH);

    Serial.println("[modem] pulsing PWRKEY...");
    pulse_pwrkey();
    delay(MODEM_START_WAIT_MS);

    Serial.println("[modem] waiting for AT response...");
    wait_for_modem();

    String resp;
    send_at_command("ATI", resp, 3000);
    Serial.print("[modem] ATI: ");
    Serial.println(resp);

    /* modem.setGPSMode(GPS_MODE) in the reference sketch: one call, no
     * retry, no error check -- just fired and moved straight on. */
    char mode_cmd[32];
    snprintf(mode_cmd, sizeof(mode_cmd), "AT+CGNSSMODE=%u", (unsigned)MODEM_GPS_MODE);
    Serial.printf("[gnss] setting GNSS mode %u...\n", (unsigned)MODEM_GPS_MODE);
    if (!send_at_command(mode_cmd, resp, 2000)) {
        Serial.print("[gnss] AT+CGNSSMODE did not return OK, response so far: ");
        Serial.println(resp);
    }

    /* while (!modem.enableGPS(gpio, level)) { ... } in the reference
     * sketch. What that call ACTUALLY sends, verbatim from LilyGo's own
     * TinyGSM fork (LilyGo-Modem-Series lib/TinyGSM/src/
     * TinyGsmClientA76xx.h, enableGPSImpl):
     *
     *   AT+CGDRT=<gpio>,1        modem GPIO direction: output
     *   AT+CGSETV=<gpio>,<level> modem GPIO value: high
     *   AT+CGNSSPWR=1            then wait up to 30 s for the URC
     *                            "+CGNSSPWR: READY!" -- NOT just OK
     *
     * The first two drive the modem's GPIO1, which on this board's
     * schematic is the GNSS_ANT_PWR net: it enables the power rail for
     * the active GNSS antenna. An earlier version of this function sent
     * only AT+CGNSSPWR=1 and accepted the immediate OK -- so the
     * antenna was never powered and the GNSS engine's readiness was
     * never actually awaited, producing endless "no fix" with every
     * command reporting success.
     *
     * Unlike the fork, no blocking wait for the "+CGNSSPWR: READY!"
     * URC here: observed on real hardware (V1.9.05) that the URC
     * doesn't reliably arrive within 30 s even when the engine is fine,
     * and gating on it just stalled the 1 Hz polling loop. Polling
     * AT+CGNSSINFO against a still-booting engine is harmless (the
     * no-fix and error responses are both handled), so the continuous
     * poll IS the retry -- fire the enable commands, log any failures,
     * and let gnss_matcher_task take it from there immediately. */
    Serial.println("[gnss] powering GNSS antenna rail + engine...");
    char gpio_cmd[32];
    snprintf(gpio_cmd, sizeof(gpio_cmd), "AT+CGDRT=%u,1", (unsigned)MODEM_GPS_ENABLE_GPIO);
    if (!send_at_command(gpio_cmd, resp, 2000)) {
        Serial.print("[gnss] AT+CGDRT failed (antenna rail may be unpowered): ");
        Serial.println(resp);
    }
    snprintf(gpio_cmd, sizeof(gpio_cmd), "AT+CGSETV=%u,%u",
             (unsigned)MODEM_GPS_ENABLE_GPIO, (unsigned)MODEM_GPS_ENABLE_LEVEL);
    if (!send_at_command(gpio_cmd, resp, 2000)) {
        Serial.print("[gnss] AT+CGSETV failed (antenna rail may be unpowered): ");
        Serial.println(resp);
    }

    if (send_at_command("AT+CGNSSPWR=1", resp, 10000)) {
        Serial.println("[gnss] power-on accepted, engine booting -- polling starts now.");
    } else {
        Serial.print("[gnss] AT+CGNSSPWR=1 did not return OK, response: ");
        Serial.println(resp);
        Serial.println("[gnss] continuing anyway -- polling will report no fix");
    }

    /* modem.setGPSBaud(115200) in the reference sketch. */
    send_at_command("AT+CGNSSIPR=115200", resp, 2000);
}

/* ---- Cellular network + MQTT bring-up (Stage 7) --------------------
 * Same modem, same SerialAT, run AFTER gnss_bringup() has already
 * powered the modem on and started the GNSS engine -- registering on
 * LTE and opening a data/MQTT session doesn't interfere with the GNSS
 * engine, they're independent subsystems on this chip.
 *
 * Every function here is ported from
 * cellular-mqtt-test/main_cellular_mqtt_test.cpp, already validated on
 * real hardware in that standalone harness, including its
 * retry-instead-of-halt-once bring-up hardening (see that file's own
 * comments for the AT-command sourcing/vendor-manual citations). The
 * one behavioural difference: cellular_mqtt_bringup() below returns a
 * bool instead of halting on failure -- see this file's header comment
 * for why SD/Serial logging must keep working even without cellular.
 *
 * wait_for_sim_ready()/wait_for_network_registration()/set_apn() below
 * are called exactly once, from setup(), before gnss_matcher_task exists
 * -- no contention with Core 0 is possible yet at that point, so unlike
 * everything below them they are deliberately NOT wrapped in
 * s_at_mutex. net_open()/mqtt_start()/mqtt_connect()/mqtt_publish()/
 * mqtt_connected() ARE guarded: cellular_mqtt_bringup() (which calls the
 * first three) is also called later from loop(), by which point Core 0
 * is actively polling AT+CGNSSINFO, and mqtt_publish()/mqtt_connected()
 * are only ever called from loop() in the first place. Known
 * simplification, inherited unchanged from cellular-mqtt-test: the
 * modem's async +CMQTTCONNLOST URC (a broker-side disconnect) isn't
 * handled directly -- it's only caught reactively, either by the next
 * mqtt_publish() failing or by mqtt_connected()'s periodic check. */

static bool wait_for_sim_ready(unsigned long timeout_ms = 15000)
{
    String resp;
    unsigned long start = millis();
    while (millis() - start < timeout_ms) {
        if (send_at_command("AT+CPIN?", resp, 3000) && resp.indexOf("READY") >= 0) {
            return true;
        }
        Serial.println("[sim] not ready yet (locked? not inserted?), retrying...");
        delay(1000);
    }
    return false;
}

static bool wait_for_network_registration(unsigned long timeout_ms = 90000)
{
    String resp;
    unsigned long start = millis();
    while (millis() - start < timeout_ms) {
        char stat = '?';
        if (send_at_command("AT+CEREG?", resp, 3000)) {
            int idx = resp.indexOf("+CEREG: ");
            if (idx >= 0) {
                finish_line_after(resp, "+CEREG: ", 2000);
                int comma = resp.indexOf(',', idx);
                if (comma >= 0 && comma + 1 < (int)resp.length()) {
                    stat = resp[comma + 1];
                    if (stat == '1' || stat == '5') {
                        return true; /* 1 = registered home, 5 = roaming */
                    }
                }
            }
        }

        String csq;
        int rssi = -1;
        if (send_at_command("AT+CSQ", csq, 3000)) {
            int idx = csq.indexOf("+CSQ: ");
            if (idx >= 0) {
                rssi = csq.substring(idx + 6).toInt();
            }
        }
        Serial.printf("[net] not registered yet (CEREG stat=%c, CSQ=%d), retrying...\n", stat, rssi);
        delay(2000);
    }
    return false;
}

static bool set_apn(const char *apn)
{
    String resp;
    char cmd[96];

    if (apn == NULL || apn[0] == '\0') {
        return true; /* blank APN: let the network auto-negotiate */
    }
    snprintf(cmd, sizeof(cmd), "AT+CGDCONT=1,\"IP\",\"%s\"", apn);
    if (!send_at_command(cmd, resp, 3000)) {
        Serial.println("[net FAIL] AT+CGDCONT rejected -- check CELLULAR_APN in config.h");
        return false;
    }
    return true;
}

/* Mutex-guarded from here down -- see s_at_mutex's comment. Each
 * function takes the mutex once at entry and gives it back before every
 * return, so the whole AT exchange it performs (including any async URC
 * wait) is atomic with respect to gnss_matcher_task's own AT traffic. */

#if DEBUG_MODE_ENABLED
/* Drains and discards any further bytes for up to max_ms, exiting early
 * (~50ms) once a beat passes with nothing new. Real hardware confirmed
 * several fire-and-forget AT commands here (AT+NETCLOSE, AT+CMQTTSTOP,
 * AT+CMQTTPUB at least) each trigger their own delayed async
 * confirmation URC ("+NETCLOSE: 0", "+CMQTTSTOP: 0", "+CMQTTPUB: 0,0")
 * that this code has always ignored -- harmless normally, since the
 * next AT command's own opening flush would just discard them for free.
 * Not harmless once DEBUG_MODE_ENABLED: that same flush now redirects
 * into s_incoming_buf instead of discarding (see
 * send_at_command_expect()'s comment), specifically so a genuinely
 * unsolicited incoming-push URC is never silently eaten -- but that
 * means this routine confirmation noise piles up in the SAME buffer,
 * burying the one signal actually being watched for. Called at the tail
 * of net_open()/mqtt_start()/mqtt_publish(), right before releasing
 * s_at_mutex, so their own known-noisy trailing URC never reaches
 * s_incoming_buf at all. Not needed outside DEBUG_MODE_ENABLED, so this
 * whole function (and its call sites) are compiled out entirely then --
 * zero cost, zero behaviour change, to the regular build. */
static void at_drain_trailing_noise(unsigned long max_ms)
{
    unsigned long start = millis();
    while (millis() - start < max_ms) {
        bool got_any = false;
        while (SerialAT.available()) {
            SerialAT.read();
            got_any = true;
        }
        if (!got_any) {
            delay(50);
            if (!SerialAT.available()) {
                break;
            }
        }
    }
}
#endif /* DEBUG_MODE_ENABLED */

static bool net_open()
{
    xSemaphoreTake(s_at_mutex, portMAX_DELAY);
    String resp;
    bool ok;

    send_at_command("AT+NETCLOSE", resp, 3000); /* clean slate; failure here is fine (nothing was open) */

    if (!send_at_command_expect("AT+NETOPEN", resp, "+NETOPEN:", 15000)) {
        Serial.println("[net FAIL] AT+NETOPEN got no response");
        ok = false;
    } else {
        finish_line_after(resp, "+NETOPEN:", 5000);
        if (resp.indexOf("+NETOPEN: 0") < 0) {
            Serial.print("[net FAIL] AT+NETOPEN: ");
            Serial.println(resp);
            ok = false;
        } else {
            ok = true;
        }
    }
#if DEBUG_MODE_ENABLED
    at_drain_trailing_noise(300); /* AT+NETCLOSE's own "+NETCLOSE: 0" -- see this function's comment */
#endif
    xSemaphoreGive(s_at_mutex);
    return ok;
}

static bool mqtt_start()
{
    xSemaphoreTake(s_at_mutex, portMAX_DELAY);
    String resp;
    send_at_command("AT+CMQTTDISC=0,120", resp, 3000);
    send_at_command("AT+CMQTTREL=0", resp, 3000);
    send_at_command("AT+CMQTTSTOP", resp, 3000);
    delay(20);

    bool ok = send_at_command_expect("AT+CMQTTSTART", resp, "+CMQTTSTART: 0", 30000);
#if DEBUG_MODE_ENABLED
    /* AT+CMQTTDISC/CMQTTREL/CMQTTSTOP each plausibly trigger their own
     * delayed confirmation URC the same way CMQTTSTOP's "+CMQTTSTOP: 0"
     * was confirmed to -- drain generously since three commands' worth
     * of trailing noise could be pending here, not just one. */
    at_drain_trailing_noise(600);
#endif
    xSemaphoreGive(s_at_mutex);
    return ok;
}

static bool mqtt_connect(const char *broker, uint16_t port, const char *client_id)
{
    xSemaphoreTake(s_at_mutex, portMAX_DELAY);
    String resp;
    char cmd[160];
    bool ok;

    snprintf(cmd, sizeof(cmd), "AT+CMQTTACCQ=%d,\"%s\",0", MQTT_CLIENT_INDEX, client_id);
    if (!send_at_command(cmd, resp, 3000)) {
        Serial.println("[mqtt FAIL] AT+CMQTTACCQ rejected");
        xSemaphoreGive(s_at_mutex);
        return false;
    }

    snprintf(cmd, sizeof(cmd), "AT+CMQTTCFG=\"version\",%d,4", MQTT_CLIENT_INDEX); /* MQTT 3.1.1 */
    send_at_command(cmd, resp, 30000);

    snprintf(cmd, sizeof(cmd), "AT+CMQTTCONNECT=%d,\"tcp://%s:%u\",%lu,1",
             MQTT_CLIENT_INDEX, broker, (unsigned)port, MQTT_KEEPALIVE_S);
    if (!send_at_command(cmd, resp, 30000)) {
        Serial.println("[mqtt FAIL] AT+CMQTTCONNECT got no OK");
        xSemaphoreGive(s_at_mutex);
        return false;
    }
    resp = "";
    if (!wait_for_token(resp, "+CMQTTCONNECT: ", 30000)) {
        Serial.println("[mqtt FAIL] no +CMQTTCONNECT result line");
        xSemaphoreGive(s_at_mutex);
        return false;
    }
    finish_line_after(resp, "+CMQTTCONNECT: ", 5000);
    int comma = resp.indexOf(',');
    if (comma < 0 || comma + 1 >= (int)resp.length() || resp[comma + 1] != '0') {
        Serial.print("[mqtt FAIL] +CMQTTCONNECT result: ");
        Serial.println(resp);
        ok = false;
    } else {
        ok = true;
    }
    xSemaphoreGive(s_at_mutex);
    return ok;
}

static bool mqtt_publish(const char *topic, const char *payload)
{
    xSemaphoreTake(s_at_mutex, portMAX_DELAY);
    String resp;
    char cmd[64];

    snprintf(cmd, sizeof(cmd), "AT+CMQTTTOPIC=%d,%u", MQTT_CLIENT_INDEX, (unsigned)strlen(topic));
    if (!send_at_command_expect(cmd, resp, ">", 10000)) {
        Serial.println("[mqtt FAIL] AT+CMQTTTOPIC got no '>' prompt");
        xSemaphoreGive(s_at_mutex);
        return false;
    }
    SerialAT.println(topic);
    resp = "";
    if (!wait_for_token(resp, "\r\nOK\r\n", 3000)) {
        Serial.println("[mqtt FAIL] topic write not OK'd");
        xSemaphoreGive(s_at_mutex);
        return false;
    }

    snprintf(cmd, sizeof(cmd), "AT+CMQTTPAYLOAD=%d,%u", MQTT_CLIENT_INDEX, (unsigned)strlen(payload));
    if (!send_at_command_expect(cmd, resp, ">", 10000)) {
        Serial.println("[mqtt FAIL] AT+CMQTTPAYLOAD got no '>' prompt");
        xSemaphoreGive(s_at_mutex);
        return false;
    }
    SerialAT.println(payload);
    resp = "";
    if (!wait_for_token(resp, "\r\nOK\r\n", 3000)) {
        Serial.println("[mqtt FAIL] payload write not OK'd");
        xSemaphoreGive(s_at_mutex);
        return false;
    }

    /* QoS 0, matching cellular-mqtt-test's own proven value -- NOT QoS 1.
     * An earlier version of this function requested QoS 1 without ever
     * waiting for or checking the completion URC that would confirm the
     * broker actually acked it. That URC's format is no longer a total
     * unknown -- a DEBUG_MODE_ENABLED capture caught "+CMQTTPUB: 0,0"
     * arriving after a QoS-0 publish's own OK, confirming the shape is
     * "+CMQTTPUB: <client_index>,<result>", same as CMQTTCONNECT's. Not
     * wired up here even so: this function's job is still just "publish
     * and report the synchronous OK", and moving to real QoS 1
     * confirmation is a deliberate follow-up, not a side effect of a
     * debug-mode diagnostic fix. */
    snprintf(cmd, sizeof(cmd), "AT+CMQTTPUB=%d,0,60,0", MQTT_CLIENT_INDEX);
    bool ok = send_at_command(cmd, resp, 10000);
    if (!ok) {
        Serial.println("[mqtt FAIL] AT+CMQTTPUB not OK'd");
    }
#if DEBUG_MODE_ENABLED
    at_drain_trailing_noise(300); /* AT+CMQTTPUB's own "+CMQTTPUB: <idx>,<result>" -- see above */
#endif
    xSemaphoreGive(s_at_mutex);
    return ok;
}

/* AT+CMQTTDISC? -> "+CMQTTDISC: <client_index>,<status>" -- status 0
 * means still connected. */
static bool mqtt_connected()
{
    xSemaphoreTake(s_at_mutex, portMAX_DELAY);
    String resp;
    bool ok;
    if (!send_at_command("AT+CMQTTDISC?", resp, 5000)) {
        ok = false;
    } else {
        int idx = resp.indexOf("+CMQTTDISC: ");
        if (idx < 0) {
            ok = false;
        } else {
            int comma = resp.indexOf(',', idx);
            ok = comma >= 0 && comma + 1 < (int)resp.length() && resp[comma + 1] == '0';
        }
    }
    xSemaphoreGive(s_at_mutex);
    return ok;
}

static char s_mqtt_topic[64];
static char s_mqtt_client_id[32];

#if DEBUG_MODE_ENABLED
static char s_debug_topic[64]; /* lrv/{FLEET}/{LRV_ID}/debug -- device publishes, phone/backend subscribes */
static char s_cmd_topic[64];   /* lrv/{FLEET}/{LRV_ID}/cmd   -- device subscribes, phone/backend publishes */

/*
 * Subscribes to s_cmd_topic. UNVERIFIED against real hardware -- see this
 * file's header comment. Follows the same topic-then-payload two-step
 * shape as AT+CMQTTTOPIC/AT+CMQTTPAYLOAD (proven in mqtt_publish()):
 * AT+CMQTTSUBTOPIC=<client_index>,<topic_len>,<qos> gets a '>' prompt,
 * then the raw topic bytes; AT+CMQTTSUB=<client_index> actually
 * subscribes. QoS 1 so the broker retries delivery of a command sent
 * while briefly disconnected -- matching CLAUDE.md's remote-correction
 * design note, which this reuses the same subscribe path for later. */
static bool mqtt_subscribe(const char *topic)
{
    xSemaphoreTake(s_at_mutex, portMAX_DELAY);
    String resp;
    char cmd[64];

    /* Real hardware (SIM7670G-MNGV V1.9.05), confirmed via
     * debug_query_at_syntax(): AT+CMQTTSUBTOPIC does not exist on this
     * firmware (ERROR to its own "=?" query) -- the original two-step
     * publish-style TOPIC-then-SUB split this function used was simply
     * wrong. AT+CMQTTSUB=? answered "+CMQTTSUB: (0-1),(1-1024),(0-2),
     * (0-1)" -- <client_index>,<topic_len>,<qos>,<dup>, ONE data-entry
     * command with the same '>' prompt convention CMQTTTOPIC/CMQTTPAYLOAD
     * already use (proven in mqtt_publish()), just not split across two
     * commands the way publish is. dup=0 (this is a fresh subscribe, not
     * a retransmit). Still UNVERIFIED past the command's own parameter
     * shape: whether a separate async "+CMQTTSUB: <client_index>,
     * <result>" result line follows the write's OK (mirrored here from
     * CMQTTCONNECT's proven pattern, not itself confirmed) -- if the next
     * real-hardware capture shows "no +CMQTTSUB result line" where the
     * write's OK otherwise looked fine, that's the next thing to fix
     * (most likely: this firmware doesn't emit a separate result URC for
     * SUB, so the write's own OK should be treated as success instead). */
    snprintf(cmd, sizeof(cmd), "AT+CMQTTSUB=%d,%u,1,0", MQTT_CLIENT_INDEX, (unsigned)strlen(topic));
    if (!send_at_command_expect(cmd, resp, ">", 10000)) {
        Serial.println("[mqtt FAIL] AT+CMQTTSUB got no '>' prompt");
        Serial.print("[mqtt DEBUG] sent: ");
        Serial.println(cmd);
        Serial.print("[mqtt DEBUG] modem replied: [");
        Serial.print(resp);
        Serial.println("]");
        xSemaphoreGive(s_at_mutex);
        return false;
    }
    SerialAT.println(topic);
    resp = "";
    if (!wait_for_token(resp, "\r\nOK\r\n", 3000)) {
        Serial.println("[mqtt FAIL] subscribe topic write not OK'd");
        Serial.print("[mqtt DEBUG] modem replied: [");
        Serial.print(resp);
        Serial.println("]");
        xSemaphoreGive(s_at_mutex);
        return false;
    }

    resp = "";
    if (!wait_for_token(resp, "+CMQTTSUB: ", 10000)) {
        Serial.println("[mqtt FAIL] topic write OK'd but no +CMQTTSUB result line followed");
        xSemaphoreGive(s_at_mutex);
        return false;
    }
    finish_line_after(resp, "+CMQTTSUB: ", 5000);
    int comma = resp.indexOf(',');
    bool ok = (comma >= 0 && comma + 1 < (int)resp.length() && resp[comma + 1] == '0');
    if (!ok) {
        Serial.print("[mqtt FAIL] +CMQTTSUB result: ");
        Serial.println(resp);
    }
    xSemaphoreGive(s_at_mutex);
    return ok;
}

/* Real hardware (SIM7670G-MNGV V1.9.05) has now returned a fast ERROR to
 * AT+CMQTTSUBTOPIC with plausible parameters -- meaning either the
 * modem doesn't have that command at all, or it exists but wants
 * different arguments; a bare ERROR doesn't distinguish the two. Rather
 * than guess a third syntax blind, ask the modem itself: most SIMCOM AT
 * commands support a `=?` test form that echoes back the parameter list
 * they actually expect. Sends "<base_cmd>=?" and prints whatever comes
 * back -- this is exactly the ground truth needed to fix
 * mqtt_subscribe() for real, once captured from an actual boot. */
static void debug_query_at_syntax(const char *base_cmd)
{
    xSemaphoreTake(s_at_mutex, portMAX_DELAY);
    String resp;
    char cmd[48];
    snprintf(cmd, sizeof(cmd), "%s=?", base_cmd);
    send_at_command(cmd, resp, 5000); /* result ignored -- printing resp either way is the point */
    xSemaphoreGive(s_at_mutex);

    Serial.print("[mqtt DEBUG] ");
    Serial.print(cmd);
    Serial.print(" -> [");
    Serial.print(resp);
    Serial.println("]");
}

/*
 * Non-blocking-ish peek for an unsolicited incoming-publish URC on
 * s_cmd_topic. UNVERIFIED against real hardware -- see this file's
 * header comment. Assumed shape (consistent with how other SIMCOM
 * A76xx-family onboard-MQTT-client URCs are structured, but the exact
 * field layout for THIS firmware has not been confirmed):
 *
 *   +CMQTTRXSTART: <client_index>,<topic_len>,<payload_len>
 *   +CMQTTRXTOPIC: <client_index>,<topic_len>
 *   <topic bytes>
 *   +CMQTTRXPAYLOAD: <client_index>,<payload_len>
 *   <payload bytes>
 *   +CMQTTRXEND: <client_index>
 *
 * Returns true and fills payload_out (topic is not returned -- callers
 * only ever have one subscription, s_cmd_topic, so it's assumed rather
 * than checked) if a complete incoming message was read within
 * timeout_ms of a "+CMQTTRXSTART:" appearing; false otherwise (nothing
 * pending, or malformed/incomplete before timeout -- either way, no
 * partial message is ever handed to the caller).
 */
static bool mqtt_check_incoming(char *payload_out, size_t payload_out_len, unsigned long timeout_ms)
{
    xSemaphoreTake(s_at_mutex, portMAX_DELAY);

    size_t before_len = s_incoming_buf.length();
    while (SerialAT.available()) {
        s_incoming_buf += (char)SerialAT.read();
    }
    if (s_incoming_buf.indexOf("+CMQTTRXSTART:") < 0) {
        /* Diagnostic-only, temporary: the +CMQTTRXSTART: assumption
         * itself is unverified (see this file's header comment), and by
         * design this whole branch is otherwise SILENT so a normal 1 Hz
         * poll with nothing pending doesn't spam the log -- which means
         * if the assumption is wrong, this would previously give zero
         * visibility into what the modem actually sent when a subscribed
         * message arrived. Print it once, only when new bytes actually
         * showed up this poll (not on every empty poll). Remove once
         * mqtt_check_incoming()'s real URC format is confirmed. */
        if (s_incoming_buf.length() != before_len) {
            Serial.print("[mqtt DEBUG] unexpected incoming bytes (no +CMQTTRXSTART: match): [");
            Serial.print(s_incoming_buf);
            Serial.println("]");
        }
        /* Nothing pending -- the common case, every single poll. Don't
         * block waiting for something that may never come. Defensive
         * cap: this branch should never accumulate much (every other AT
         * exchange runs under this same mutex and starts with its own
         * clean read), but if unrelated noise ever did pile up here
         * without matching, don't let it grow unbounded. */
        if (s_incoming_buf.length() > 512) {
            s_incoming_buf = "";
        }
        xSemaphoreGive(s_at_mutex);
        return false;
    }

    /* Something started arriving -- now it's worth waiting out the rest
     * of the sequence properly rather than bailing on this same poll.
     * From here on, every return path prints whatever was actually
     * accumulated before clearing s_incoming_buf: a real +CMQTTRXSTART:
     * match landed (this is no longer a "maybe" -- confirmed on real
     * hardware), so any drop from here on is worth full visibility into,
     * the same "stop guessing, print what actually arrived" pattern that
     * already found the AT+CMQTTSUB fix. */
    if (!wait_for_token(s_incoming_buf, "+CMQTTRXPAYLOAD:", timeout_ms)) {
        Serial.println("[mqtt] incoming message start seen but no +CMQTTRXPAYLOAD -- dropping");
        Serial.print("[mqtt DEBUG] accumulated: [");
        Serial.print(s_incoming_buf);
        Serial.println("]");
        s_incoming_buf = "";
        xSemaphoreGive(s_at_mutex);
        return false;
    }
    if (!finish_line_after(s_incoming_buf, "+CMQTTRXPAYLOAD:", 2000)) {
        Serial.println("[mqtt] incoming message: +CMQTTRXPAYLOAD line never completed -- dropping");
        Serial.print("[mqtt DEBUG] accumulated: [");
        Serial.print(s_incoming_buf);
        Serial.println("]");
        s_incoming_buf = "";
        xSemaphoreGive(s_at_mutex);
        return false;
    }
    if (!wait_for_token(s_incoming_buf, "+CMQTTRXEND:", timeout_ms)) {
        Serial.println("[mqtt] incoming message: no +CMQTTRXEND -- dropping");
        Serial.print("[mqtt DEBUG] accumulated: [");
        Serial.print(s_incoming_buf);
        Serial.println("]");
        s_incoming_buf = "";
        xSemaphoreGive(s_at_mutex);
        return false;
    }

    /* Payload bytes are between the end of the "+CMQTTRXPAYLOAD: ...\n"
     * line and the start of "+CMQTTRXEND:". */
    int payload_line_end = s_incoming_buf.indexOf('\n', s_incoming_buf.indexOf("+CMQTTRXPAYLOAD:"));
    int end_marker = s_incoming_buf.indexOf("+CMQTTRXEND:");
    String resp = s_incoming_buf; /* copy out before clearing -- substring() below reads from this */
    s_incoming_buf = "";
    xSemaphoreGive(s_at_mutex);

    if (payload_line_end < 0 || end_marker < 0 || end_marker <= payload_line_end) {
        Serial.println("[mqtt] incoming message: could not locate payload bounds -- dropping");
        return false;
    }
    String payload = resp.substring(payload_line_end + 1, end_marker);
    payload.trim();
    if (payload.length() == 0 || payload.length() >= payload_out_len) {
        Serial.println("[mqtt] incoming message: empty or too large for buffer -- dropping");
        return false;
    }
    strncpy(payload_out, payload.c_str(), payload_out_len - 1);
    payload_out[payload_out_len - 1] = '\0';
    return true;
}
#endif /* DEBUG_MODE_ENABLED */

/* Tracks whether the underlying AT+NETOPEN data/PDP session is currently
 * believed open, independent of s_mqtt_ready (the MQTT layer on top of
 * it). See cellular_mqtt_bringup()'s comment for why this exists. */
static bool s_net_ready = false;

/* Full net-open + MQTT-start + MQTT-connect chain, each stage retried up
 * to max_attempts_per_stage times before giving up on that stage. Safe
 * to call more than once -- mqtt_start() always tears down any existing
 * client before restarting, so this is exactly what loop() calls again
 * later to reconnect. Does NOT touch SIM/APN/registration -- callers
 * that need those (i.e. only the very first boot) check them separately
 * first.
 *
 * net_open() itself is only called when s_net_ready is false. Originally
 * this ran unconditionally on every call to this function -- meaning
 * every single reconnect attempt did a full AT+NETCLOSE then AT+NETOPEN,
 * even when only the MQTT layer had dropped and the underlying LTE data
 * session was still perfectly fine. s_net_ready skips that churn in the
 * common case (repeated reconnect attempts while genuinely out of
 * coverage, or a broker-side-only hiccup) without ever risking getting
 * stuck: it's set true only after net_open() itself succeeds, and reset
 * false whenever EITHER mqtt_start() or mqtt_connect() ultimately fails
 * after exhausting their own retries -- i.e. any full reconnect failure
 * invalidates the optimistic assumption, so the next attempt starts with
 * a clean net_open() again rather than trusting a possibly-stale belief
 * that the network layer is still up. Deliberately does NOT try to query
 * the modem's actual current network state (e.g. some form of
 * AT+NETOPEN?) to decide this more precisely -- that would need its
 * exact response format confirmed against real hardware/the vendor
 * manual first, which hasn't been done; tracking our own last-known-good
 * state avoids needing to guess at unverified AT behavior.
 *
 * max_attempts_per_stage is a parameter, not a fixed constant, because
 * this function is called from two very different contexts: setup()
 * (before any task exists -- nothing else is waiting on this, so it can
 * afford to be thorough) and loop()'s periodic reconnect check (Core 0
 * is actively producing SegDoneMsg entries into an 8-deep queue the
 * whole time this function blocks -- stacking multiple retries with
 * their multi-second AT timeouts and RETRY_BACKOFF_MS delays inline
 * could block loop() long enough to overflow that queue and silently
 * drop completed segments). setup() passes
 * MQTT_BRINGUP_BOOT_MAX_ATTEMPTS; loop() passes
 * MQTT_BRINGUP_RECONNECT_MAX_ATTEMPTS (1) and just relies on its own
 * MQTT_CHECK_INTERVAL_MS cadence to keep trying -- spread over time
 * instead of stacked inline. The backoff delay is skipped after the
 * LAST attempt in each stage (nothing left to wait for before
 * returning), which matters most when max_attempts_per_stage is 1: it
 * removes what would otherwise be a pointless RETRY_BACKOFF_MS delay on
 * every single failed reconnect tick. */
static bool cellular_mqtt_bringup(uint8_t max_attempts_per_stage)
{
    if (!s_net_ready) {
        bool net_ok = false;
        for (int attempt = 1; attempt <= max_attempts_per_stage; attempt++) {
            if (net_open()) {
                net_ok = true;
                break;
            }
            Serial.printf("[net] AT+NETOPEN attempt %d/%d failed%s\n",
                          attempt, max_attempts_per_stage,
                          (attempt < max_attempts_per_stage) ? ", retrying..." : "");
            if (attempt < max_attempts_per_stage) {
                delay(RETRY_BACKOFF_MS);
            }
        }
        if (!net_ok) {
            Serial.println("[net FAIL] AT+NETOPEN failed after all retries.");
            return false;
        }
        s_net_ready = true;
    }

    bool mqtt_started = false;
    for (int attempt = 1; attempt <= max_attempts_per_stage; attempt++) {
        if (mqtt_start()) {
            mqtt_started = true;
            break;
        }
        Serial.printf("[mqtt] AT+CMQTTSTART attempt %d/%d failed%s\n",
                      attempt, max_attempts_per_stage,
                      (attempt < max_attempts_per_stage) ? ", retrying..." : "");
        if (attempt < max_attempts_per_stage) {
            delay(RETRY_BACKOFF_MS);
        }
    }
    if (!mqtt_started) {
        Serial.println("[mqtt FAIL] AT+CMQTTSTART failed after all retries.");
        s_net_ready = false; /* don't trust the network layer either -- start clean next time */
        return false;
    }

    bool mqtt_conn_ok = false;
    for (int attempt = 1; attempt <= max_attempts_per_stage; attempt++) {
        if (mqtt_connect(MQTT_HOST, MQTT_PORT, s_mqtt_client_id)) {
            mqtt_conn_ok = true;
            break;
        }
        Serial.printf("[mqtt] connect attempt %d/%d failed%s\n",
                      attempt, max_attempts_per_stage,
                      (attempt < max_attempts_per_stage) ? ", retrying..." : "");
        if (attempt < max_attempts_per_stage) {
            delay(RETRY_BACKOFF_MS);
        }
    }
    if (!mqtt_conn_ok) {
        Serial.println("[mqtt FAIL] MQTT connect failed after all retries.");
        s_net_ready = false; /* don't trust the network layer either -- start clean next time */
        return false;
    }

    Serial.print("[mqtt] connected, publishing to topic: ");
    Serial.println(s_mqtt_topic);
    return true;
}

/* ---- fixed-point -> human-readable rendering ----------------------
 * The GNSS_RAW JSON below is read by a person off the serial monitor
 * and the SD card, so it carries decimal-formatted values rather than
 * the internal fixed-point integers -- an earlier revision printed
 * lat_e7 raw (12937000), which reads as a correct location "missing
 * its decimal point". Rendered with integer arithmetic rather than
 * %f: exact truncation, no rounding surprises, and no float
 * formatting dragged into the 1 Hz path. */

/* degrees*1e7 -> "[-]D.DDDDDD", truncating the 7th decimal place. The
 * modem emits 6 dp, so the 7th is always a trailing zero from our own
 * scaling and nothing real is lost. */
static void format_deg_e7(int32_t deg_e7, char *out, size_t out_len)
{
    uint32_t mag = (uint32_t)((deg_e7 < 0) ? -(int64_t)deg_e7 : (int64_t)deg_e7);
    snprintf(out, out_len, "%s%lu.%06lu",
             (deg_e7 < 0) ? "-" : "",
             (unsigned long)(mag / 10000000UL),
             (unsigned long)((mag % 10000000UL) / 10UL));
}

/* value*10 -> "[-]D.D" -- altitude in metres, and the three DOPs. */
static void format_x10(int32_t v_x10, char *out, size_t out_len)
{
    uint32_t mag = (uint32_t)((v_x10 < 0) ? -(int64_t)v_x10 : (int64_t)v_x10);
    snprintf(out, out_len, "%s%lu.%lu",
             (v_x10 < 0) ? "-" : "",
             (unsigned long)(mag / 10UL),
             (unsigned long)(mag % 10UL));
}

/* Direct AT+CGNSSINFO query, 1 Hz poll. Mutex-guarded (see s_at_mutex's
 * comment) -- this runs on Core 0 and can now race Core 1's MQTT AT
 * traffic over the same UART. */
static bool raw_gnss_query(String &response)
{
    xSemaphoreTake(s_at_mutex, portMAX_DELAY);
    bool ok = send_at_command("AT+CGNSSINFO", response, RAW_GPS_TIMEOUT_MS);
    xSemaphoreGive(s_at_mutex);
    return ok;
}

/* ---- Core 0: IMU sampling task (20 Hz, independent of GNSS) -------- */

static void imu_task(void *arg)
{
    (void)arg;

#if IMU_ENABLED
    bool imu_ready = imu_mpu6050_init(QWIIC_I2C_SDA_PIN, QWIIC_I2C_SCL_PIN);
    if (!imu_ready) {
        Serial.println("[imu] disabled: MPU6050 init failed (device not connected/ACKing on the Qwiic port?)");
        vTaskDelete(NULL); /* nothing more for this task to do -- s_imu_stationary stays
                             * false (moving), so gnss_matcher_task just always polls */
    }

    Serial.println("[imu] MPU6050 init ok, sampling at 20 Hz");

    imu_state_t imu_st;
    imu_state_reset(&imu_st);
    bool was_stationary = false;
    unsigned long last_heartbeat_ms = 0;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(IMU_SAMPLE_INTERVAL_MS));

        int16_t ax, ay, az;
        if (!imu_mpu6050_read_accel(&ax, &ay, &az)) {
            continue; /* I2C read glitch this tick -- try again next tick */
        }
        bool stationary = imu_state_update(&imu_st, ax, ay, az) != 0;
        s_imu_stationary = stationary;

        if (stationary != was_stationary) {
            Serial.println(stationary
                ? "[imu] stationary -- skipping GNSS polling until motion resumes"
                : "[imu] motion detected -- resuming GNSS polling");
            was_stationary = stationary;
            last_heartbeat_ms = millis(); /* transition just reported the state; don't
                                            * immediately repeat it as a heartbeat */
            continue;
        }

        /* Transition-only logging is silent whenever the classification
         * holds steady -- which is most of the time, and is
         * indistinguishable on the monitor from "the IMU task never
         * started at all". A low-rate heartbeat makes the current state
         * (and the fact that the task is alive) observable without
         * flooding the 20 Hz loop into the log. */
        unsigned long now_ms = millis();
        if (now_ms - last_heartbeat_ms >= IMU_HEARTBEAT_INTERVAL_MS) {
            Serial.printf("[imu] state=%s (heartbeat)\n", stationary ? "stationary" : "moving");
            last_heartbeat_ms = now_ms;
        }
    }
#else
    vTaskDelete(NULL); /* IMU_ENABLED=0 -- s_imu_stationary stays false, GNSS always polls */
#endif
}

/* ---- Core 0: GNSS + matcher task ------------------------------------ */

#if DEBUG_MODE_ENABLED
/* Best-effort debug-topic publish -- does NOT touch s_mqtt_ready on
 * failure (that stays single-writer, Core 1 only -- see s_mqtt_ready's
 * own comment); a lost debug packet is just tolerated, unlike a lost
 * SEG_DONE. Safe to call from Core 0 (gnss_matcher_task calls this):
 * mqtt_publish() itself is mutex-guarded, and this only ever READS
 * s_mqtt_ready -- a single-word cross-core read, same pattern already
 * relied on for s_imu_stationary in the other direction. */
static void debug_publish(const char *topic, const char *json)
{
    if (!s_mqtt_ready) {
        return;
    }
    if (!mqtt_publish(topic, json)) {
        Serial.println("[debug] publish failed, dropping this debug packet (best-effort, not retried)");
    }
}
#endif /* DEBUG_MODE_ENABLED */

static void gnss_matcher_task(void *arg)
{
    (void)arg;

    map_matcher_state_t matcher_st;
    map_matcher_init(&matcher_st);

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(SAMPLE_INTERVAL_MS));

        if (s_imu_stationary) {
            continue; /* imu_task already logged the stationary/motion transition */
        }

#if DEBUG_MODE_ENABLED
        if (s_debug_restart_requested) {
            s_debug_restart_requested = false;
            s_debug_raw_sent = 0;
            s_debug_seq_state = s_gnss_ever_locked ? DEBUG_SEQ_SEND_RAW : DEBUG_SEQ_WAIT_LOCK;
            if (s_gnss_ever_locked) {
                /* Already locked before this restart -- announce that
                 * immediately rather than replaying a wait that already
                 * happened; the next valid fix below starts sending raw
                 * packets since s_debug_seq_state is already SEND_RAW. */
                char lock_json[96];
                snprintf(lock_json, sizeof(lock_json),
                    "{\"v\":1,\"ev\":\"DEBUG_GPS_LOCKED\",\"lrv\":\"%s\"}", MQTT_LRV_ID);
                debug_publish(s_debug_topic, lock_json);
            }
        }
#endif

        String raw;
        if (!raw_gnss_query(raw)) {
            Serial.println("[gnss] AT+CGNSSINFO timed out/errored, retrying next tick");
            continue;
        }

        gnss_fix_t fix;
        int parse_rc = gnss_parse_cgnssinfo(raw.c_str(), &fix);
        if (parse_rc != 0) {
            Serial.print("[gnss] AT+CGNSSINFO response did not parse (malformed/truncated), raw: [");
            Serial.print(raw);
            Serial.println("]");
            continue;
        }
        if (!fix.valid) {
            Serial.printf("[gnss] no fix yet (fixMode=%u, nsv=%u)\n",
                           (unsigned)fix.fix_mode, (unsigned)fix.nsv);
#if DEBUG_MODE_ENABLED
            if (s_debug_seq_state == DEBUG_SEQ_WAIT_LOCK) {
                char hb_json[96];
                snprintf(hb_json, sizeof(hb_json),
                    "{\"v\":1,\"ev\":\"DEBUG_HEARTBEAT\",\"lrv\":\"%s\",\"fix_mode\":%u,\"nsv\":%u}",
                    MQTT_LRV_ID, (unsigned)fix.fix_mode, (unsigned)fix.nsv);
                debug_publish(s_debug_topic, hb_json);
            }
#endif
            continue;
        }

        /* Log/print every valid fix -- independent of whether it moves the
         * matcher -- so GNSS acquisition health is visible/verifiable on
         * its own, before trusting the matcher's SEG_DONE output. */
        uint32_t now_s = (fix.utc_epoch_s != 0) ? fix.utc_epoch_s : (uint32_t)(millis() / 1000);

        /* map_matcher_update()'s own contract (map_matcher.h) requires a
         * MONOTONIC clock -- its dwell-time math is a plain subtraction,
         * elapsed = now_s - seg_enter_time_s. now_s above is NOT
         * monotonic across the matcher's lifetime: it's epoch-when-synced,
         * millis()-fallback otherwise, and the very first fix that
         * acquires time sync jumps from a small millis()-based value
         * straight to a real ~1.7-billion-second epoch. Feeding THAT into
         * the matcher made the dwell_s of whichever segment happened to
         * be completing right after sync explode and saturate at 65535 --
         * a real, previously-unflagged bug, not hypothetical. Fixed by
         * giving the matcher its own always-monotonic clock, completely
         * decoupled from GNSS time-sync status; now_s above is still used
         * as before for GNSS_RAW/SEG_DONE's reported "t" (where a real
         * wall-clock epoch, falling back to millis() only when unsynced,
         * is exactly what's wanted). */
        uint32_t mono_now_s = (uint32_t)(millis() / 1000);

        char lat_s[16], lon_s[16], alt_s[12];
        char pdop_s[8], hdop_s[8], vdop_s[8];
        char date_s[11], time_s[9];

        format_deg_e7(fix.lat_e7, lat_s, sizeof(lat_s));
        format_deg_e7(fix.lon_e7, lon_s, sizeof(lon_s));
        format_x10(fix.alt_m_x10, alt_s, sizeof(alt_s));
        format_x10(fix.pdop_x10, pdop_s, sizeof(pdop_s));
        format_x10(fix.hdop_x10, hdop_s, sizeof(hdop_s));
        format_x10(fix.vdop_x10, vdop_s, sizeof(vdop_s));

        /* Date/time come from the fix's OWN UTC fields, shifted to SGT.
         * If those didn't parse (utc_epoch_s == 0) emit empty strings
         * rather than a bogus 1970 date -- now_s falls back to millis()
         * for the matcher, but millis() is not a wall clock and must
         * never be rendered as one. */
        if (fix.utc_epoch_s != 0) {
            gnss_format_datetime(fix.utc_epoch_s, GNSS_TZ_OFFSET_S_SINGAPORE,
                                 date_s, sizeof(date_s), time_s, sizeof(time_s));
        } else {
            date_s[0] = '\0';
            time_s[0] = '\0';
        }

        /* lrv: added so a GNSS_RAW line is self-describing once it
         * leaves the device (SD upload, or any future MQTT publish) --
         * the file/topic it arrived on is not something a database row
         * should have to depend on to know which vehicle it's from.
         * Same field name/value SEG_DONE already uses.
         *
         * t: the fix's own raw UTC epoch (0 if its date/time fields
         * didn't parse -- same sentinel meaning as SEG_DONE's t and as
         * utc_epoch_s itself). date/sgt (local SGT strings, already
         * empty in that same failure case) are kept alongside for
         * human-reading on the serial monitor, but a consumer that
         * wants an unambiguous instant should use t: reconstructing one
         * from date+sgt requires assuming the UTC+8 offset, and gives
         * nothing at all to fall back on for the empty-string case. */
        char raw_json[320];
        snprintf(raw_json, sizeof(raw_json),
            "{\"v\":1,\"ev\":\"GNSS_RAW\",\"lrv\":\"%s\",\"t\":%lu,"
            "\"date\":\"%s\",\"sgt\":\"%s\","
            "\"lat\":%s,\"lon\":%s,\"alt_m\":%s,"
            "\"pdop\":%s,\"hdop\":%s,\"vdop\":%s,\"nsv\":%u}",
            MQTT_LRV_ID, (unsigned long)fix.utc_epoch_s,
            date_s, time_s, lat_s, lon_s, alt_s,
            pdop_s, hdop_s, vdop_s, (unsigned)fix.nsv);
        Serial.println(raw_json);
        sd_log_raw_json(raw_json);

#if DEBUG_MODE_ENABLED
        if (!s_gnss_ever_locked) {
            s_gnss_ever_locked = true;
            if (s_debug_seq_state == DEBUG_SEQ_WAIT_LOCK) {
                char lock_json[96];
                snprintf(lock_json, sizeof(lock_json),
                    "{\"v\":1,\"ev\":\"DEBUG_GPS_LOCKED\",\"lrv\":\"%s\"}", MQTT_LRV_ID);
                debug_publish(s_debug_topic, lock_json);
                s_debug_seq_state = DEBUG_SEQ_SEND_RAW;
                s_debug_raw_sent = 0;
            }
        }
        if (s_debug_seq_state == DEBUG_SEQ_SEND_RAW && s_debug_raw_sent < DEBUG_RAW_PACKET_COUNT) {
            debug_publish(s_debug_topic, raw_json);
            s_debug_raw_sent++;
            if (s_debug_raw_sent >= DEBUG_RAW_PACKET_COUNT) {
                s_debug_seq_state = DEBUG_SEQ_IDLE;
                Serial.println("[debug] boot sequence complete -- debug topic quiet until next debug_start_session");
            }
        }
#endif

        /* Quality gate. Deliberately AFTER the GNSS_RAW print above, so
         * a rejected fix is still visible on the monitor and in
         * gnss_raw.ndjson -- being able to see that the receiver is
         * producing poor fixes (rather than none) is most of the
         * diagnosis when mileage looks wrong. */
        if (fix.pdop_x10 > GNSS_MAX_PDOP_X10 || fix.hdop_x10 > GNSS_MAX_HDOP_X10) {
            Serial.printf("[gnss] fix rejected on quality (pdop=%s, hdop=%s) -- not fed to matcher\n",
                           pdop_s, hdop_s);
            continue;
        }

        map_matcher_event_t ev;
        int fired = map_matcher_update(&matcher_st, TRACK_SEGMENTS, TRACK_NUM_SEGMENTS,
                                        &TRACK_NEXT_FWD[0][0], TRACK_NEXT_FWD_COUNT,
                                        fix.lat_e7, fix.lon_e7, mono_now_s, &ev);
        if (!fired) {
            continue;
        }

        /* One update can establish several completed segments when it
         * bridges a GNSS blackout: the observed one is returned above,
         * any segments credited from the map geometry are drained here.
         * Skipping the drain would silently lose those traversals. */
        do {
            SegDoneMsg msg;
            msg.seg_id = ev.seg_id;
            msg.dir = ev.dir;
            msg.d_mm = ev.d_mm;
            msg.dwell_s = ev.dwell_s;
            msg.inferred = ev.inferred;
            msg.hdop_x10 = fix.hdop_x10;
            msg.nsv = fix.nsv;
            msg.t = now_s;
            msg.t_is_wall_clock = (fix.utc_epoch_s != 0);

            if (xQueueSend(s_matcher_queue, &msg, 0) != pdTRUE) {
                Serial.println("[matcher] queue full, dropping SEG_DONE");
            }
        } while (map_matcher_take_pending(&matcher_st, TRACK_SEGMENTS, &ev));
    }
}

#if DEBUG_MODE_ENABLED
/* ---- Core 1: debug mode command handling ---------------------------- */

/* Dispatches one incoming command payload (from mqtt_check_incoming()).
 * Currently just the one command this feature needs; a real command
 * dispatch table is future work once more commands exist (see
 * CLAUDE.md's remote mileage-correction design note, which this shares
 * s_cmd_topic's subscribe plumbing with). Deliberately a loose substring
 * check ("cmd":"debug_start_session") rather than a real JSON parse --
 * no JSON parser is linked into this harness, and the payload shape is
 * simple/fixed enough that a substring match is fine for a debug-only
 * command channel; revisit if s_cmd_topic ever carries anything with
 * more structure (e.g. the mileage-correction command, which does need
 * a real field like target_km parsed out). */
static void handle_incoming_cmd(const char *payload)
{
    if (strstr(payload, "\"cmd\":\"debug_start_session\"") == NULL) {
        Serial.print("[cmd] unrecognised payload, ignoring: ");
        Serial.println(payload);
        return;
    }

    Serial.println("[cmd] debug_start_session received");
    char session_dir[DEBUG_SD_SESSION_DIR_MAX];
    if (!sd_create_debug_session(session_dir, sizeof(session_dir))) {
        Serial.println("[cmd] debug_start_session failed -- could not create SD folder, not restarting sequence");
        return;
    }

    if (s_mqtt_ready) {
        char ack[128];
        snprintf(ack, sizeof(ack), "{\"v\":1,\"ev\":\"DEBUG_SESSION_START\",\"lrv\":\"%s\",\"folder\":\"%s\"}",
                 MQTT_LRV_ID, session_dir);
        if (!mqtt_publish(s_debug_topic, ack)) {
            /* Same rule as handle_seg_done(): a publish failure marks
             * the link down for loop() to reconnect -- this runs on
             * Core 1 too, so writing s_mqtt_ready here is safe (still
             * single-writer). */
            Serial.println("[cmd] debug session folder created, but the MQTT ack failed to publish -- marking link down");
            s_mqtt_ready = false;
        }
    } else {
        Serial.println("[cmd] debug session folder created, but MQTT link is down -- no ack sent");
    }

    /* gnss_matcher_task (Core 0) picks this up on its next tick and
     * resets the sequence -- see s_debug_restart_requested's comment. */
    s_debug_restart_requested = true;
}
#endif /* DEBUG_MODE_ENABLED */

/* ---- Core 1 (Arduino loop): commit-before-publish + Serial/SD log -- */

static void handle_seg_done(const SegDoneMsg &m)
{
    uint32_t new_seq = seq_store_get_seq() + 1;
    /* Accumulate the segment's calibrated length EXACTLY, in millimetres.
     * This used to round to whole metres per segment, which put a fixed
     * (not random) error of up to +/-0.5 m on every traversal of a given
     * segment -- errors that therefore accumulate linearly under any
     * asymmetric duty cycle instead of cancelling. */
    int64_t new_odo_mm = seq_store_get_odo_mm() + m.d_mm;

    if (seq_store_commit(new_seq, new_odo_mm) != 0) {
        Serial.println("[commit FAIL] NVS commit failed -- event NOT logged (commit-before-publish)");
        return;
    }

    evt_seg_done_t ev = {};
    ev.lrv_id = MQTT_LRV_ID;
    ev.seq = new_seq;
    ev.t = m.t;
    ev.seg_id = m.seg_id;
    ev.dir = m.dir;
    ev.d_mm = m.d_mm;
    ev.odo_mm = new_odo_mm;
    ev.hdop_x10 = m.hdop_x10;
    ev.nsv = m.nsv;
    ev.dwell_s = m.dwell_s;

    char json[EVT_JSON_MAX];
    int n = evt_serialize_seg_done(&ev, json, sizeof(json));
    if (n < 0) {
        Serial.println("[serialize FAIL] evt_serialize_seg_done rejected the event");
        return;
    }

    /* Serial-only human-readable SGT stamp, same date/time format and
     * conversion as the GNSS_RAW line -- NOT part of the Tier 1 JSON
     * contract above (that stays frozen, byte-for-byte, for the ingest
     * bridge). Empty if m.t was a millis() fallback rather than a real
     * epoch (m.t_is_wall_clock == false) -- never render a fallback
     * clock value as if it were a wall-clock date. */
    char date_s[11], time_s[9];
    if (m.t_is_wall_clock) {
        gnss_format_datetime(m.t, GNSS_TZ_OFFSET_S_SINGAPORE, date_s, sizeof(date_s), time_s, sizeof(time_s));
    } else {
        date_s[0] = '\0';
        time_s[0] = '\0';
    }
    Serial.printf("{\"date\":\"%s\",\"sgt\":\"%s\",\"src\":\"%s\"}\n",
                   date_s, time_s, m.inferred ? "inferred" : "measured");

    Serial.println(json);
    sd_log_json(json);

    /* MQTT is best-effort on top of the SD/Serial log above, never a
     * substitute for it -- SD already has this event durably logged by
     * the time we get here regardless of what happens next. A publish
     * failure just marks the link down; it does NOT retry inline (that
     * would block the matcher queue drain on a slow/blocked AT
     * exchange) and does NOT re-queue the event -- loop()'s periodic
     * check reconnects in the background, and the NEXT SEG_DONE (or a
     * future backfill-from-SD pass, not yet built) is what actually
     * gets sent once the link is back.
     *
     * A single mqtt_publish() call is bounded (each of its five AT
     * sub-exchanges has its own timeout, ~36 s worst case if every one
     * of them stalls right up to its limit) but not retried internally,
     * so a burst of several SegDoneMsg entries drained back-to-back
     * (e.g. after map_matcher_take_pending() credits multiple segments
     * across a blackout bridge) is self-limiting rather than
     * compounding: the FIRST failure in the burst flips s_mqtt_ready to
     * false immediately, so every subsequent message in the same burst
     * skips straight past this block with no AT traffic at all. */
    if (s_mqtt_ready) {
        if (!mqtt_publish(s_mqtt_topic, json)) {
            Serial.println("[mqtt] publish failed -- marking link down, loop() will reconnect");
            s_mqtt_ready = false;
        }
    }
}

void setup()
{
    Serial.begin(115200);
    /* Native USB-CDC serial re-enumerates on reset/power-cycle. Serial's
     * own "connected" flag isn't a fully reliable signal for "a monitor
     * has actually attached" across ESP32 Arduino core versions/host
     * OSes -- keep the bounded wait as a fast path, but also repeat the
     * boot line for a few seconds so a monitor attaching anywhere in
     * that window still catches it (see the Stage 6 harness for the
     * fuller explanation). */
    unsigned long serial_wait_start = millis();
    while (!Serial && millis() - serial_wait_start < 3000) {
        delay(10);
    }
    delay(100);

    /* Must exist before gnss_matcher_task is created below, and before
     * any of the mutex-guarded AT functions run (net_open()/mqtt_start()/
     * mqtt_connect() are called later in this function) -- see
     * s_at_mutex's own comment. */
    s_at_mutex = xSemaphoreCreateMutex();
    /* Same reasoning, for SD/SPI access -- see s_sd_mutex's own comment. */
    s_sd_mutex = xSemaphoreCreateMutex();

    seq_store_init();
    sd_init_log_dir();

    char boot_banner[80];
    snprintf(boot_banner, sizeof(boot_banner), "[boot] resumed seq=%lu, sd=%s",
             (unsigned long)seq_store_get_seq(), s_sd_ready ? "ok" : "FAILED");
    for (int i = 0; i < 5; i++) {
        Serial.println(boot_banner);
        delay(600);
    }

    gnss_bringup();

    /* Cellular MQTT bring-up (Stage 7) -- deliberately NOT fatal. SIM/
     * APN/registration are each checked exactly once, here at boot, and
     * s_cellular_provisioned only latches true if ALL THREE succeed --
     * that's what loop() checks before ever retrying (see loop()'s own
     * comment). net_open/mqtt_start/mqtt_connect are also re-run later
     * from loop() via cellular_mqtt_bringup(), which is the part that
     * legitimately can be transient (coverage gaps, broker hiccups) and
     * so IS worth retrying on a timer. Any failure at any stage just
     * leaves s_mqtt_ready false and moves on -- GNSS/matcher/SD/Serial
     * logging must work with zero cellular coverage, exactly as this
     * file did before Stage 7. */
    Serial.println("[net] checking SIM...");
    if (!wait_for_sim_ready()) {
        Serial.println("[net] SIM never reported READY -- continuing without cellular MQTT (SD/Serial only)");
    } else {
        Serial.println("[sim] ready");
        snprintf(s_mqtt_client_id, sizeof(s_mqtt_client_id), "lrv-%s-matcher", MQTT_LRV_ID);
        snprintf(s_mqtt_topic, sizeof(s_mqtt_topic), "lrv/%s/%s/events", MQTT_FLEET, MQTT_LRV_ID);
#if DEBUG_MODE_ENABLED
        snprintf(s_debug_topic, sizeof(s_debug_topic), "lrv/%s/%s/debug", MQTT_FLEET, MQTT_LRV_ID);
        snprintf(s_cmd_topic, sizeof(s_cmd_topic), "lrv/%s/%s/cmd", MQTT_FLEET, MQTT_LRV_ID);
#endif

        if (!set_apn(CELLULAR_APN)) {
            Serial.println("[net] could not set APN -- continuing without cellular MQTT (SD/Serial only)");
        } else {
            Serial.println("[net] waiting for LTE registration...");
            if (!wait_for_network_registration()) {
                Serial.println("[net] never registered -- continuing without cellular MQTT (SD/Serial only)");
            } else {
                Serial.println("[net] registered");
                s_cellular_provisioned = true;
                s_mqtt_ready = cellular_mqtt_bringup(MQTT_BRINGUP_BOOT_MAX_ATTEMPTS);
                if (!s_mqtt_ready) {
                    Serial.println("[mqtt] bring-up failed -- continuing without cellular MQTT (SD/Serial only), will retry from loop()");
                }
#if DEBUG_MODE_ENABLED
                if (s_mqtt_ready) {
                    /* Diagnostic-only, temporary: real hardware has
                     * rejected AT+CMQTTSUBTOPIC with a fast ERROR
                     * (unverified syntax, guessed twice, both wrong so
                     * far) -- ask the modem for its own expected syntax
                     * before trying again, rather than guess a third
                     * time. Remove once mqtt_subscribe() is confirmed
                     * working against real hardware. */
                    debug_query_at_syntax("AT+CMQTTSUBTOPIC");
                    debug_query_at_syntax("AT+CMQTTSUB");

                    Serial.print("[cmd] subscribing to ");
                    Serial.println(s_cmd_topic);
                    if (!mqtt_subscribe(s_cmd_topic)) {
                        Serial.println("[cmd] subscribe failed -- debug_start_session command will not be "
                                        "received until the next successful reconnect re-subscribes");
                    }
                }
#endif
            }
        }
    }
    s_last_mqtt_check_ms = millis();
#if DEBUG_MODE_ENABLED
    /* Boot-time debug sequence starts immediately, independent of
     * whether cellular/MQTT bring-up above actually succeeded -- the
     * heartbeats/lock-notice/raw-packets it produces publish over MQTT
     * only when s_mqtt_ready (see gnss_matcher_task), same best-effort
     * rule as SEG_DONE. */
    s_debug_seq_state = DEBUG_SEQ_WAIT_LOCK;
#endif

    s_matcher_queue = xQueueCreate(8, sizeof(SegDoneMsg));

    xTaskCreatePinnedToCore(imu_task, "imu", 4096, nullptr, 1, nullptr, 0 /* Core 0 */);
    xTaskCreatePinnedToCore(gnss_matcher_task, "gnss_matcher", 8192, nullptr, 1, nullptr, 0 /* Core 0 */);
}

void loop()
{
    SegDoneMsg msg;
    if (xQueueReceive(s_matcher_queue, &msg, 0) == pdTRUE) {
        handle_seg_done(msg);
    }

    /* Periodic cellular MQTT health check/reconnect -- same
     * MQTT_CHECK_INTERVAL_MS cadence as cellular-mqtt-test. Gated on
     * s_cellular_provisioned, NOT on s_mqtt_client_id being non-empty:
     * client_id/topic are populated as soon as the SIM reports ready,
     * before APN/registration are even attempted, so checking THAT
     * alone would keep retrying net_open() forever even when APN setup
     * or registration failed at boot -- neither of which fixes itself
     * on a timer. s_cellular_provisioned only latches true once SIM+
     * APN+registration ALL succeeded in setup(), which is the actual
     * "worth retrying" condition. Uses
     * MQTT_BRINGUP_RECONNECT_MAX_ATTEMPTS (1 attempt per stage, not
     * setup()'s more thorough budget) so a bad link can't block this
     * loop -- and therefore the SegDoneMsg queue drain right above --
     * for minutes; see cellular_mqtt_bringup()'s own comment. */
    unsigned long now = millis();
    if (now - s_last_mqtt_check_ms >= MQTT_CHECK_INTERVAL_MS) {
        s_last_mqtt_check_ms = now;
        if (s_cellular_provisioned) {
            if (s_mqtt_ready && !mqtt_connected()) {
                Serial.println("[mqtt] connection lost, will reconnect");
                s_mqtt_ready = false;
            }
            if (!s_mqtt_ready) {
                s_mqtt_ready = cellular_mqtt_bringup(MQTT_BRINGUP_RECONNECT_MAX_ATTEMPTS);
#if DEBUG_MODE_ENABLED
                /* A reconnect means a fresh AT+CMQTTCONNECT session on
                 * the modem -- the old subscription does not carry over,
                 * so without this the debug_start_session command would
                 * go silently unheard after any connection blip. */
                if (s_mqtt_ready && !mqtt_subscribe(s_cmd_topic)) {
                    Serial.println("[cmd] re-subscribe after reconnect failed -- "
                                    "debug_start_session command will not be received");
                }
#endif
            }
        }
    }

#if DEBUG_MODE_ENABLED
    /* Poll for an incoming debug_start_session command. Runs on its own
     * cadence (DEBUG_INCOMING_CHECK_INTERVAL_MS), independent of the
     * MQTT health-check cadence above -- a command should be noticed
     * quickly, not only once a minute. Only worth polling once actually
     * subscribed (s_mqtt_ready and s_cmd_topic populated); mqtt_check_incoming()
     * itself is cheap/non-blocking when nothing is pending. Real hardware
     * confirmed +CMQTTRXSTART: itself arrives, but the rest of the
     * sequence didn't complete within the previous 500ms budget -- bumped
     * to 3000ms in case that was simply too tight for the modem to finish
     * the URC once it starts (only paid when a message actually starts
     * arriving, not on the common empty poll). */
    static unsigned long s_last_cmd_check_ms = 0;
    if (s_mqtt_ready && now - s_last_cmd_check_ms >= DEBUG_INCOMING_CHECK_INTERVAL_MS) {
        s_last_cmd_check_ms = now;
        char payload[128];
        if (mqtt_check_incoming(payload, sizeof(payload), 3000)) {
            handle_incoming_cmd(payload);
        }
    }
#endif

    delay(20);
}
