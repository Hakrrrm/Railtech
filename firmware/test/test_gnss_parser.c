/*
 * Host test for gnss_parser.c.
 * Build: gcc -o test_gnss_parser test_gnss_parser.c gnss_parser.c && \
 *            ./test_gnss_parser
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "gnss_parser.h"

static void test_valid_fix_parses(void)
{
    /* Representative +CGNSSINFO line, 18 fields per the AT command
     * manual: mode,GPS,GLONASS,GALILEO,BEIDOU,lat,N/S,lon,E/W,date,
     * time,alt,speed,course,PDOP,HDOP,VDOP,NoSV.
     *
     * lat/lon are entered here as plain decimal degrees, per the
     * working reference sketch's own empirical observation on this
     * exact modem -- NOTE: the AT manual's own printed example for this
     * command shows values that look like NMEA ddmm.mmmm instead
     * (e.g. "3113.330650" for a latitude, not "31.133065"), which would
     * contradict this. Trusting the hands-on hardware observation over
     * a possibly-stale manual example, but this is exactly the kind of
     * thing to sanity-check against a known real location the first
     * time gnss_raw.ndjson has a real fix -- if lat_e7/lon_e7 come out
     * wildly wrong, this is the first place to look. */
    const char *raw =
        "AT+CGNSSINFO\r\n"
        "+CGNSSINFO: 2,8,0,3,1,1.293700,N,103.855800,E,240826,123456.0,"
        "15.2,4.32,180.0,1.8,1.4,1.1,12\r\n"
        "\r\nOK\r\n";

    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == 0);
    assert(fix.valid == 1);
    assert(fix.fix_mode == 2);
    assert(fix.nsv == 12);
    assert(fix.lat_e7 == 12937000);
    assert(fix.lon_e7 == 1038558000);
    assert(fix.hdop_x10 == 14);
    assert(fix.alt_m_x10 == 152);  /* field 11: 15.2 m  */
    assert(fix.pdop_x10 == 18);    /* field 14: 1.8     */
    assert(fix.vdop_x10 == 11);    /* field 16: 1.1     */
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
        "5.0,0.00,0.0,1.0,0.9,0.8,10\r\n\r\nOK\r\n";

    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == 0);
    assert(fix.valid == 1);
    assert(fix.lat_e7 == -338688000);
    assert(fix.lon_e7 == -1512093000);
    printf("[ok] S/W hemisphere signs applied correctly\n");
}

static void test_no_fix_yet_parses_but_invalid(void)
{
    /* The manual's own documented "no fix" example: every field empty. */
    const char *raw = "+CGNSSINFO:,,,,,,,,,,,,,,,,,\r\n\r\nOK\r\n";
    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == 0);
    assert(fix.valid == 0);
    assert(fix.fix_mode == 0);
    printf("[ok] no-fix-yet response parses successfully with valid=0\n");
}

static void test_real_hardware_truncated_no_fix_response(void)
{
    /* What SIM7670G-MNGV firmware V1.9.05 actually sends for "no fix
     * yet" -- only 9 empty fields, not the manual's documented 18.
     * Captured verbatim off real hardware. Must not be rejected as
     * malformed just because it's short: fix_mode is empty (-> 0),
     * which is enough on its own to classify "no fix" without needing
     * the rest of the line. */
    const char *raw = "+CGNSSINFO: ,,,,,,,,\r\n\r\nOK\r\n";
    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == 0);
    assert(fix.valid == 0);
    assert(fix.fix_mode == 0);
    printf("[ok] real hardware's truncated (9-field) no-fix response parses, not rejected\n");
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
    /* Only 5 fields -- nowhere near the 18 required. */
    const char *raw = "+CGNSSINFO: 2,8,0,3,1\r\n\r\nOK\r\n";
    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == -1);
    printf("[ok] truncated/malformed line rejected rather than reading garbage\n");
}

static void test_manual_worked_example_field_mapping(void)
{
    /* The AT manual's OWN worked example (Sec 21.2.21), used here as an
     * independent check that every field index lines up with the spec.
     * Its lat/lon are the one part deliberately not asserted: read as
     * plain decimal degrees they're impossible (lat 3113 deg), so that
     * example is printed NMEA-style even though the same manual's
     * Defined Values table says dd.dddddd. Real hardware for this
     * project emits decimal degrees (confirmed against a known
     * location), which is what the parser implements. */
    const char *raw =
        "+CGNSSINFO: 2,09,05,00,00,3113.330650,N,12121.262554,E,131117,"
        "091918.00,32.9,0.0,255.0,1.1,0.8,0.7,14\r\n\r\nOK\r\n";

    gnss_fix_t fix;
    assert(gnss_parse_cgnssinfo(raw, &fix) == 0);
    assert(fix.valid == 1);
    assert(fix.fix_mode == 2);
    assert(fix.alt_m_x10 == 329); /* 32.9 m */
    assert(fix.pdop_x10 == 11);   /* 1.1 */
    assert(fix.hdop_x10 == 8);    /* 0.8 */
    assert(fix.vdop_x10 == 7);    /* 0.7 */
    assert(fix.nsv == 14);
    assert(fix.speed_mmps == 0);
    printf("[ok] manual's worked example maps to the documented field indices\n");
}

static void test_local_datetime_formatting(void)
{
    char date[11], time[9];

    /* 2026-08-24T12:34:56Z + 8h = same day, 20:34:56 SGT. */
    assert(gnss_format_datetime(1787574896u, GNSS_TZ_OFFSET_S_SINGAPORE,
                                date, sizeof(date), time, sizeof(time)) == 0);
    assert(strcmp(date, "2026-08-24") == 0);
    assert(strcmp(time, "20:34:56") == 0);
    printf("[ok] UTC->SGT within the same day\n");

    /* 2026-08-24T17:00:00Z + 8h crosses midnight -> the DATE must roll
     * over to the 25th, not stay on the 24th. */
    assert(gnss_format_datetime(1787590800u, GNSS_TZ_OFFSET_S_SINGAPORE,
                                date, sizeof(date), time, sizeof(time)) == 0);
    assert(strcmp(date, "2026-08-25") == 0);
    assert(strcmp(time, "01:00:00") == 0);
    printf("[ok] UTC->SGT rolls the date over across midnight\n");

    /* Month/year boundary: 2026-12-31T20:00:00Z + 8h -> 2027-01-01. */
    assert(gnss_format_datetime(1798747200u, GNSS_TZ_OFFSET_S_SINGAPORE,
                                date, sizeof(date), time, sizeof(time)) == 0);
    assert(strcmp(date, "2027-01-01") == 0);
    assert(strcmp(time, "04:00:00") == 0);
    printf("[ok] UTC->SGT rolls month and year over correctly\n");

    /* Leap day must survive the round trip: 2028-02-29T00:00:00Z. */
    assert(gnss_format_datetime(1835395200u, 0,
                                date, sizeof(date), time, sizeof(time)) == 0);
    assert(strcmp(date, "2028-02-29") == 0);
    printf("[ok] leap day renders correctly\n");

    /* Undersized buffers are refused, not overflowed. */
    char tiny[4];
    assert(gnss_format_datetime(1787574896u, 0, tiny, sizeof(tiny), time, sizeof(time)) == -1);
    assert(tiny[0] == '\0');
    printf("[ok] undersized buffer rejected without overflow\n");
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
    test_real_hardware_truncated_no_fix_response();
    test_missing_marker_rejected();
    test_truncated_line_rejected();
    test_manual_worked_example_field_mapping();
    test_local_datetime_formatting();
    test_null_args_rejected();

    printf("all tests passed\n");
    return 0;
}
