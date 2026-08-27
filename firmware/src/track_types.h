#ifndef TRACK_TYPES_H
#define TRACK_TYPES_H

#include <stdint.h>

/*
 * Shared with tools/track_pipeline.py's generated track_data.h (which
 * #includes this file instead of redefining these types) and with
 * map_matcher.h, which operates on these types without depending on any
 * one generated dataset -- see map_matcher.h for why.
 */

typedef struct {
    int32_t lat_e7;
    int32_t lon_e7;
} track_point_t;

typedef struct {
    const char *seg_id;
    const char *from_node;
    const char *to_node;
    uint8_t     loop_id;      /* index into TRACK_LOOP_NAMES */
    uint8_t     bidir;
    int32_t     length_mm;
    uint16_t    num_points;
    const track_point_t *points; /* ~5 m resampled polyline */
} track_segment_t;

#endif /* TRACK_TYPES_H */
