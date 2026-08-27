#include "seq_store.h"

#include <stdio.h>

#ifdef SEQ_STORE_HOST_STUB

/* ------------------------------------------------------------------
 * Host stub: stands in for ESP32 NVS for host-side (gcc) unit tests.
 * Backed by a plain text file ("seq odo_mm\n") so a "reboot" can be
 * simulated by dropping the RAM cache and re-reading it, matching the
 * durability property the real NVS implementation must have.
 * ------------------------------------------------------------------ */

#include <string.h>

static char s_backing_path[512] = {0};
static int s_have_backing_path = 0;

static uint32_t s_seq = 0;
static int64_t s_odo_mm = 0;
static int s_fail_next_n = 0;

static void load_from_backing_file(void)
{
    s_seq = 0;
    s_odo_mm = 0;
    if (!s_have_backing_path) {
        return;
    }
    FILE *f = fopen(s_backing_path, "r");
    if (f == NULL) {
        return; /* no prior commit -- defaults stand */
    }
    unsigned long long seq_in = 0;
    long long odo_in = 0;
    if (fscanf(f, "%llu %lld", &seq_in, &odo_in) == 2) {
        s_seq = (uint32_t)seq_in;
        s_odo_mm = (int64_t)odo_in;
    }
    fclose(f);
}

void seq_store_init(void)
{
    s_fail_next_n = 0;
    load_from_backing_file();
}

uint32_t seq_store_get_seq(void)
{
    return s_seq;
}

int64_t seq_store_get_odo_mm(void)
{
    return s_odo_mm;
}

int seq_store_commit(uint32_t new_seq, int64_t new_odo_mm)
{
    if (s_fail_next_n > 0) {
        s_fail_next_n--;
        return -1;
    }

    if (s_have_backing_path) {
        FILE *f = fopen(s_backing_path, "w");
        if (f == NULL) {
            return -1;
        }
        if (fprintf(f, "%u %lld\n", new_seq, (long long)new_odo_mm) < 0) {
            fclose(f);
            return -1;
        }
        if (fflush(f) != 0) {
            fclose(f);
            return -1;
        }
        fclose(f);
    }

    s_seq = new_seq;
    s_odo_mm = new_odo_mm;
    return 0;
}

void seq_store_host_set_backing_file(const char *path)
{
    if (path == NULL) {
        s_have_backing_path = 0;
        s_backing_path[0] = '\0';
        return;
    }
    strncpy(s_backing_path, path, sizeof(s_backing_path) - 1);
    s_backing_path[sizeof(s_backing_path) - 1] = '\0';
    s_have_backing_path = 1;
}

void seq_store_host_simulate_reboot(void)
{
    load_from_backing_file();
}

void seq_store_host_fail_next_commits(int n)
{
    s_fail_next_n = n;
}

#else /* !SEQ_STORE_HOST_STUB -- ESP32 target build */

#include "nvs.h"
#include "nvs_flash.h"

#define SEQ_STORE_NVS_NAMESPACE "odo"
#define SEQ_STORE_KEY_SEQ "seq"
#define SEQ_STORE_KEY_ODO_M  "odo_m"  /* legacy, integer metres -- read once for migration */
#define SEQ_STORE_KEY_ODO_MM "odo_mm" /* current, millimetres */

static uint32_t s_seq = 0;
static int64_t s_odo_mm = 0;
static nvs_handle_t s_handle;
static int s_handle_valid = 0;

void seq_store_init(void)
{
    s_seq = 0;
    s_odo_mm = 0;
    s_handle_valid = 0;

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        return;
    }

    err = nvs_open(SEQ_STORE_NVS_NAMESPACE, NVS_READWRITE, &s_handle);
    if (err != ESP_OK) {
        return;
    }
    s_handle_valid = 1;

    uint32_t seq_val = 0;
    if (nvs_get_u32(s_handle, SEQ_STORE_KEY_SEQ, &seq_val) == ESP_OK) {
        s_seq = seq_val;
    }
    /* Odometer is stored in millimetres under its own key. A device
     * flashed before that change has only the legacy integer-metre key,
     * so promote it once rather than reinterpreting it -- reading a
     * metres value as millimetres would silently divide the accumulated
     * odometer by 1000. The legacy key is deliberately left in place: it
     * is harmless once odo_mm exists, and keeping it means a rollback to
     * older firmware still finds the reading it expects. */
    int64_t odo_val = 0;
    if (nvs_get_i64(s_handle, SEQ_STORE_KEY_ODO_MM, &odo_val) == ESP_OK) {
        s_odo_mm = odo_val;
    } else if (nvs_get_i64(s_handle, SEQ_STORE_KEY_ODO_M, &odo_val) == ESP_OK) {
        s_odo_mm = odo_val * 1000;
    }
}

uint32_t seq_store_get_seq(void)
{
    return s_seq;
}

int64_t seq_store_get_odo_mm(void)
{
    return s_odo_mm;
}

int seq_store_commit(uint32_t new_seq, int64_t new_odo_mm)
{
    if (!s_handle_valid) {
        return -1;
    }
    if (nvs_set_u32(s_handle, SEQ_STORE_KEY_SEQ, new_seq) != ESP_OK) {
        return -1;
    }
    if (nvs_set_i64(s_handle, SEQ_STORE_KEY_ODO_MM, new_odo_mm) != ESP_OK) {
        return -1;
    }
    if (nvs_commit(s_handle) != ESP_OK) {
        return -1;
    }
    s_seq = new_seq;
    s_odo_mm = new_odo_mm;
    return 0;
}

#endif /* SEQ_STORE_HOST_STUB */
