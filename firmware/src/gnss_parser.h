#ifndef GNSS_PARSER_H
#define GNSS_PARSER_H

#include <stddef.h>
#include <stdint.h>

/*
 * Parses the SIM7670G's AT+CGNSSINFO response (direct-AT-command GNSS
 * reading, Stage 5). Pure logic, no hardware/UART I/O -- the target
 * build's harness issues the AT command and reads the raw response,
 * then hands the text here.
 *
 * Field layout confirmed against SIMCOM's own SIM767XX Series_AT
 * Command Manual_V1.06, Sec 21.2.21: 18 fields --
 * mode,GPS-SVs,GLONASS-SVs,GALILEO-SVs,BEIDOU-SVs,lat,N/S,lon,E/W,
 * date,UTC-time,alt,speed,course,PDOP,HDOP,VDOP,NoSV. Decimal-degree
 * lat/lon (not NMEA ddmm.mmmm) is also manual-confirmed for this
 * command -- some SIM76xx variants/firmware report ddmm.mmmm for
 * other GNSS commands, but not this one.
 */

typedef struct {
    int         valid;      /* 1 if fix_mode indicates a usable fix, else 0 */
    uint8_t     fix_mode;   /* raw +CGNSSINFO fix mode field: 2=2D fix, 3=3D fix per the manual */
    uint8_t     nsv;        /* NoSV field -- satellites involved in positioning, modem-computed total */
    int16_t     pdop_x10;   /* PDOP, actual value x10 */
    int16_t     hdop_x10;   /* HDOP, actual value x10 */
    int16_t     vdop_x10;   /* VDOP, actual value x10 */
    int32_t     alt_m_x10;  /* MSL altitude in metres x10 (can be negative below sea level) */
    int32_t     lat_e7;     /* latitude,  degrees x 1e7 */
    int32_t     lon_e7;     /* longitude, degrees x 1e7 */
    uint32_t    speed_mmps; /* ground speed, millimetres/second (from knots) */
    uint32_t    utc_epoch_s; /* unix epoch seconds from the fix's own UTC date/time,
                               * 0 if the date/time fields didn't parse. Replaces the
                               * millis()-since-boot stand-in used before real GNSS
                               * existed (Stage 3's "known delta from production"). */
} gnss_fix_t;

/*
 * Parses one raw AT+CGNSSINFO response (the full echoed response,
 * "+CGNSSINFO: ...\r\nOK\r\n" or similar -- anything containing a
 * "+CGNSSINFO:" line is accepted).
 *
 * Returns 0 on success (out->valid tells you whether it was a fix or a
 * "no fix yet" response -- both parse successfully). Returns -1 if no
 * +CGNSSINFO: line was found, or the line has fewer fields than the
 * format requires (malformed/truncated read).
 */
int gnss_parse_cgnssinfo(const char *raw, gnss_fix_t *out);

/* Fixed UTC offset for Singapore Standard Time. Singapore has observed
 * no DST since 1933, so a constant offset is correct here rather than a
 * simplification -- do NOT reuse this for a region with DST. */
#define GNSS_TZ_OFFSET_S_SINGAPORE (8 * 3600)

/*
 * Renders a UTC unix epoch, shifted by offset_s, into a local calendar
 * date "YYYY-MM-DD" and clock time "HH:MM:SS". Applying the offset
 * before splitting the epoch means a shift across midnight rolls the
 * DATE over too, which naive "print the fix's raw date field, add hours
 * to the raw time field" handling gets wrong.
 *
 * date_out needs >= 11 bytes, time_out >= 9. Returns 0 on success, -1
 * on a null/undersized buffer (both buffers left empty in that case).
 */
int gnss_format_datetime(uint32_t utc_epoch_s, int32_t offset_s,
                         char *date_out, size_t date_len,
                         char *time_out, size_t time_len);

#endif /* GNSS_PARSER_H */
