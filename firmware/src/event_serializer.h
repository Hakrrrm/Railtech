#ifndef EVENT_SERIALIZER_H
#define EVENT_SERIALIZER_H

#include <stddef.h>
#include <stdint.h>

/* Caller-supplied buffer size for evt_serialize_seg_done(). No heap
 * allocation happens inside this module. */
#define EVT_JSON_MAX 256

/* Direction is a single confirmed-direction-of-travel character (TDD D9:
 * direction is an explicit state, not assumed). Extend this set only if
 * the track model grows new cardinal/loop directions. */
#define EVT_VALID_DIRS "NSEW"

typedef struct {
    const char *lrv_id;   /* vehicle id, e.g. "D07" */
    uint32_t    seq;      /* monotonic sequence number, from seq_store */
    uint32_t    t;        /* unix epoch seconds */
    const char *seg_id;   /* segment id, e.g. "PE3_PE4_E" */
    char        dir;      /* confirmed direction, one of EVT_VALID_DIRS */
    int32_t     d_mm;     /* length of segment just completed, millimetres */
    int64_t     odo_mm;   /* cumulative odometer after this segment, MILLIMETRES.
                           * Millimetres, not metres, so no rounding to whole
                           * metres ever happens between a segment's calibrated
                           * length and the running total. A per-segment rounding
                           * error is fixed for a given segment, not random, so it
                           * accumulates linearly rather than cancelling. The
                           * rendered "odo_km" field is unaffected. */
    int16_t     hdop_x10; /* HDOP, fixed-point, actual value x10 */
    uint8_t     nsv;      /* satellites used in fix */
    uint16_t    dwell_s;  /* dwell time at the preceding stop, seconds */
} evt_seg_done_t;

/*
 * Serialises a SEG_DONE event into the Tier 1 JSON contract (TDD Sec 5.7):
 *
 *   {"v":1,"lrv":"D07","seq":48213,"t":1785560670,"ev":"SEG_DONE",
 *    "seg":"PE3_PE4_E","dir":"E","d_m":612.4,"odo_km":128473.9,
 *    "hdop":1.4,"nsv":19,"dwell_s":47}
 *
 * Field order, names and decimal precision are frozen and must not change.
 * d_m and odo_km are rendered with half-up rounding and carry (e.g. an
 * input of 999.96 m renders as "1000.0", never "999.10"). Integer
 * arithmetic only, no floating point.
 *
 * Returns the number of bytes written (excluding the NUL terminator) on
 * success. Returns -1 without writing anything to buf if:
 *   - ev->dir is not one of EVT_VALID_DIRS, or
 *   - buf is too small to hold the complete JSON (never truncates).
 */
int evt_serialize_seg_done(const evt_seg_done_t *ev, char *buf, size_t buflen);

#endif /* EVENT_SERIALIZER_H */
