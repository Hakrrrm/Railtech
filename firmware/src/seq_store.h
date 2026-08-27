#ifndef SEQ_STORE_H
#define SEQ_STORE_H

#include <stdint.h>

/* NVS namespace "odo", keys "seq" and "odo_mm" (build plan Sec 10).
 * Write policy: commit on segment completion only, never timer-based.
 * Commit-before-publish is enforced by the caller: a failed
 * seq_store_commit() MUST block publication of that event. */

/* Opens (or creates) the store and loads the last committed values into
 * RAM. Must be called once before any other seq_store_* call. */
void seq_store_init(void);

/* Last committed sequence number (0 if never committed). */
uint32_t seq_store_get_seq(void);

/* Last committed odometer, integer MILLIMETRES (0 if never committed).
 * Millimetres rather than metres so a segment's calibrated length is
 * accumulated exactly: rounding each segment to whole metres put a fixed
 * (per-segment, not random) error of up to +/-0.5 m on every traversal,
 * which accumulates linearly instead of cancelling. A device carrying
 * only the older integer-metre NVS key is migrated on init. */
int64_t seq_store_get_odo_mm(void);

/*
 * Commits new_seq and new_odo_mm to persistent storage. Must be called,
 * and must succeed, before the corresponding event is published over
 * MQTT (commit-before-publish, non-negotiable: TDD Sec 5.6/5.7, build
 * plan Sec 2). Returns 0 on success, -1 on failure -- the caller MUST
 * NOT publish the event on failure.
 */
int seq_store_commit(uint32_t new_seq, int64_t new_odo_mm);

#ifdef SEQ_STORE_HOST_STUB
/* Host-test-only surface. Not compiled into the target build. */

/* Points the stub at a backing file standing in for the NVS partition.
 * Pass NULL to use a private in-memory-only store (no persistence). */
void seq_store_host_set_backing_file(const char *path);

/* Drops any in-RAM cache and re-loads from the backing file, simulating
 * a reboot while keeping whatever was last committed. */
void seq_store_host_simulate_reboot(void);

/* Forces the next N commits to fail (simulates a flash write failure),
 * without touching the backing file. */
void seq_store_host_fail_next_commits(int n);
#endif

#endif /* SEQ_STORE_H */
