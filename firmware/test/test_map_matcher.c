/*
 * Host test for map_matcher.c, against a small synthetic 2-segment
 * fixture (not a real generated track_data.h -- see map_matcher.h for
 * why this module never depends on one).
 *
 * Build: gcc -o test_map_matcher test_map_matcher.c map_matcher.c -lm && \
 *            ./test_map_matcher
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "map_matcher.h"

/* A straight line along a constant latitude (1.0 deg), longitude
 * running 0.0 -> 0.2 deg (~22 km at this latitude), split into two
 * bidirectional segments A_B (0.0 -> 0.1 deg) and B_C (0.1 -> 0.2 deg),
 * 11 points each (0.01 deg spacing), same loop. */
#define FIXTURE_LAT_E7 10000000

static const track_point_t AB_POINTS[11] = {
    {FIXTURE_LAT_E7, 0}, {FIXTURE_LAT_E7, 100000}, {FIXTURE_LAT_E7, 200000},
    {FIXTURE_LAT_E7, 300000}, {FIXTURE_LAT_E7, 400000}, {FIXTURE_LAT_E7, 500000},
    {FIXTURE_LAT_E7, 600000}, {FIXTURE_LAT_E7, 700000}, {FIXTURE_LAT_E7, 800000},
    {FIXTURE_LAT_E7, 900000}, {FIXTURE_LAT_E7, 1000000},
};
static const track_point_t BC_POINTS[11] = {
    {FIXTURE_LAT_E7, 1000000}, {FIXTURE_LAT_E7, 1100000}, {FIXTURE_LAT_E7, 1200000},
    {FIXTURE_LAT_E7, 1300000}, {FIXTURE_LAT_E7, 1400000}, {FIXTURE_LAT_E7, 1500000},
    {FIXTURE_LAT_E7, 1600000}, {FIXTURE_LAT_E7, 1700000}, {FIXTURE_LAT_E7, 1800000},
    {FIXTURE_LAT_E7, 1900000}, {FIXTURE_LAT_E7, 2000000},
};

static const track_segment_t FIXTURE_SEGMENTS[2] = {
    { "A_B", "A", "B", 0, 1, 611200, 11, AB_POINTS },
    { "B_C", "B", "C", 0, 1, 611200, 11, BC_POINTS },
};
#define FIXTURE_NUM_SEGMENTS 2

static const int16_t FIXTURE_NEXT_FWD[FIXTURE_NUM_SEGMENTS][FIXTURE_NUM_SEGMENTS] = {
    { 1, -1 },
    { -1, -1 },
};
static const uint8_t FIXTURE_NEXT_FWD_COUNT[FIXTURE_NUM_SEGMENTS] = { 1, 0 };

static int update(map_matcher_state_t *st, int32_t lon_e7, uint32_t now_s, map_matcher_event_t *out)
{
    return map_matcher_update(st, FIXTURE_SEGMENTS, FIXTURE_NUM_SEGMENTS,
                               &FIXTURE_NEXT_FWD[0][0], FIXTURE_NEXT_FWD_COUNT,
                               FIXTURE_LAT_E7, lon_e7, now_s, out);
}

static void test_bootstrap_adopts_nearest_segment_silently(void)
{
    map_matcher_state_t st;
    map_matcher_init(&st);
    map_matcher_event_t ev;

    assert(update(&st, 50000, 100, &ev) == 0);
    assert(st.cur_seg_idx == 0);
    printf("[ok] bootstrap adopts A_B silently, no event\n");
}

static void test_same_segment_no_event(void)
{
    map_matcher_state_t st;
    map_matcher_init(&st);
    map_matcher_event_t ev;

    update(&st, 50000, 100, &ev);
    assert(update(&st, 300000, 105, &ev) == 0);
    assert(st.cur_seg_idx == 0);
    printf("[ok] staying within the same segment fires no event\n");
}

static void test_forward_crossing_fires_seg_done(void)
{
    map_matcher_state_t st;
    map_matcher_init(&st);
    map_matcher_event_t ev;

    update(&st, 50000, 100, &ev);      /* bootstrap onto A_B */
    update(&st, 900000, 200, &ev);     /* still A_B */
    int fired = update(&st, 1050000, 260, &ev); /* now on B_C */

    assert(fired == 1);
    assert(strcmp(ev.seg_id, "A_B") == 0);
    assert(ev.dir == 'E');
    assert(ev.d_mm == 611200);
    assert(ev.dwell_s == 260 - 100);
    assert(st.cur_seg_idx == 1);
    printf("[ok] forward crossing A_B -> B_C reports SEG_DONE for A_B, dir=E\n");
}

static void test_reverse_crossing_fires_seg_done_dir_w(void)
{
    map_matcher_state_t st;
    map_matcher_init(&st);
    map_matcher_event_t ev;

    update(&st, 50000, 100, &ev);        /* bootstrap onto A_B */
    update(&st, 1050000, 260, &ev);      /* forward onto B_C */
    int fired = update(&st, 50000, 400, &ev); /* travel back onto A_B */

    assert(fired == 1);
    assert(strcmp(ev.seg_id, "B_C") == 0);
    assert(ev.dir == 'W');
    assert(st.cur_seg_idx == 0);
    printf("[ok] reverse crossing B_C -> A_B reports SEG_DONE for B_C, dir=W\n");
}

static void test_off_track_fix_ignored(void)
{
    map_matcher_state_t st;
    map_matcher_init(&st);
    map_matcher_event_t ev;

    update(&st, 50000, 100, &ev); /* bootstrap onto A_B */
    /* 1 degree of latitude off (~111 km) -- nowhere near any candidate. */
    int fired = map_matcher_update(&st, FIXTURE_SEGMENTS, FIXTURE_NUM_SEGMENTS,
                                    &FIXTURE_NEXT_FWD[0][0], FIXTURE_NEXT_FWD_COUNT,
                                    FIXTURE_LAT_E7 + 10000000, 50000, 200, &ev);
    assert(fired == 0);
    assert(st.cur_seg_idx == 0); /* state untouched */
    printf("[ok] a fix far off every candidate segment is ignored, state unchanged\n");
}

/* ---- GNSS blackout bridging -----------------------------------------
 *
 * A four-segment OPEN line A->B->C->D->E (not closed: nothing follows
 * D_E), 0.1 deg per segment. Open rather than closed so the same
 * fixture can exercise both a bridgeable forward gap and an
 * unreachable one. */

static const track_point_t L0[11] = {
    {FIXTURE_LAT_E7, 0}, {FIXTURE_LAT_E7, 100000}, {FIXTURE_LAT_E7, 200000},
    {FIXTURE_LAT_E7, 300000}, {FIXTURE_LAT_E7, 400000}, {FIXTURE_LAT_E7, 500000},
    {FIXTURE_LAT_E7, 600000}, {FIXTURE_LAT_E7, 700000}, {FIXTURE_LAT_E7, 800000},
    {FIXTURE_LAT_E7, 900000}, {FIXTURE_LAT_E7, 1000000},
};
static const track_point_t L1[11] = {
    {FIXTURE_LAT_E7, 1000000}, {FIXTURE_LAT_E7, 1100000}, {FIXTURE_LAT_E7, 1200000},
    {FIXTURE_LAT_E7, 1300000}, {FIXTURE_LAT_E7, 1400000}, {FIXTURE_LAT_E7, 1500000},
    {FIXTURE_LAT_E7, 1600000}, {FIXTURE_LAT_E7, 1700000}, {FIXTURE_LAT_E7, 1800000},
    {FIXTURE_LAT_E7, 1900000}, {FIXTURE_LAT_E7, 2000000},
};
static const track_point_t L2[11] = {
    {FIXTURE_LAT_E7, 2000000}, {FIXTURE_LAT_E7, 2100000}, {FIXTURE_LAT_E7, 2200000},
    {FIXTURE_LAT_E7, 2300000}, {FIXTURE_LAT_E7, 2400000}, {FIXTURE_LAT_E7, 2500000},
    {FIXTURE_LAT_E7, 2600000}, {FIXTURE_LAT_E7, 2700000}, {FIXTURE_LAT_E7, 2800000},
    {FIXTURE_LAT_E7, 2900000}, {FIXTURE_LAT_E7, 3000000},
};
static const track_point_t L3[11] = {
    {FIXTURE_LAT_E7, 3000000}, {FIXTURE_LAT_E7, 3100000}, {FIXTURE_LAT_E7, 3200000},
    {FIXTURE_LAT_E7, 3300000}, {FIXTURE_LAT_E7, 3400000}, {FIXTURE_LAT_E7, 3500000},
    {FIXTURE_LAT_E7, 3600000}, {FIXTURE_LAT_E7, 3700000}, {FIXTURE_LAT_E7, 3800000},
    {FIXTURE_LAT_E7, 3900000}, {FIXTURE_LAT_E7, 4000000},
};

#define LINE_N 4
static const track_segment_t LINE_SEGMENTS[LINE_N] = {
    { "A_B", "A", "B", 0, 1, 1000000, 11, L0 },
    { "B_C", "B", "C", 0, 1, 2000000, 11, L1 }, /* deliberately twice A_B's
                                                 * length, to prove the
                                                 * bridged dwell split is
                                                 * length-proportional */
    { "C_D", "C", "D", 0, 1, 1000000, 11, L2 },
    { "D_E", "D", "E", 0, 1, 1000000, 11, L3 },
};
static const int16_t LINE_NEXT_FWD[LINE_N][LINE_N] = {
    { 1, -1, -1, -1 },
    { 2, -1, -1, -1 },
    { 3, -1, -1, -1 },
    { -1, -1, -1, -1 },
};
static const uint8_t LINE_NEXT_FWD_COUNT[LINE_N] = { 1, 1, 1, 0 };

static int lupdate(map_matcher_state_t *st, int32_t lat_e7, int32_t lon_e7,
                    uint32_t now_s, map_matcher_event_t *out)
{
    return map_matcher_update(st, LINE_SEGMENTS, LINE_N,
                               &LINE_NEXT_FWD[0][0], LINE_NEXT_FWD_COUNT,
                               lat_e7, lon_e7, now_s, out);
}

/* Drives enough far-off fixes to push the matcher into re-acquisition. */
static void blackout(map_matcher_state_t *st, uint32_t from_s, map_matcher_event_t *ev)
{
    for (int i = 0; i < MAP_MATCHER_REACQUIRE_MISSES; i++) {
        assert(lupdate(st, FIXTURE_LAT_E7 + 10000000, 50000, from_s + i, ev) == 0);
    }
}

static void test_blackout_within_one_segment_is_not_inferred(void)
{
    /* Signal lost mid-A_B and regained on the very next segment. Nothing
     * was skipped, so A_B must be reported as a normal measured
     * traversal -- not flagged inferred, and not accompanied by any
     * bridged event. */
    map_matcher_state_t st;
    map_matcher_init(&st);
    map_matcher_event_t ev;

    lupdate(&st, FIXTURE_LAT_E7, 50000, 100, &ev); /* bootstrap onto A_B */
    blackout(&st, 101, &ev);
    int fired = lupdate(&st, FIXTURE_LAT_E7, 1050000, 200, &ev); /* reappear on B_C */

    assert(fired == 1);
    assert(strcmp(ev.seg_id, "A_B") == 0);
    assert(ev.inferred == 0);
    assert(ev.dwell_s == 100); /* whole elapsed time, nothing to share it with */
    assert(map_matcher_take_pending(&st, LINE_SEGMENTS, &ev) == 0);
    assert(st.cur_seg_idx == 1);
    printf("[ok] blackout ending on the adjacent segment reports one measured traversal\n");
}

static void test_blackout_spanning_a_segment_credits_it_as_inferred(void)
{
    /* Signal lost on A_B, regained on C_D: B_C was traversed entirely
     * unobserved. The loop geometry proves it must have been, so it is
     * credited -- flagged inferred, with a length-proportional dwell. */
    map_matcher_state_t st;
    map_matcher_init(&st);
    map_matcher_event_t ev;

    lupdate(&st, FIXTURE_LAT_E7, 50000, 100, &ev); /* bootstrap onto A_B */
    blackout(&st, 101, &ev);
    int fired = lupdate(&st, FIXTURE_LAT_E7, 2050000, 400, &ev); /* reappear on C_D */

    assert(fired == 1);
    assert(strcmp(ev.seg_id, "A_B") == 0);
    assert(ev.dir == 'E');
    assert(ev.inferred == 0);
    /* 300 s across A_B (1000000 mm) + B_C (2000000 mm) -> 1/3 and 2/3. */
    assert(ev.dwell_s == 100);

    assert(map_matcher_take_pending(&st, LINE_SEGMENTS, &ev) == 1);
    assert(strcmp(ev.seg_id, "B_C") == 0);
    assert(ev.inferred == 1);
    assert(ev.d_mm == 2000000);
    assert(ev.dwell_s == 200);

    assert(map_matcher_take_pending(&st, LINE_SEGMENTS, &ev) == 0);
    assert(st.cur_seg_idx == 2);
    printf("[ok] blackout spanning a whole segment credits it, flagged inferred\n");
}

static void test_unreachable_reappearance_credits_nothing(void)
{
    /* Reappearing where no short forward path leads is not evidence of
     * anything: the matcher must re-bootstrap silently rather than
     * invent mileage. */
    map_matcher_state_t st;
    map_matcher_init(&st);
    map_matcher_event_t ev;

    lupdate(&st, FIXTURE_LAT_E7, 2050000, 100, &ev); /* bootstrap onto C_D */
    blackout(&st, 101, &ev);
    int fired = lupdate(&st, FIXTURE_LAT_E7, 50000, 400, &ev); /* reappear back on A_B */

    assert(fired == 0); /* nothing credited */
    assert(map_matcher_take_pending(&st, LINE_SEGMENTS, &ev) == 0);
    assert(st.cur_seg_idx == 0); /* but tracking resumes from there */
    printf("[ok] reappearing with no forward path credits nothing, re-bootstraps\n");
}

static void test_normal_crossing_never_bridges(void)
{
    /* Without a blackout, a plain adjacent crossing must behave exactly
     * as before -- no re-acquisition, no bridged events. */
    map_matcher_state_t st;
    map_matcher_init(&st);
    map_matcher_event_t ev;

    lupdate(&st, FIXTURE_LAT_E7, 50000, 100, &ev);
    int fired = lupdate(&st, FIXTURE_LAT_E7, 1050000, 160, &ev);

    assert(fired == 1);
    assert(strcmp(ev.seg_id, "A_B") == 0);
    assert(ev.inferred == 0);
    assert(map_matcher_take_pending(&st, LINE_SEGMENTS, &ev) == 0);
    printf("[ok] a normal adjacent crossing bridges nothing\n");
}

int main(void)
{
    test_bootstrap_adopts_nearest_segment_silently();
    test_same_segment_no_event();
    test_forward_crossing_fires_seg_done();
    test_reverse_crossing_fires_seg_done_dir_w();
    test_off_track_fix_ignored();
    test_blackout_within_one_segment_is_not_inferred();
    test_blackout_spanning_a_segment_credits_it_as_inferred();
    test_unreachable_reappearance_credits_nothing();
    test_normal_crossing_never_bridges();

    printf("all tests passed\n");
    return 0;
}
