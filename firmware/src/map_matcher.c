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
    st->cur_seg_idx = -1;
    st->seg_enter_time_s = 0;
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

    if (st->cur_seg_idx < 0 || st->cur_seg_idx >= (int16_t)num_segments) {
        /* Bootstrap: search every segment. */
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
        return 0; /* off-track / no usable candidate this tick */
    }

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

    out->seg_id = old_seg->seg_id;
    out->dir = dir;
    out->d_mm = old_seg->length_mm;
    uint32_t dwell = (now_s >= st->seg_enter_time_s) ? (now_s - st->seg_enter_time_s) : 0;
    out->dwell_s = (dwell > 0xFFFF) ? 0xFFFF : (uint16_t)dwell;

    st->cur_seg_idx = best_idx;
    st->seg_enter_time_s = now_s;
    (void)best_chainage;

    return 1;
}
