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
 */

#define MAP_MATCHER_MAX_SNAP_DISTANCE_M 25.0

typedef struct {
    int16_t cur_seg_idx;        /* -1 = unmatched / not yet bootstrapped */
    uint32_t seg_enter_time_s;
} map_matcher_state_t;

typedef struct {
    const char *seg_id;
    char        dir;      /* one of EVT_VALID_DIRS -- see header comment */
    int32_t     d_mm;      /* the completed segment's calibrated length */
    uint16_t    dwell_s;
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
 */
int map_matcher_update(map_matcher_state_t *st,
                        const track_segment_t *segments, uint16_t num_segments,
                        const int16_t *next_fwd, const uint8_t *next_fwd_count,
                        int32_t lat_e7, int32_t lon_e7, uint32_t now_s,
                        map_matcher_event_t *out);

#endif /* MAP_MATCHER_H */
