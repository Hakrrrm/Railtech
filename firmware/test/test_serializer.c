/*
 * Host test for event_serializer.c and seq_store.c.
 * Build: gcc -DSEQ_STORE_HOST_STUB -o test_ser test_serializer.c \
 *            event_serializer.c seq_store.c && ./test_ser
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "event_serializer.h"
#include "seq_store.h"

static void test_reference_example(void)
{
    /* TDD Sec 5.7 reference input: seq 48213, d_m 612.4, odo_km 128473.9,
     * hdop 1.4. Contract is frozen compact JSON, byte-for-byte. */
    evt_seg_done_t ev = {
        .lrv_id = "D07",
        .seq = 48213,
        .t = 1785560670,
        .seg_id = "PE3_PE4_E",
        .dir = 'E',
        .d_mm = 612400,       /* 612.400 m */
        .odo_mm = 128473900000, /* 128473.900 km */
        .hdop_x10 = 14,       /* 1.4 */
        .nsv = 19,
        .dwell_s = 47,
    };
    const char *expected =
        "{\"v\":1,\"lrv\":\"D07\",\"seq\":48213,\"t\":1785560670,"
        "\"ev\":\"SEG_DONE\",\"seg\":\"PE3_PE4_E\",\"dir\":\"E\","
        "\"d_m\":612.4,\"odo_km\":128473.9,\"hdop\":1.4,\"nsv\":19,"
        "\"dwell_s\":47}";

    char buf[EVT_JSON_MAX];
    int n = evt_serialize_seg_done(&ev, buf, sizeof(buf));

    assert(n > 0);
    assert((size_t)n == strlen(expected));
    assert(memcmp(buf, expected, (size_t)n + 1) == 0);
    printf("%s\n", buf);
    printf("[ok] reference example matches byte-for-byte\n");
}

static void test_rounding_carry(void)
{
    /* 999.96 m must render as 1000.0, never 999.10 (half-up with carry). */
    evt_seg_done_t ev = {
        .lrv_id = "D07", .seq = 1, .t = 0, .seg_id = "A_B", .dir = 'E',
        .d_mm = 999960, .odo_mm = 0, .hdop_x10 = 10, .nsv = 8, .dwell_s = 0,
    };
    char buf[EVT_JSON_MAX];
    int n = evt_serialize_seg_done(&ev, buf, sizeof(buf));
    assert(n > 0);
    assert(strstr(buf, "\"d_m\":1000.0") != NULL);
    printf("[ok] 999.96 m rounds up to 1000.0 with carry\n");

    /* Half-up, not banker's rounding: .05 rounds up. */
    evt_seg_done_t ev2 = ev;
    ev2.d_mm = 100050; /* 100.050 -> 100.1, not 100.0 */
    n = evt_serialize_seg_done(&ev2, buf, sizeof(buf));
    assert(n > 0);
    assert(strstr(buf, "\"d_m\":100.1") != NULL);
    printf("[ok] half-up rounding at the .05 boundary\n");

    /* Odometer km rounding: 100 m precision. */
    evt_seg_done_t ev3 = ev;
    ev3.odo_mm = 128473950000; /* 128473.95 km -> half-up -> 128474.0 */
    n = evt_serialize_seg_done(&ev3, buf, sizeof(buf));
    assert(n > 0);
    assert(strstr(buf, "\"odo_km\":128474.0") != NULL);
    printf("[ok] odometer half-up rounding with carry\n");
}

static void test_invalid_direction_rejected(void)
{
    evt_seg_done_t ev = {
        .lrv_id = "D07", .seq = 1, .t = 0, .seg_id = "A_B", .dir = 'X',
        .d_mm = 1000, .odo_mm = 0, .hdop_x10 = 10, .nsv = 8, .dwell_s = 0,
    };
    char buf[EVT_JSON_MAX];
    memset(buf, 0xAA, sizeof(buf));
    int n = evt_serialize_seg_done(&ev, buf, sizeof(buf));
    assert(n == -1);
    printf("[ok] invalid direction character rejected\n");
}

static void test_undersized_buffer_never_truncates(void)
{
    evt_seg_done_t ev = {
        .lrv_id = "D07", .seq = 48213, .t = 1785560670, .seg_id = "PE3_PE4_E",
        .dir = 'E', .d_mm = 612400, .odo_mm = 128473900000, .hdop_x10 = 14,
        .nsv = 19, .dwell_s = 47,
    };
    char buf[10];
    memset(buf, 0xAA, sizeof(buf));
    int n = evt_serialize_seg_done(&ev, buf, sizeof(buf));
    assert(n == -1);
    /* Must not leave a partial/truncated JSON string in buf. */
    assert(buf[0] == '\0');
    printf("[ok] undersized buffer rejected without truncated output\n");
}

static void test_null_args_rejected(void)
{
    evt_seg_done_t ev = {0};
    char buf[EVT_JSON_MAX];
    assert(evt_serialize_seg_done(NULL, buf, sizeof(buf)) == -1);
    assert(evt_serialize_seg_done(&ev, NULL, sizeof(buf)) == -1);
    assert(evt_serialize_seg_done(&ev, buf, 0) == -1);
    printf("[ok] null/zero arguments rejected\n");
}

static void test_seq_store_persists_across_simulated_restart(void)
{
    const char *path = "/tmp/seq_store_test.nvs";
    remove(path);
    seq_store_host_set_backing_file(path);

    seq_store_init();
    assert(seq_store_get_seq() == 0);
    assert(seq_store_get_odo_mm() == 0);

    assert(seq_store_commit(1, 500) == 0);
    assert(seq_store_commit(2, 1100) == 0);
    assert(seq_store_commit(3, 1750) == 0);
    assert(seq_store_get_seq() == 3);
    assert(seq_store_get_odo_mm() == 1750);

    /* Simulate a reboot: RAM state is dropped, only the "flash" backing
     * file survives -- odometer/seq must resume from the last commit. */
    seq_store_host_simulate_reboot();
    assert(seq_store_get_seq() == 3);
    assert(seq_store_get_odo_mm() == 1750);
    printf("[ok] seq/odometer survive a simulated restart\n");

    /* A failed commit must not advance the persisted state, and must
     * signal failure so the caller blocks publication (commit-before-
     * publish, build plan Sec 2). */
    seq_store_host_fail_next_commits(1);
    assert(seq_store_commit(4, 2000) == -1);
    assert(seq_store_get_seq() == 3);
    assert(seq_store_get_odo_mm() == 1750);
    seq_store_host_simulate_reboot();
    assert(seq_store_get_seq() == 3);
    assert(seq_store_get_odo_mm() == 1750);
    printf("[ok] failed commit does not advance persisted state\n");

    remove(path);
}

static void test_sub_metre_lengths_survive_to_the_wire(void)
{
    /* Regression: the calibrated length of a real NTU ACW segment,
     * 530.319 m. Both the pipeline (whole-metre largest-remainder
     * allocation) and the harness odometer (half-up mm -> m per segment)
     * once discarded the sub-metre part before it reached here, so this
     * rendered as a suspiciously round "530.0". The error was a FIXED
     * per-segment one, identical on every traversal, so it accumulated
     * linearly under an asymmetric duty cycle rather than cancelling --
     * indistinguishable from real matcher error when reconciling against
     * a hubometer anchor. Assert the tenths make it all the way out. */
    evt_seg_done_t ev = {
        .lrv_id = "D07",
        .seq = 1,
        .t = 1785560670,
        .seg_id = "NTU_ACW_North_Hill_Hall_9",
        .dir = 'E',
        .d_mm = 530319,       /* 530.319 m -> "530.3" */
        .odo_mm = 530319,     /* first traversal, accumulated exactly */
        .hdop_x10 = 14,
        .nsv = 19,
        .dwell_s = 60,
    };

    char buf[EVT_JSON_MAX];
    assert(evt_serialize_seg_done(&ev, buf, sizeof(buf)) > 0);
    assert(strstr(buf, "\"d_m\":530.3") != NULL);
    assert(strstr(buf, "\"d_m\":530.0") == NULL);
    printf("[ok] sub-metre segment length survives to the serialised event\n");

    /* And the odometer keeps it too: three traversals of this segment
     * must total 1590.957 m, not 3 x 530 m. Rounding per segment would
     * lose almost a metre over three crossings alone. */
    ev.odo_mm = 3 * 530319;
    assert(evt_serialize_seg_done(&ev, buf, sizeof(buf)) > 0);
    assert(strstr(buf, "\"odo_km\":1.6") != NULL); /* 1.590957 km -> 1.6 */
    printf("[ok] odometer accumulates exact millimetres, no per-segment rounding\n");
}

int main(void)
{
    test_sub_metre_lengths_survive_to_the_wire();
    test_reference_example();
    test_rounding_carry();
    test_invalid_direction_rejected();
    test_undersized_buffer_never_truncates();
    test_null_args_rejected();
    test_seq_store_persists_across_simulated_restart();

    printf("all tests passed\n");
    return 0;
}
