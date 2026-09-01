#include "map_matcher.h"

#include <math.h>
#include <string.h>

#define E7_TO_DEG 1e-7
#define DEG_TO_M_LAT 111320.0 /* metres per degree of latitude, roughly constant */
#define DEG_TO_RAD 0.017453292519943295

static double lon_scale_m_per_deg(int32_t lat_e7)
{
    double lat_rad = (double)lat_e7 * E7_TO_DEG * DEG_TO_RAD;
    return DEG_TO_M_LAT * cos(lat_rad);
}

/* Planar (equirectangular) approximation, fine at track-local scale. */
static void to_local_m(int32_t lat_e7, int32_t lon_e7, double lon_scale,
                        double *x_m, double *y_m)
{
    *y_m = (double)lat_e7 * E7_TO_DEG * DEG_TO_M_LAT;
    *x_m = (double)lon_e7 * E7_TO_DEG * lon_scale;
}

/* Nearest-point-on-polyline distance (metres) and chainage (metres from
 * segment start, via linear interpolation along the nearest edge). */
static void nearest_on_segment(const track_segment_t *seg, int32_t lat_e7, int32_t lon_e7,
                                double *out_dist_m, double *out_chainage_m)
{
    double lon_scale = lon_scale_m_per_deg(lat_e7);
    double px, py;
    to_local_m(lat_e7, lon_e7, lon_scale, &px, &py);

    double best_dist_sq = -1.0;
    double best_chainage = 0.0;
    double cum_m = 0.0;

    for (uint16_t i = 0; i + 1 < seg->num_points; i++) {
        double ax, ay, bx, by;
        to_local_m(seg->points[i].lat_e7, seg->points[i].lon_e7, lon_scale, &ax, &ay);
        to_local_m(seg->points[i + 1].lat_e7, seg->points[i + 1].lon_e7, lon_scale, &bx, &by);

        double abx = bx - ax, aby = by - ay;
        double edge_len_sq = abx * abx + aby * aby;
        double t = 0.0;
        if (edge_len_sq > 0.0) {
            t = ((px - ax) * abx + (py - ay) * aby) / edge_len_sq;
            if (t < 0.0) t = 0.0;
            if (t > 1.0) t = 1.0;
        }
        double cx = ax + t * abx, cy = ay + t * aby;
        double dx = px - cx, dy = py - cy;
        double dist_sq = dx * dx + dy * dy;

        double edge_len = sqrt(edge_len_sq);
        if (best_dist_sq < 0.0 || dist_sq < best_dist_sq) {
            best_dist_sq = dist_sq;
            best_chainage = cum_m + t * edge_len;
        }
        cum_m += edge_len;
    }

    *out_dist_m = (best_dist_sq < 0.0) ? 1e9 : sqrt(best_dist_sq);
    *out_chainage_m = best_chainage;
}

void map_matcher_init(map_matcher_state_t *st)
{
    memset(st, 0, sizeof(*st));
    st->cur_seg_idx = -1;
    st->seg_enter_time_s = 0;
    st->pending_dir = 'E';
}

/*
 * Breadth-first search for the shortest forward path from_idx -> to_idx.
 * Writes the INTERMEDIATE segments (excluding both endpoints) into
 * path_out in travel order and returns how many were written, or -1 if
 * no path exists within max_intermediate hops.
 *
 * BFS rather than a plain "walk forward until we hit it": the topology
 * is a general directed graph (branches and sidings are legal in the
 * dataset schema), and on a closed loop a naive walk that misses the
 * target wraps forever.
 */
static int find_forward_path(uint16_t num_segments,
                              const int16_t *next_fwd, const uint8_t *next_fwd_count,
                              int16_t from_idx, int16_t to_idx,
                              int16_t *path_out, int max_intermediate)
{
    if (next_fwd == NULL || next_fwd_count == NULL) {
        return -1;
    }
    if (num_segments > MAP_MATCHER_MAX_BFS_SEGMENTS) {
        return -1; /* documented limit -- skip bridging, never guess */
    }

    int16_t parent[MAP_MATCHER_MAX_BFS_SEGMENTS];
    int16_t queue[MAP_MATCHER_MAX_BFS_SEGMENTS];
    int head = 0, tail = 0;

    for (uint16_t i = 0; i < num_segments; i++) {
        parent[i] = -2; /* -2 = unvisited, -1 = visited root */
    }

    parent[from_idx] = -1;
    queue[tail++] = from_idx;

    int found = 0;
    while (head < tail) {
        int16_t cur = queue[head++];
        if (cur == to_idx) {
            found = 1;
            break;
        }
        uint8_t cnt = next_fwd_count[cur];
        for (uint8_t k = 0; k < cnt; k++) {
            int16_t nxt = next_fwd[(uint32_t)cur * num_segments + k];
            if (nxt < 0 || nxt >= (int16_t)num_segments) continue;
            if (parent[nxt] != -2) continue; /* already reached, and BFS
                                              * guarantees via a path no
                                              * longer than this one */
            parent[nxt] = cur;
            if (tail < MAP_MATCHER_MAX_BFS_SEGMENTS) {
                queue[tail++] = nxt;
            }
        }
    }

    if (!found) {
        return -1;
    }

    /* Walk parents back from to_idx, collecting intermediates only. */
    int16_t rev[MAP_MATCHER_MAX_BFS_SEGMENTS];
    int n_rev = 0;
    for (int16_t at = parent[to_idx]; at >= 0; at = parent[at]) {
        if (n_rev >= MAP_MATCHER_MAX_BFS_SEGMENTS) return -1;
        rev[n_rev++] = at;
    }
    /* rev now holds the intermediates plus from_idx, target-first. Drop
     * from_idx (always last) -- it is reported by the caller as the
     * segment being left, not as a bridged one. */
    if (n_rev > 0) {
        n_rev--;
    }
    if (n_rev > max_intermediate) {
        return -1; /* too far to justify from geometry alone */
    }
    for (int i = 0; i < n_rev; i++) {
        path_out[i] = rev[n_rev - 1 - i]; /* reverse into travel order */
    }
    return n_rev;
}

/* Appends candidate index if not already present. */
static void add_candidate(int16_t *cands, int *n, int16_t idx, int max)
{
    if (idx < 0) return;
    for (int i = 0; i < *n; i++) {
        if (cands[i] == idx) return;
    }
    if (*n < max) {
        cands[(*n)++] = idx;
    }
}

int map_matcher_update(map_matcher_state_t *st,
                        const track_segment_t *segments, uint16_t num_segments,
                        const int16_t *next_fwd, const uint8_t *next_fwd_count,
                        int32_t lat_e7, int32_t lon_e7, uint32_t now_s,
                        map_matcher_event_t *out)
{
    if (st == NULL || segments == NULL || num_segments == 0 || out == NULL) {
        return 0;
    }

    #define MAX_CANDIDATES 32
    int16_t candidates[MAX_CANDIDATES];
    int n_candidates = 0;

    /* Re-acquisition: enough consecutive fixes have failed to match the
     * local neighbourhood that the vehicle has probably reappeared
     * somewhere else entirely (GNSS blackout -- see map_matcher.h).
     * Widen to a global search so it can be found at all. */
    const int reacquiring = (st->consecutive_miss >= MAP_MATCHER_REACQUIRE_MISSES);

    if (st->cur_seg_idx < 0 || st->cur_seg_idx >= (int16_t)num_segments || reacquiring) {
        /* Bootstrap or re-acquisition: search every segment. */
        for (uint16_t i = 0; i < num_segments && n_candidates < MAX_CANDIDATES; i++) {
            add_candidate(candidates, &n_candidates, (int16_t)i, MAX_CANDIDATES);
        }
    } else {
        int16_t cur = st->cur_seg_idx;
        add_candidate(candidates, &n_candidates, cur, MAX_CANDIDATES);

        if (next_fwd != NULL && next_fwd_count != NULL) {
            uint8_t cnt = next_fwd_count[cur];
            for (uint8_t k = 0; k < cnt; k++) {
                int16_t nxt = next_fwd[(uint32_t)cur * num_segments + k];
                add_candidate(candidates, &n_candidates, nxt, MAX_CANDIDATES);
            }
        }

        /* Reverse neighbours: any segment whose to_node equals this
         * segment's from_node, only meaningful if that neighbour (or
         * this one) is bidirectional. */
        if (segments[cur].bidir) {
            for (uint16_t i = 0; i < num_segments && n_candidates < MAX_CANDIDATES; i++) {
                if ((int16_t)i == cur) continue;
                if (segments[i].loop_id != segments[cur].loop_id) continue;
                if (strcmp(segments[i].to_node, segments[cur].from_node) == 0) {
                    add_candidate(candidates, &n_candidates, (int16_t)i, MAX_CANDIDATES);
                }
            }
        }
    }

    int16_t best_idx = -1;
    double best_dist = -1.0;
    double best_chainage = 0.0;
    for (int i = 0; i < n_candidates; i++) {
        int16_t idx = candidates[i];
        double dist_m, chainage_m;
        nearest_on_segment(&segments[idx], lat_e7, lon_e7, &dist_m, &chainage_m);
        if (best_dist < 0.0 || dist_m < best_dist) {
            best_dist = dist_m;
            best_idx = idx;
            best_chainage = chainage_m;
        }
    }

    if (best_idx < 0 || best_dist > MAP_MATCHER_MAX_SNAP_DISTANCE_M) {
        /* Off-track / no usable candidate. Counting these is what lets a
         * sustained blackout escalate to a global re-acquisition search
         * instead of leaving the matcher stuck on the segment where the
         * signal was lost. Saturate rather than wrap. */
        if (st->consecutive_miss < 0xFFFF) {
            st->consecutive_miss++;
        }
        return 0;
    }

    st->consecutive_miss = 0;

    if (st->cur_seg_idx < 0) {
        /* Bootstrap: adopt starting segment silently, no event. */
        st->cur_seg_idx = best_idx;
        st->seg_enter_time_s = now_s;
        return 0;
    }

    if (best_idx == st->cur_seg_idx) {
        return 0; /* still on the same segment */
    }

    /* Segment boundary crossed: report the segment we just left. */
    const track_segment_t *old_seg = &segments[st->cur_seg_idx];
    char dir = 'E'; /* forward, see header comment on the direction simplification */
    if (strcmp(old_seg->from_node, segments[best_idx].to_node) == 0) {
        dir = 'W'; /* reverse: new segment's to_node feeds into old segment's from_node */
    }

    uint32_t elapsed = (now_s >= st->seg_enter_time_s) ? (now_s - st->seg_enter_time_s) : 0;

    /* Blackout bridging. Only ever attempted out of a re-acquisition:
     * during normal tracking the new segment is adjacent by
     * construction, and on a CLOSED loop a forward search from a plain
     * reverse step would happily "find" a path all the way round and
     * credit the entire loop. Forward travel only, for the same reason.
     *
     * The common blackout (lost and regained within one segment, or
     * regained on the immediately-next segment) yields zero
     * intermediates here and so behaves exactly as before -- the
     * segment is reported normally, not inferred. */
    int16_t bridged[MAP_MATCHER_MAX_BRIDGE_SEGMENTS];
    int n_bridged = 0;
    if (reacquiring) {
        if (dir == 'E') {
            int n = find_forward_path(num_segments, next_fwd, next_fwd_count,
                                       st->cur_seg_idx, best_idx,
                                       bridged, MAP_MATCHER_MAX_BRIDGE_SEGMENTS);
            if (n > 0) {
                n_bridged = n;
            } else if (n < 0) {
                /* Reappeared somewhere with no short forward path from
                 * where the signal was lost. What happened in between
                 * cannot be justified from the map, so credit nothing:
                 * re-bootstrap silently. Under-counting an unobserved
                 * stretch is recoverable at anchor reconciliation;
                 * inventing kilometres of mileage is not. */
                st->cur_seg_idx = best_idx;
                st->seg_enter_time_s = now_s;
                st->pending_n = 0;
                st->pending_head = 0;
                return 0;
            }
        } else if (!old_seg->bidir) {
            /* dir == 'W' reached only via the global re-acquisition
             * search (map_matcher_update's bootstrap/reacquiring branch
             * above, which ignores loop_id entirely) -- the normal
             * steady-state candidate set never offers a reverse neighbour
             * unless old_seg->bidir is true (see the candidate-generation
             * block above), so a one-way segment can never be
             * legitimately left "backwards". Confirmed on real hardware:
             * two physically close, same-named-station loops (e.g. an
             * inner/outer pair) can put a noisy fix ~40-50 m off-track
             * during re-acquisition marginally closer to the WRONG loop's
             * segment than the right one, satisfying this dir=='W'
             * string match purely by coincidence of node naming, not by
             * any real reverse traversal -- crediting that here fired a
             * segment completion in seconds where the real traversal
             * takes minutes. Same rule as the n<0 case above: credit
             * nothing, re-bootstrap silently. */
            st->cur_seg_idx = best_idx;
            st->seg_enter_time_s = now_s;
            st->pending_n = 0;
            st->pending_head = 0;
            return 0;
        }
    }

    /* Split the blackout's elapsed time across every segment credited
     * for it, in proportion to length -- a constant-speed assumption,
     * which is the only defensible one with no fixes in between. Marked
     * inferred so the estimate is never mistaken for a measurement. */
    int64_t total_mm = old_seg->length_mm;
    for (int i = 0; i < n_bridged; i++) {
        total_mm += segments[bridged[i]].length_mm;
    }
    if (total_mm <= 0) {
        total_mm = 1; /* degenerate dataset -- avoid divide-by-zero */
    }

    uint32_t old_dwell = (uint32_t)(((int64_t)elapsed * old_seg->length_mm) / total_mm);

    st->pending_n = 0;
    st->pending_head = 0;
    st->pending_dir = dir;
    for (int i = 0; i < n_bridged; i++) {
        uint32_t d = (uint32_t)(((int64_t)elapsed * segments[bridged[i]].length_mm) / total_mm);
        st->pending[st->pending_n] = bridged[i];
        st->pending_dwell_s[st->pending_n] = (d > 0xFFFF) ? 0xFFFF : (uint16_t)d;
        st->pending_n++;
    }

    out->seg_id = old_seg->seg_id;
    out->dir = dir;
    out->d_mm = old_seg->length_mm;
    out->dwell_s = (old_dwell > 0xFFFF) ? 0xFFFF : (uint16_t)old_dwell;
    out->inferred = 0; /* the vehicle was observed on this one */

    st->cur_seg_idx = best_idx;
    st->seg_enter_time_s = now_s;
    (void)best_chainage;

    return 1;
}

int map_matcher_take_pending(map_matcher_state_t *st,
                              const track_segment_t *segments,
                              map_matcher_event_t *out)
{
    if (st == NULL || segments == NULL || out == NULL) {
        return 0;
    }
    if (st->pending_head >= st->pending_n) {
        st->pending_n = 0;
        st->pending_head = 0;
        return 0;
    }

    const track_segment_t *seg = &segments[st->pending[st->pending_head]];
    out->seg_id = seg->seg_id;
    out->dir = st->pending_dir;
    out->d_mm = seg->length_mm;
    out->dwell_s = st->pending_dwell_s[st->pending_head];
    out->inferred = 1;
    st->pending_head++;

    return 1;
}
