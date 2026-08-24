/*
 * Host test for gnss_parser.c.
 * Build: gcc -o test_gnss_parser test_gnss_parser.c gnss_parser.c && \
 *            ./test_gnss_parser
 */
#include <assert.h>
#include <stdio.h>

#include "gnss_parser.h"

static void test_valid_fix_parses(void)
{
    /* Representative +CGNSSINFO line: fixMode=2, 8 GPS + 0 BDS + 3 GLONASS
     * + 1 Galileo sats, decimal-degree lat/lon (matches this board's
     * modem behaviour per the reference sketch), date/time, alt, speed
     * (knots), course, pdop, hdop, vdop. */
    const char *raw =
        "AT+CGNSSINFO\r\n"
        "+CGNSSINFO: 2,8,0,3,1,1.293700,N,103.855800,E,240826,123456.0,"
        "15.2,4.32,180.0,1.8,1.4,1.1\r\n"
        "\r\nOK\r\n";

    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == 0);
    assert(fix.valid == 1);
    assert(fix.fix_mode == 2);
    assert(fix.nsv == 8 + 0 + 3 + 1);
    assert(fix.lat_e7 == 12937000);
    assert(fix.lon_e7 == 1038558000);
    assert(fix.hdop_x10 == 14);
    /* 4.32 knots -> 4.32 * 514.444 = 2222.4 mm/s, half-up -> 2222 */
    assert(fix.speed_mmps == 2222);
    /* date=240826 (24 Aug 2026), time=123456 -> 2026-08-24T12:34:56Z */
    assert(fix.utc_epoch_s == 1787574896u);
    printf("[ok] valid fix line parses to expected fixed-point fields\n");
}

static void test_southern_western_hemisphere_signs(void)
{
    const char *raw =
        "+CGNSSINFO: 3,10,0,0,0,33.868800,S,151.209300,W,240826,010203.0,"
        "5.0,0.00,0.0,1.0,0.9,0.8\r\n\r\nOK\r\n";

    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == 0);
    assert(fix.valid == 1);
    assert(fix.lat_e7 == -338688000);
    assert(fix.lon_e7 == -1512093000);
    printf("[ok] S/W hemisphere signs applied correctly\n");
}

static void test_no_fix_yet_parses_but_invalid(void)
{
    const char *raw = "+CGNSSINFO: 0,0,0,0,0,,,,,,,,,,,,,\r\n\r\nOK\r\n";
    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == 0);
    assert(fix.valid == 0);
    assert(fix.fix_mode == 0);
    printf("[ok] no-fix-yet response parses successfully with valid=0\n");
}

static void test_missing_marker_rejected(void)
{
    const char *raw = "OK\r\n";
    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == -1);
    printf("[ok] response with no +CGNSSINFO: line rejected\n");
}

static void test_truncated_line_rejected(void)
{
    /* Only 5 fields -- nowhere near the 17 required. */
    const char *raw = "+CGNSSINFO: 2,8,0,3,1\r\n\r\nOK\r\n";
    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == -1);
    printf("[ok] truncated/malformed line rejected rather than reading garbage\n");
}

static void test_null_args_rejected(void)
{
    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(NULL, &fix) == -1);
    assert(gnss_parse_cgnssinfo("+CGNSSINFO: 1\r\n", NULL) == -1);
    printf("[ok] null arguments rejected\n");
}

int main(void)
{
    test_valid_fix_parses();
    test_southern_western_hemisphere_signs();
    test_no_fix_yet_parses_but_invalid();
    test_missing_marker_rejected();
    test_truncated_line_rejected();
    test_null_args_rejected();

    printf("all tests passed\n");
    return 0;
}
