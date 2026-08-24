#include "boot_counter.h"

#include <stdio.h>

#ifdef SEQ_STORE_HOST_STUB

/* ------------------------------------------------------------------
 * Host stub: file-backed, same shape as seq_store's host stub.
 * ------------------------------------------------------------------ */

#include <string.h>

static char s_backing_path[512] = {0};
static int s_have_backing_path = 0;

static uint32_t load_count(void)
{
    if (!s_have_backing_path) {
        return 0;
    }
    FILE *f = fopen(s_backing_path, "r");
    if (f == NULL) {
        return 0;
    }
    unsigned long long count_in = 0;
    uint32_t count = 0;
    if (fscanf(f, "%llu", &count_in) == 1) {
        count = (uint32_t)count_in;
    }
    fclose(f);
    return count;
}

uint32_t boot_counter_next(void)
{
    uint32_t next = load_count() + 1;
    if (s_have_backing_path) {
        FILE *f = fopen(s_backing_path, "w");
        if (f != NULL) {
            fprintf(f, "%u\n", next);
            fflush(f);
            fclose(f);
        }
    }
    return next;
}

void boot_counter_host_set_backing_file(const char *path)
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

#else /* !SEQ_STORE_HOST_STUB -- ESP32 target build */

#include "nvs.h"
#include "nvs_flash.h"

#define BOOT_COUNTER_NVS_NAMESPACE "boot"
#define BOOT_COUNTER_KEY_COUNT "count"

uint32_t boot_counter_next(void)
{
    nvs_handle_t handle;
    uint32_t count = 0;

    /* nvs_flash_init() is idempotent and already called by seq_store_init()
     * elsewhere in the same process, but calling it again here is safe --
     * it's a no-op once the default NVS partition is initialised. */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        return 0;
    }

    if (nvs_open(BOOT_COUNTER_NVS_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        return 0;
    }

    uint32_t stored = 0;
    if (nvs_get_u32(handle, BOOT_COUNTER_KEY_COUNT, &stored) == ESP_OK) {
        count = stored;
    }
    count += 1;

    if (nvs_set_u32(handle, BOOT_COUNTER_KEY_COUNT, count) == ESP_OK) {
        nvs_commit(handle);
    }
    nvs_close(handle);
    return count;
}

#endif /* SEQ_STORE_HOST_STUB */
