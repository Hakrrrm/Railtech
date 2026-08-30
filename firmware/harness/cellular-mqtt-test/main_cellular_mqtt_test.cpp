/*
 * Cellular MQTT bring-up test -- simplest possible proof that the
 * SIM7670G can register on the new SIM's LTE network and publish an
 * MQTT message over it, independent of GNSS/matcher/SD (Stage 5) and
 * independent of Wi-Fi (Stage 3). One thing at a time: get cellular
 * MQTT working on its own before it's combined with anything else.
 *
 * No TinyGSM -- same project-wide constraint as Stage 5, for the same
 * reason: the publicly published vshymanskyy/TinyGSM package has no
 * SIM7670G modem definition at all. Every AT command below was read
 * out of LilyGo's own TinyGSM fork (Xinyuan-LilyGO/LilyGo-Modem-Series,
 * lib/TinyGSM/src/TinyGsmClientA76xx.h + TinyGsmMqttA76xx.h) as
 * documentation only -- recovering the exact bytes a known-working
 * implementation sends for this exact modem family, never linked or
 * included. Same discipline Stage 5's gnss_bringup() already
 * established for AT+CGNSSPWR/AT+CGNSSMODE.
 *
 * Network activation (AT+CGDCONT / AT+NETOPEN) and registration polling
 * (AT+CEREG?) are the minimal sequence SIMCOM's own official "A76XX
 * Series_TCPIP_Application Note_V1.02" documents for this chip family
 * (confirmed: TinyGsmClientA7670.h, which mixes in TinyGsmMqttA76xx.h,
 * is what LilyGo's own MQTT example picks for "A7670X/A7608X/SIM7670G/
 * SIM7600 series") -- see net_open()'s own comment for
 * why two extra commands TinyGSM's helper also sends were dropped after
 * real hardware rejected one of them.
 *
 * MQTT itself uses the MODEM's OWN onboard MQTT client (AT+CMQTT...),
 * not a TCP socket + a software MQTT stack on the ESP32 side. This is
 * a deliberate simplicity choice for a first bring-up test: the modem
 * handles the entire MQTT protocol (CONNECT/PUBLISH/keepalive)
 * internally, so this harness only ever issues AT commands and never
 * has to implement TCP framing or MQTT packet structure itself. Revisit
 * if Stage 7 proper needs the ESP32-side PubSubClient contract instead
 * (e.g. to reuse event_serializer.h's Tier 1 JSON path unchanged).
 *
 * Known simplification, flagged: this reads the whole "OK\r\n" after
 * commands the same way Stage 5's send_at_command() does, and doesn't
 * yet handle the modem's async +CMQTTCONNLOST URC (connection dropped
 * mid-session) -- mqtt_connected() below re-checks and reconnects once
 * a minute, which recovers from that but not instantly. Fine for a
 * bring-up test; revisit for a long-unattended field deployment.
 */
#include <string.h>

#include <Arduino.h>

#include "../../config.h"
#include "../../pins_board.h"

#define SerialAT Serial1
#define MQTT_CLIENT_INDEX 0 /* AT+CMQTT commands take a 0-1 client index; only one client used here */
#define MQTT_KEEPALIVE_S   60UL
#define PUBLISH_INTERVAL_MS 5000UL
#define MQTT_CHECK_INTERVAL_MS 60000UL

/* ---- AT command helper -- same pattern as Stage 5's gnss_bringup() -- */

static bool send_at_command_expect(const char *cmd, String &response,
                                    const char *expect_token,
                                    unsigned long timeout_ms)
{
    response = "";
    while (SerialAT.available()) {
        SerialAT.read();
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
 * mqtt_publish()) rather than to an AT command. response accumulates
 * from wherever the caller left it -- callers that want a clean read
 * should reset it to "" first. */
static bool wait_for_token(String &response, const char *expect_token, unsigned long timeout_ms)
{
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
 * newline appears AFTER marker's own position.
 *
 * Needed because a token match like "+NETOPEN:" or "+CMQTTCONNECT: "
 * fires the instant the token itself lands -- before the result value
 * that follows it on the same line has been received. The obvious fix
 * (wait_for_token(resp, "\r\n", ...)) does NOT work: resp by then
 * already holds the command echo and its "OK\r\n", so a plain search
 * finds one of those EARLIER newlines and returns immediately having
 * read nothing new. Searching only after marker's index is what makes
 * this actually wait for the rest of the line.
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

/* ---- SIM + network registration -------------------------------------
 * AT+CPIN? -> "+CPIN: READY" means the SIM is present, unlocked, and
 * usable. AT+CEREG? -> "+CEREG: <n>,<stat>" -- stat 1 (home) or 5
 * (roaming) means registered on the LTE network; anything else means
 * still searching (or denied). */

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

        /* Report the raw status and signal strength rather than a bare
         * "not registered": stat tells you WHY (2 = still searching,
         * 3 = registration DENIED -- a plan/APN/provisioning problem no
         * amount of waiting fixes), and CSQ separates "no coverage/
         * antenna" from "good signal but the network won't have us".
         * AT+CSQ's first value is 99 when unknown, else 0-31 (higher is
         * better; under ~10 is weak). */
        String csq;
        int rssi = -1;
        if (send_at_command("AT+CSQ", csq, 3000)) {
            int idx = csq.indexOf("+CSQ: ");
            if (idx >= 0) {
                rssi = csq.substring(idx + 6).toInt();
            }
        }
        Serial.printf("[net] not registered yet (CEREG stat=%c, CSQ=%d), retrying...\n", stat, rssi);
        if (stat == '3') {
            Serial.println("[net] stat=3 means registration DENIED -- the network is refusing this SIM.");
            Serial.println("[net] Check the APN, and that the SIM is activated with a data plan.");
        }
        delay(2000);
    }
    return false;
}

/* AT+CGDCONT sets the APN on PDP context 1; AT+NETOPEN actually brings
 * the data connection up ("+NETOPEN: 0" = success).
 *
 * Originally also sent AT+CSOCKSETPN=1,1 and AT+CIPCFG="CID",1 first
 * (lifted from TinyGsmClientA76xx.h's enableIP4(), read as
 * documentation only -- see this file's header comment). On real
 * SIM7670G-MNGV hardware AT+CIPCFG came back ERROR. Checked against
 * SIMCOM's own official "A76XX Series_TCPIP_Application Note_V1.02"
 * (the same chip family LilyGo's own SIM7670G MQTT example targets):
 * neither AT+CSOCKSETPN nor AT+CIPCFG appears ANYWHERE in that manual's
 * AT command list, and its own worked "Configure Context / Activate
 * context" example is exactly AT+CGDCONT then AT+NETOPEN, nothing else.
 * Both extra commands dropped -- they were TinyGSM helper commands for
 * a broader dual-stack (IPv4/IPv6) selection case this modem's firmware
 * doesn't implement/need, not something the modem's own documented
 * minimal bring-up actually requires. Same "real hardware/vendor manual
 * over library abstraction" call already made for GNSS bring-up
 * (gnss_bringup() in Stage 5's harness).
 *
 * The reference fork also tolerates a separate "+IP ERROR: Network is
 * already opened" response as success on AT+NETOPEN, for a caller that
 * might invoke this while a connection is already up -- not handled
 * here (this harness's single-expect-token send_at_command_expect()
 * can't watch for two different response strings at once), sidestepped
 * instead by unconditionally issuing AT+NETCLOSE first for a clean
 * slate, so that case shouldn't arise. Revisit if this function is ever
 * called a second time without an intervening NETCLOSE. */
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

static bool net_open()
{
    String resp;

    send_at_command("AT+NETCLOSE", resp, 3000); /* clean slate; failure here is fine (nothing was open) */

    if (!send_at_command_expect("AT+NETOPEN", resp, "+NETOPEN:", 15000)) {
        Serial.println("[net FAIL] AT+NETOPEN got no response");
        return false;
    }
    /* The token match above lands before the result value on that same
     * line has arrived -- finish the line first (see finish_line_after). */
    finish_line_after(resp, "+NETOPEN:", 5000);
    if (resp.indexOf("+NETOPEN: 0") < 0) {
        Serial.print("[net FAIL] AT+NETOPEN: ");
        Serial.println(resp);
        return false;
    }
    return true;
}

/* ---- MQTT -- the modem's own onboard client, AT+CMQTT* -------------- */

static bool mqtt_start()
{
    String resp;
    /* Clean up any stale session from a previous run/crash before
     * starting fresh -- mirrors TinyGsmMqttA76xx.h's mqtt_begin(), which
     * does the same teardown-then-start sequence. Failures here are
     * expected/harmless when nothing was actually connected. */
    send_at_command("AT+CMQTTDISC=0,120", resp, 3000);
    send_at_command("AT+CMQTTREL=0", resp, 3000);
    send_at_command("AT+CMQTTSTOP", resp, 3000);
    delay(20);

    return send_at_command_expect("AT+CMQTTSTART", resp, "+CMQTTSTART: 0", 30000);
}

static bool mqtt_connect(const char *broker, uint16_t port, const char *client_id)
{
    String resp;
    char cmd[160];

    snprintf(cmd, sizeof(cmd), "AT+CMQTTACCQ=%d,\"%s\",0", MQTT_CLIENT_INDEX, client_id);
    if (!send_at_command(cmd, resp, 3000)) {
        Serial.println("[mqtt FAIL] AT+CMQTTACCQ rejected");
        return false;
    }

    snprintf(cmd, sizeof(cmd), "AT+CMQTTCFG=\"version\",%d,4", MQTT_CLIENT_INDEX); /* MQTT 3.1.1 */
    send_at_command(cmd, resp, 30000);

    snprintf(cmd, sizeof(cmd), "AT+CMQTTCONNECT=%d,\"tcp://%s:%u\",%lu,1",
             MQTT_CLIENT_INDEX, broker, (unsigned)port, MQTT_KEEPALIVE_S);
    if (!send_at_command(cmd, resp, 30000)) {
        Serial.println("[mqtt FAIL] AT+CMQTTCONNECT got no OK");
        return false;
    }
    /* The actual connect result is a separate async URC that arrives
     * once the broker handshake finishes, not part of the OK above --
     * same two-step wait TinyGsmMqttA76xx.h's mqtt_connect() does. */
    resp = "";
    if (!wait_for_token(resp, "+CMQTTCONNECT: ", 30000)) {
        Serial.println("[mqtt FAIL] no +CMQTTCONNECT result line");
        return false;
    }
    /* Same truncation trap as AT+NETOPEN above: the token match fires
     * right after "+CMQTTCONNECT: " itself, before <client_index>,
     * <result> have been read. Finish the line first. */
    finish_line_after(resp, "+CMQTTCONNECT: ", 5000);
    /* "+CMQTTCONNECT: <client_index>,<result>" -- result 0 = success. */
    int comma = resp.indexOf(',');
    if (comma < 0 || comma + 1 >= (int)resp.length() || resp[comma + 1] != '0') {
        Serial.print("[mqtt FAIL] +CMQTTCONNECT result: ");
        Serial.println(resp);
        return false;
    }
    return true;
}

static bool mqtt_publish(const char *topic, const char *payload)
{
    String resp;
    char cmd[64];

    snprintf(cmd, sizeof(cmd), "AT+CMQTTTOPIC=%d,%u", MQTT_CLIENT_INDEX, (unsigned)strlen(topic));
    if (!send_at_command_expect(cmd, resp, ">", 10000)) {
        Serial.println("[mqtt FAIL] AT+CMQTTTOPIC got no '>' prompt");
        return false;
    }
    SerialAT.println(topic);
    resp = "";
    if (!wait_for_token(resp, "\r\nOK\r\n", 3000)) {
        Serial.println("[mqtt FAIL] topic write not OK'd");
        return false;
    }

    snprintf(cmd, sizeof(cmd), "AT+CMQTTPAYLOAD=%d,%u", MQTT_CLIENT_INDEX, (unsigned)strlen(payload));
    if (!send_at_command_expect(cmd, resp, ">", 10000)) {
        Serial.println("[mqtt FAIL] AT+CMQTTPAYLOAD got no '>' prompt");
        return false;
    }
    SerialAT.println(payload);
    resp = "";
    if (!wait_for_token(resp, "\r\nOK\r\n", 3000)) {
        Serial.println("[mqtt FAIL] payload write not OK'd");
        return false;
    }

    snprintf(cmd, sizeof(cmd), "AT+CMQTTPUB=%d,0,60,0", MQTT_CLIENT_INDEX); /* QoS 0, 60s pub timeout, no retain */
    if (!send_at_command(cmd, resp, 10000)) {
        Serial.println("[mqtt FAIL] AT+CMQTTPUB not OK'd");
        return false;
    }
    return true;
}

/* AT+CMQTTDISC? -> "+CMQTTDISC: <client_index>,<status>" -- status 0
 * means still connected (0 = "not disconnected", matching
 * TinyGsmMqttA76xx.h's mqtt_connected()). */
static bool mqtt_connected()
{
    String resp;
    if (!send_at_command("AT+CMQTTDISC?", resp, 5000)) {
        return false;
    }
    int idx = resp.indexOf("+CMQTTDISC: ");
    if (idx < 0) {
        return false;
    }
    int comma = resp.indexOf(',', idx);
    return comma >= 0 && comma + 1 < (int)resp.length() && resp[comma + 1] == '0';
}

/* ---- setup/loop ------------------------------------------------------ */

static uint32_t s_msg_count = 0;
static char s_topic[64];
static unsigned long s_last_publish_ms = 0;
static unsigned long s_last_check_ms = 0;

void setup()
{
    Serial.begin(115200);
    unsigned long serial_wait_start = millis();
    while (!Serial && millis() - serial_wait_start < 3000) {
        delay(10);
    }
    delay(100);

    Serial.println("[boot] cellular MQTT bring-up test");

    pinMode(BOARD_PWRKEY_PIN, OUTPUT);
    SerialAT.begin(MODEM_BAUDRATE, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
    delay(MODEM_START_WAIT_MS);

    Serial.print("[modem] waiting for AT response...");
    wait_for_modem();

    String resp;
    Serial.println("[modem] checking SIM...");
    if (!wait_for_sim_ready()) {
        Serial.println("[FATAL] SIM never reported READY -- check it's inserted and unlocked. Halting.");
        while (1) delay(1000);
    }
    Serial.println("[sim] ready");

    /* Order matters, and an earlier version of this had it backwards:
     * set the APN, then WAIT FOR REGISTRATION, and only then open the
     * network. AT+NETOPEN activates a PDP context, which the network
     * can only grant once the modem is actually registered -- opening
     * first fails (or returns a non-zero result) even though the SIM and
     * APN are both fine. Matches the order LilyGo's own MQTT example
     * uses: setNetworkAPN -> getRegistrationStatus loop ->
     * setNetworkActive. */
    Serial.println("[net] setting APN...");
    if (!set_apn(CELLULAR_APN)) {
        Serial.println("[FATAL] could not set the APN. Halting.");
        while (1) delay(1000);
    }

    Serial.println("[net] waiting for LTE registration...");
    if (!wait_for_network_registration()) {
        Serial.println("[FATAL] never registered on the network -- check antenna, SIM plan/APN, coverage. Halting.");
        while (1) delay(1000);
    }
    Serial.println("[net] registered");

    Serial.println("[net] opening data connection...");
    if (!net_open()) {
        Serial.println("[FATAL] AT+NETOPEN failed even though registered. Halting.");
        while (1) delay(1000);
    }
    Serial.println("[net] data connection open");

    if (send_at_command("AT+IPADDR", resp, 3000)) {
        Serial.print("[net] IP: ");
        Serial.println(resp);
    }

    /* The real SEG_DONE events topic (matches ingest/index.js's
     * EVENTS_TOPIC wildcard "lrv/+/+/events") -- this harness now
     * publishes ingest-shaped packets, so it uses the real topic
     * rather than a standalone "cellular_test" one. */
    snprintf(s_topic, sizeof(s_topic), "lrv/%s/%s/events", MQTT_FLEET, MQTT_LRV_ID);

    Serial.println("[mqtt] starting onboard MQTT client...");
    if (!mqtt_start()) {
        Serial.println("[FATAL] AT+CMQTTSTART failed. Halting.");
        while (1) delay(1000);
    }

    char client_id[32];
    snprintf(client_id, sizeof(client_id), "lrv-%s-cell", MQTT_LRV_ID);
    Serial.printf("[mqtt] connecting to %s:%d as %s...\n", MQTT_HOST, MQTT_PORT, client_id);
    if (!mqtt_connect(MQTT_HOST, MQTT_PORT, client_id)) {
        Serial.println("[FATAL] MQTT connect failed. Halting.");
        while (1) delay(1000);
    }
    Serial.println("[mqtt] connected");
    Serial.print("[mqtt] publishing to topic: ");
    Serial.println(s_topic);

    s_last_publish_ms = millis() - PUBLISH_INTERVAL_MS; /* publish immediately on first loop */
    s_last_check_ms = millis();
}

void loop()
{
    unsigned long now = millis();

    if (now - s_last_check_ms >= MQTT_CHECK_INTERVAL_MS) {
        s_last_check_ms = now;
        if (!mqtt_connected()) {
            Serial.println("[mqtt] connection lost, reconnecting...");
            char client_id[32];
            snprintf(client_id, sizeof(client_id), "lrv-%s-cell", MQTT_LRV_ID);
            if (mqtt_connect(MQTT_HOST, MQTT_PORT, client_id)) {
                Serial.println("[mqtt] reconnected");
            } else {
                Serial.println("[mqtt] reconnect failed, will retry next check");
            }
        }
    }

    if (now - s_last_publish_ms >= PUBLISH_INTERVAL_MS) {
        s_last_publish_ms = now;

        /* Full SEG_DONE shape, matching ingest/event_mapper.js's
         * REQUIRED_FIELDS exactly (field names, types, and the frozen
         * Tier 1 wire contract in event_serializer.h) so this harness's
         * packets exercise the real ingest path end-to-end rather than
         * a synthetic heartbeat the bridge would ignore.
         *
         * seq increments every publish -- segment_traversals has a
         * unique (lrv_id, seq) constraint and the bridge upserts with
         * ignoreDuplicates, so a static seq would insert once and then
         * silently no-op on every later publish. t has no real GNSS/RTC
         * time source in this harness, so it's a synthetic Unix-epoch-
         * shaped placeholder, not a real fix time. seg/dir/d_m/hdop/nsv
         * are fixed plausible values; odo_km increments by d_m each
         * publish, as a real odometer would across repeated segment
         * completions. */
        uint32_t seq = s_msg_count + 1;
        uint32_t t = 1785560670UL + (now / 1000);
        const float d_m = 612.4f;
        const float hdop = 1.4f;
        const int nsv = 19;
        const int dwell_s = 5;
        float odo_km = 128473.9f + (float)s_msg_count * (d_m / 1000.0f);

        char payload[256];
        snprintf(payload, sizeof(payload),
                 "{\"v\":1,\"lrv\":\"%s\",\"seq\":%lu,\"t\":%lu,\"ev\":\"SEG_DONE\","
                 "\"seg\":\"PE3_PE4_E\",\"dir\":\"E\",\"d_m\":%.1f,\"odo_km\":%.1f,"
                 "\"hdop\":%.1f,\"nsv\":%d,\"dwell_s\":%d}",
                 MQTT_LRV_ID, (unsigned long)seq, (unsigned long)t, d_m, odo_km,
                 hdop, nsv, dwell_s);
        if (mqtt_publish(s_topic, payload)) {
            Serial.print("[mqtt] published: ");
            Serial.println(payload);
            s_msg_count++;
        } else {
            Serial.println("[mqtt] publish failed this tick, will retry next interval");
        }
    }

    delay(20);
}
