#ifndef MAP_MATCHER_H
#define MAP_MATCHER_H

#include <stdint.h>

#include "track_types.h"

/*
 * Nearest-segment map matcher (Stage 5 MVP). Snaps each GNSS fix onto
 * the nearest point of the current segment or one of its adjacent
 * segments, and reports a SEG_DONE when the fix crosses onto a
 * different (adjacent) segment. This is deliberately simple -- no
 * Kalman filter / HMM -- appropriate for a single-track, well-separated
 * segment layout; revisit if segments ever run close and parallel.
 *
 * Decoupled from any one generated track_data.h: the caller passes the
 * segment table and forward-adjacency table in on every call, so this
 * module (and its host tests) never depend on a real dataset existing.
 * At the target build, the harness passes TRACK_SEGMENTS /
 * TRACK_NUM_SEGMENTS / &TRACK_NEXT_FWD[0][0] / TRACK_NEXT_FWD_COUNT
 * straight from track_data.h.
 *
 * Direction: EVT_VALID_DIRS is "NSEW" (event_serializer.h), but the
 * track dataset (Build Plan Sec 4) carries no cardinal-direction field
 * per segment -- only forward/reverse topology (from_node/to_node +
 * bidir). Stage 5 simplification, flagged explicitly: forward travel
 * (this segment's to_node == next segment's from_node) reports dir
 * 'E', reverse travel (next segment's to_node == this segment's
 * from_node, only possible when bidir) reports dir 'W'. Revisit once
 * the track dataset/TDD define real cardinal or up/down-line direction
 * semantics.
 *
 * GNSS blackout bridging
 * ----------------------
 * Under bridges, tree cover or between buildings the receiver can lose
 * usable fixes for tens of seconds. Two cases, both real on a campus
 * loop:
 *
 *   1. Blackout starts and ends on the SAME segment. Nothing special is
 *      needed -- the matcher simply sees no candidate-changing fix, and
 *      reports that segment normally when the vehicle later crosses off
 *      it. Handled by the plain path below.
 *
 *   2. Blackout spans one or more WHOLE segments, so the vehicle
 *      reappears somewhere that is not adjacent to where it vanished.
 *      The plain nearest-adjacent search cannot see that far, would
 *      match nothing, and the matcher would sit stuck on the
 *      pre-blackout segment -- silently losing every segment traversed
 *      in between, which is mileage under-count, the exact failure the
 *      build plan calls out.
 *
 * Case 2 is handled by re-acquisition: after
 * MAP_MATCHER_REACQUIRE_MISSES consecutive unmatched fixes the matcher
 * searches ALL segments, and if the vehicle reappears on a segment
 * reachable by a short forward path from where it vanished, it emits a
 * SEG_DONE for every segment on that path -- the geometry of the loop
 * is what proves those segments must have been traversed, even though
 * no fix was seen on them. Such events carry inferred == 1 so the
 * downstream can tell measured traversals from bridged ones.
 *
 * The bridge is deliberately bounded (MAP_MATCHER_MAX_BRIDGE_SEGMENTS).
 * A vehicle that reappears further away than that is not bridged: the
 * matcher re-bootstraps silently rather than inventing mileage it
 * cannot justify. Under-counting a genuinely unobserved stretch is
 * recoverable from the anchor/odometer reconciliation; inventing
 * kilometres is not.
 */

#define MAP_MATCHER_MAX_SNAP_DISTANCE_M 25.0

/* Consecutive unmatched fixes before a global re-acquisition search.
 * Low enough to recover quickly, high enough that a single noisy fix
 * (which the harness's DOP gate should already have dropped) does not
 * trigger a full search. */
#define MAP_MATCHER_REACQUIRE_MISSES 3

/* Longest run of unobserved segments the matcher will credit from
 * geometry alone. */
#define MAP_MATCHER_MAX_BRIDGE_SEGMENTS 4

/* Path search is bounded to this many segments; datasets larger than
 * this skip bridging (and only bridging) rather than allocating. */
#define MAP_MATCHER_MAX_BFS_SEGMENTS 64

typedef struct {
    int16_t  cur_seg_idx;        /* -1 = unmatched / not yet bootstrapped */
    uint32_t seg_enter_time_s;
    uint16_t consecutive_miss;   /* unmatched fixes since the last good match */

    /* Segments credited from geometry during a blackout bridge, waiting
     * to be drained by map_matcher_take_pending(). */
    int16_t  pending[MAP_MATCHER_MAX_BRIDGE_SEGMENTS];
    uint16_t pending_dwell_s[MAP_MATCHER_MAX_BRIDGE_SEGMENTS];
    uint8_t  pending_n;
    uint8_t  pending_head;
    char     pending_dir;
} map_matcher_state_t;

typedef struct {
    const char *seg_id;
    char        dir;      /* one of EVT_VALID_DIRS -- see header comment */
    int32_t     d_mm;      /* the completed segment's calibrated length */
    uint16_t    dwell_s;
    uint8_t     inferred;  /* 1 if credited from geometry across a GNSS
                            * blackout rather than observed directly --
                            * the traversal is real, but its dwell_s is a
                            * length-proportional estimate, not measured */
} map_matcher_event_t;

void map_matcher_init(map_matcher_state_t *st);

/*
 * Feeds one GNSS fix (lat_e7/lon_e7, decimal degrees x 1e7) into the
 * matcher at time now_s (monotonic seconds, e.g. millis()/1000).
 *
 * next_fwd must point at the flattened (row-major) TRACK_NEXT_FWD
 * table, i.e. &TRACK_NEXT_FWD[0][0]; next_fwd[i * num_segments + k] is
 * the k-th segment reachable forward from segment i (or -1). next_fwd
 * may be NULL if next_fwd_count is NULL (num_segments == 0 case).
 *
 * Returns 1 and fills *out if a segment boundary was just crossed
 * (the completed segment's data is in *out). Returns 0 otherwise: the
 * fix stayed on the current segment (state's internal progress updates
 * silently), the fix was more than MAP_MATCHER_MAX_SNAP_DISTANCE_M from
 * every candidate segment (off-track / bad fix, state unchanged), or
 * this was a bootstrap fix that only established a starting segment.
 *
 * IMPORTANT: a single call can establish more than one completed
 * segment when it bridges a GNSS blackout (see the header comment).
 * Only the first is returned here; callers MUST drain the rest with
 * map_matcher_take_pending() after any call that returns 1, or those
 * traversals are lost.
 */
int map_matcher_update(map_matcher_state_t *st,
                        const track_segment_t *segments, uint16_t num_segments,
                        const int16_t *next_fwd, const uint8_t *next_fwd_count,
                        int32_t lat_e7, int32_t lon_e7, uint32_t now_s,
                        map_matcher_event_t *out);

/*
 * Dequeues one further completed segment queued by a blackout-bridging
 * map_matcher_update() call. Returns 1 and fills *out, or 0 when none
 * remain. Call in a loop after every map_matcher_update() that returned
 * 1:
 *
 *     if (map_matcher_update(...)) {
 *         publish(&ev);
 *         while (map_matcher_take_pending(&st, segments, &ev)) publish(&ev);
 *     }
 */
int map_matcher_take_pending(map_matcher_state_t *st,
                              const track_segment_t *segments,
                              map_matcher_event_t *out);

#endif /* MAP_MATCHER_H */
