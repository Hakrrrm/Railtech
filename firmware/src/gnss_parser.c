#include "gnss_parser.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define GNSS_PARSE_BUF_MAX 320
#define GNSS_PARSE_MAX_FIELDS 20
/* A genuine fix has 18 comma-separated fields per the official AT
 * command manual (SIM767XX Series_AT Command Manual_V1.06, Sec
 * 21.2.21): mode, GPS-SVs, GLONASS-SVs, GALILEO-SVs, BEIDOU-SVs, lat,
 * N/S, lon, E/W, date, UTC-time, alt, speed, course, PDOP, HDOP, VDOP,
 * NoSV (indices 0..17). This minimum is enforced ONLY once fix_mode
 * (fields[0]) has already confirmed a real fix (2 or 3) -- real
 * hardware (SIM7670G-MNGV firmware V1.9.05) truncates the "no fix yet"
 * response to far fewer fields than the manual's own documented
 * example shows, so requiring 18 unconditionally rejects every no-fix
 * tick as malformed. See gnss_parse_cgnssinfo()'s own comment. */
#define GNSS_PARSE_MIN_FIELDS 18

static double round_half_up(double v)
{
    return (v >= 0.0) ? (double)(long long)(v + 0.5) : (double)(long long)(v - 0.5);
}

/* Howard Hinnant's days-from-civil, proleptic Gregorian, exact integer
 * arithmetic, valid for any y/m/d this device will ever see. Returns
 * days since 1970-01-01. */
static int64_t days_from_civil(int64_t y, int m, int d)
{
    y -= (m <= 2) ? 1 : 0;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    int64_t yoe = y - era * 400;                                   /* [0, 399] */
    int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;   /* [0, 365] */
    int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;            /* [0, 146096] */
    return era * 146097 + doe - 719468;
}

/* fields[9]="DDMMYY", fields[10]="HHMMSS" or "HHMMSS.sss" (per the
 * reference sketch's parseGpsDate/parseGpsTime). Returns 0 (leaves
 * *out_epoch untouched) if either field is too short to parse. */
static void parse_epoch(const char *date_field, const char *time_field, uint32_t *out_epoch)
{
    if (date_field == NULL || time_field == NULL) {
        return;
    }
    size_t date_len = strlen(date_field);
    size_t time_len = strlen(time_field);
    if (date_len < 6 || time_len < 6) {
        return;
    }

    int dd = (date_field[0] - '0') * 10 + (date_field[1] - '0');
    int mm = (date_field[2] - '0') * 10 + (date_field[3] - '0');
    int yy = (date_field[4] - '0') * 10 + (date_field[5] - '0');
    int hh = (time_field[0] - '0') * 10 + (time_field[1] - '0');
    int mi = (time_field[2] - '0') * 10 + (time_field[3] - '0');
    int ss = (time_field[4] - '0') * 10 + (time_field[5] - '0');

    int64_t days = days_from_civil(2000 + yy, mm, dd);
    int64_t epoch = days * 86400 + hh * 3600 + mi * 60 + ss;
    if (epoch >= 0) {
        *out_epoch = (uint32_t)epoch;
    }
}

int gnss_parse_cgnssinfo(const char *raw, gnss_fix_t *out)
{
    if (raw == NULL || out == NULL) {
        return -1;
    }
    memset(out, 0, sizeof(*out));

    const char *marker = strstr(raw, "+CGNSSINFO:");
    if (marker == NULL) {
        return -1;
    }
    const char *payload_start = marker + strlen("+CGNSSINFO:");
    while (*payload_start == ' ') {
        payload_start++;
    }

    const char *line_end = strstr(payload_start, "\r\n");
    size_t payload_len = (line_end != NULL) ? (size_t)(line_end - payload_start) : strlen(payload_start);
    if (payload_len >= GNSS_PARSE_BUF_MAX) {
        payload_len = GNSS_PARSE_BUF_MAX - 1;
    }

    char buf[GNSS_PARSE_BUF_MAX];
    memcpy(buf, payload_start, payload_len);
    buf[payload_len] = '\0';

    char *fields[GNSS_PARSE_MAX_FIELDS];
    int field_count = 0;
    char *cursor = buf;
    fields[field_count++] = cursor;
    while (field_count < GNSS_PARSE_MAX_FIELDS) {
        char *comma = strchr(cursor, ',');
        if (comma == NULL) {
            break;
        }
        *comma = '\0';
        cursor = comma + 1;
        fields[field_count++] = cursor;
    }

    if (field_count < 1) {
        return -1;
    }

    out->fix_mode = (uint8_t)atoi(fields[0]);

    /* Per the manual, <mode> is only ever defined as 2 (2D fix) or 3
     * (3D fix) on a successful fix -- checked, and short-circuited on,
     * before requiring the full field count below. This matters because
     * real hardware (SIM7670G-MNGV firmware V1.9.05) does NOT match the
     * manual's own documented "no fix" example (which shows all 18
     * fields present but empty, "+CGNSSINFO:,,,,,,,,,,,,,,,,,"): the
     * real modem instead truncates the line to just 9 empty fields
     * ("+CGNSSINFO: ,,,,,,,,") when there's no fix yet. Confirmed on
     * actual hardware, not a hypothetical. Requiring 18 fields
     * unconditionally (an earlier version of this parser did) rejected
     * every single "no fix yet" tick as malformed. */
    out->valid = (out->fix_mode == 2 || out->fix_mode == 3) ? 1 : 0;
    if (!out->valid) {
        return 0;
    }

    if (field_count < GNSS_PARSE_MIN_FIELDS) {
        return -1; /* fix_mode claimed a real fix but the rest of the line is truncated */
    }

    /* fields[17] is NoSV, "number of satellites involved in
     * positioning" per the manual -- the modem already totals this
     * across GPS/GLONASS/GALILEO/BEIDOU (fields[1..4], in that order),
     * so there's no need to sum the four per-constellation counts
     * ourselves (an earlier version of this parser did, based on a
     * field-order guess from a reference sketch that turned out not to
     * match the manual's actual GPS/GLONASS/GALILEO/BEIDOU order --
     * harmless for a summed total, but NoSV is simpler and authoritative). */
    int nsv = atoi(fields[17]);
    out->nsv = (nsv < 0) ? 0 : (uint8_t)((nsv > 255) ? 255 : nsv);

    double lat_raw = strtod(fields[5], NULL);
    char ns = fields[6][0];
    double lon_raw = strtod(fields[7], NULL);
    char ew = fields[8][0];

    double lat = lat_raw * (ns == 'S' ? -1.0 : 1.0);
    double lon = lon_raw * (ew == 'W' ? -1.0 : 1.0);
    out->lat_e7 = (int32_t)round_half_up(lat * 1e7);
    out->lon_e7 = (int32_t)round_half_up(lon * 1e7);

    double speed_knots = strtod(fields[12], NULL);
    double speed_mmps = speed_knots * 514.444; /* 1 knot = 0.514444 m/s */
    out->speed_mmps = (speed_mmps < 0.0) ? 0 : (uint32_t)round_half_up(speed_mmps);

    double hdop = strtod(fields[15], NULL);
    out->hdop_x10 = (int16_t)round_half_up(hdop * 10.0);

    parse_epoch(fields[9], fields[10], &out->utc_epoch_s);

    return 0;
}
