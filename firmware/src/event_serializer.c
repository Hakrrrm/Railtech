#include "event_serializer.h"

#include <stdio.h>
#include <string.h>

/* Half-up rounding division for non-negative integers, with carry
 * (e.g. round_div_nonneg(999960, 100) == 10000, i.e. 999.96 -> 1000.0). */
static int64_t round_div_nonneg(int64_t num, int64_t den)
{
    int64_t q = num / den;
    int64_t r = num % den;
    if (r * 2 >= den) {
        q += 1;
    }
    return q;
}

int evt_serialize_seg_done(const evt_seg_done_t *ev, char *buf, size_t buflen)
{
    if (ev == NULL || buf == NULL || buflen == 0) {
        return -1;
    }

    int dir_valid = 0;
    for (const char *p = EVT_VALID_DIRS; *p != '\0'; p++) {
        if (*p == ev->dir) {
            dir_valid = 1;
            break;
        }
    }
    if (!dir_valid) {
        return -1;
    }

    int64_t d_m_x10 = round_div_nonneg(ev->d_mm, 100);       /* mm -> 0.1 m */
    int64_t odo_km_x10 = round_div_nonneg(ev->odo_mm, 100000); /* mm -> 0.1 km */

    long long d_m_whole = d_m_x10 / 10;
    int d_m_frac = (int)(d_m_x10 % 10);
    long long odo_whole = odo_km_x10 / 10;
    int odo_frac = (int)(odo_km_x10 % 10);
    int hdop_whole = ev->hdop_x10 / 10;
    int hdop_frac = ev->hdop_x10 % 10;
    if (hdop_frac < 0) {
        hdop_frac = -hdop_frac;
    }

    int n = snprintf(buf, buflen,
        "{\"v\":1,\"lrv\":\"%s\",\"seq\":%u,\"t\":%u,\"ev\":\"SEG_DONE\","
        "\"seg\":\"%s\",\"dir\":\"%c\",\"d_m\":%lld.%d,\"odo_km\":%lld.%d,"
        "\"hdop\":%d.%d,\"nsv\":%u,\"dwell_s\":%u}",
        ev->lrv_id, (unsigned)ev->seq, (unsigned)ev->t, ev->seg_id, ev->dir,
        d_m_whole, d_m_frac, odo_whole, odo_frac, hdop_whole, hdop_frac,
        (unsigned)ev->nsv, (unsigned)ev->dwell_s);

    if (n < 0 || (size_t)n >= buflen) {
        buf[0] = '\0';
        return -1;
    }
    return n;
}
