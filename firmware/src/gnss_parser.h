#ifndef GNSS_PARSER_H
#define GNSS_PARSER_H

#include <stdint.h>

/*
 * Parses the SIM7670G's AT+CGNSSINFO response (direct-AT-command GNSS
 * reading, Stage 5). Pure logic, no hardware/UART I/O -- the target
 * build's harness issues the AT command and reads the raw response,
 * then hands the text here.
 *
 * Field layout and the "SIM7670G returns decimal degrees directly, not
 * NMEA ddmm.mmmm" behaviour are taken from a working reference sketch
 * for this exact board/modem (GpsOptimisation.ino), not from SIMCOM's
 * generic AT command manual -- flagged since some SIM76xx variants/
 * firmware report ddmm.mmmm instead.
 */

typedef struct {
    int         valid;      /* 1 if fix_mode indicates a usable fix, else 0 */
    uint8_t     fix_mode;   /* raw +CGNSSINFO fix mode field */
    uint8_t     nsv;        /* satellites used, summed across GPS+BDS+GLONASS+Galileo */
    int16_t     hdop_x10;   /* HDOP, actual value x10 */
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

#endif /* GNSS_PARSER_H */
