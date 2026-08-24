#ifndef BOOT_COUNTER_H
#define BOOT_COUNTER_H

#include <stdint.h>

/* NVS namespace "boot", key "count". A separate namespace/module from
 * seq_store -- this counts device boots (for naming a fresh SD log
 * folder each time), not segment-completion sequence numbers, and the
 * two must never be conflated. */

/*
 * Increments and persists the boot counter, then returns the new value.
 * Call exactly once per boot (from setup()). The very first boot ever
 * returns 1, not 0, so "0" is never a valid folder name and can't be
 * confused with "counter never initialised".
 */
uint32_t boot_counter_next(void);

#ifdef SEQ_STORE_HOST_STUB
/* Host-test-only surface, same shape as seq_store's. Not compiled into
 * the target build. */
void boot_counter_host_set_backing_file(const char *path);
#endif

#endif /* BOOT_COUNTER_H */
