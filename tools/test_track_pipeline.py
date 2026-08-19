#!/usr/bin/env python3
"""
Self-tests for track_pipeline.py. Plain assert-based, no framework, so it
runs the same way as the firmware's C host tests. Builds a small synthetic
loop fixture and deliberately triggers each dataset-rule violation from
Build Plan Sec 4.2, plus exercises the happy path end to end.

Run: python3 tools/test_track_pipeline.py
"""
import csv
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import track_pipeline as tp  # noqa: E402


# --------------------------------------------------------------------------
# Fixture: a small closed square loop, A -> B -> C -> D -> A
# --------------------------------------------------------------------------

def interp(a, b, n):
    return [(a[0] + (b[0] - a[0]) * i / (n - 1), a[1] + (b[1] - a[1]) * i / (n - 1)) for i in range(n)]


NODE_A = (103.9000, 1.3000)
NODE_B = (103.9005, 1.3000)
NODE_C = (103.9005, 1.3005)
NODE_D = (103.9000, 1.3005)


def make_feature(seg_id, order, frm, to, coords, loop="east", bidir=True, len_m=None):
    return {
        "type": "Feature",
        "properties": {
            "seg_id": seg_id, "order": order, "from": frm, "to": to,
            "loop": loop, "bidir": bidir, "len_m": len_m,
        },
        "geometry": {"type": "LineString", "coordinates": [[c[0], c[1]] for c in coords]},
    }


def make_valid_square_loop():
    return {
        "type": "FeatureCollection",
        "features": [
            make_feature("A_B", 0, "A", "B", interp(NODE_A, NODE_B, 4)),
            make_feature("B_C", 1, "B", "C", interp(NODE_B, NODE_C, 4)),
            make_feature("C_D", 2, "C", "D", interp(NODE_C, NODE_D, 4)),
            make_feature("D_A", 3, "D", "A", interp(NODE_D, NODE_A, 4)),
        ],
    }


def write_json(obj, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)


def write_loop_lengths(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["loop", "authoritative_m"])
        for loop, val in rows:
            w.writerow([loop, val])


def expect_pipeline_error(fn, needle):
    try:
        fn()
    except tp.PipelineError as e:
        assert needle.lower() in str(e).lower(), f"expected message containing {needle!r}, got: {e}"
        return
    raise AssertionError(f"expected PipelineError containing {needle!r}, none raised")


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------

def test_happy_path_option_a():
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        loop_lengths_path = os.path.join(d, "loop_lengths.csv")
        out_dir = os.path.join(d, "out")

        write_json(make_valid_square_loop(), geojson_path)
        # authoritative total deliberately different from raw geometry to
        # exercise calibration.
        write_loop_lengths(loop_lengths_path, [("east", 200)])

        tp.run(geojson_path, loop_lengths_path, out_dir, None)

        with open(os.path.join(out_dir, "segments.csv"), newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        assert len(rows) == 4
        total = sum(int(r["length_m"]) for r in rows)
        assert total == 200, f"post-calibration total should be exactly 200, got {total}"

        with open(os.path.join(out_dir, "track_data.h"), encoding="utf-8") as f:
            header = f.read()
        assert "#define TRACK_NUM_SEGMENTS 4" in header
        assert "TRACK_SEGMENTS[TRACK_NUM_SEGMENTS]" in header
    print("[ok] happy path: Option A square loop calibrates and emits both files")


def test_pinned_segment_excluded_from_scaling():
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        loop_lengths_path = os.path.join(d, "loop_lengths.csv")
        out_dir = os.path.join(d, "out")

        fc = make_valid_square_loop()
        fc["features"][0]["properties"]["len_m"] = 50  # pin A_B at exactly 50 m
        write_json(fc, geojson_path)
        write_loop_lengths(loop_lengths_path, [("east", 200)])

        tp.run(geojson_path, loop_lengths_path, out_dir, None)
        with open(os.path.join(out_dir, "segments.csv"), newline="", encoding="utf-8") as f:
            rows = {r["seg_id"]: int(r["length_m"]) for r in csv.DictReader(f)}
        assert rows["A_B"] == 50, f"pinned segment must keep its len_m, got {rows['A_B']}"
        assert sum(rows.values()) == 200
    print("[ok] pinned len_m segment excluded from proportional scaling")


def test_wgs84_swap_rejected():
    fc = make_valid_square_loop()
    fc["features"][0]["geometry"]["coordinates"][0] = [91.0, 45.0]  # lat > 90 as lon slot ok, but lat slot invalid below
    fc["features"][0]["geometry"]["coordinates"][1] = [1.3, 999.0]  # clearly invalid lat
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        write_json(fc, geojson_path)
        expect_pipeline_error(lambda: tp.build_segments_option_a(tp.load_geojson(geojson_path)), "WGS84")
    print("[ok] out-of-range coordinate (lat/lon swap symptom) rejected")


def test_endpoint_discontinuity_rejected():
    fc = make_valid_square_loop()
    # break continuity between A_B and B_C by nudging B_C's start point
    fc["features"][1]["geometry"]["coordinates"][0] = [103.9100, 1.3100]
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        write_json(fc, geojson_path)
        expect_pipeline_error(lambda: tp.build_segments_option_a(tp.load_geojson(geojson_path)), "discontinuity")
    print("[ok] consecutive-segment endpoint discontinuity rejected")


def test_missing_wraparound_rejected():
    fc = make_valid_square_loop()
    # break the closing D_A -> A_B wraparound
    fc["features"][3]["geometry"]["coordinates"][-1] = [103.9100, 1.3100]
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        write_json(fc, geojson_path)
        expect_pipeline_error(lambda: tp.build_segments_option_a(tp.load_geojson(geojson_path)), "wraparound")
    print("[ok] missing closed-loop wraparound rejected")


def test_duplicate_seg_id_rejected():
    fc = make_valid_square_loop()
    fc["features"][1]["properties"]["seg_id"] = "A_B"  # collide with feature 0
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        write_json(fc, geojson_path)
        expect_pipeline_error(lambda: tp.build_segments_option_a(tp.load_geojson(geojson_path)), "not unique")
    print("[ok] duplicate seg_id rejected")


def test_noncontiguous_order_rejected():
    fc = make_valid_square_loop()
    fc["features"][2]["properties"]["order"] = 7  # gap: 0,1,7,3
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        write_json(fc, geojson_path)
        expect_pipeline_error(lambda: tp.build_segments_option_a(tp.load_geojson(geojson_path)), "contiguous")
    print("[ok] non-contiguous order rejected")


def test_too_few_points_rejected():
    fc = make_valid_square_loop()
    fc["features"][0]["geometry"]["coordinates"] = [[103.9000, 1.3000], [103.9005, 1.3000]]  # only 2
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        write_json(fc, geojson_path)
        expect_pipeline_error(lambda: tp.build_segments_option_a(tp.load_geojson(geojson_path)), "at least")
    print("[ok] under-minimum coordinate point count rejected")


def test_multilinestring_rejected():
    fc = make_valid_square_loop()
    fc["features"][0]["geometry"] = {
        "type": "MultiLineString",
        "coordinates": [[[103.9000, 1.3000], [103.9005, 1.3000]]],
    }
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        write_json(fc, geojson_path)
        expect_pipeline_error(lambda: tp.build_segments_option_a(tp.load_geojson(geojson_path)), "MultiLineString")
    print("[ok] MultiLineString geometry rejected")


def test_unknown_loop_in_calibration_rejected():
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        loop_lengths_path = os.path.join(d, "loop_lengths.csv")
        out_dir = os.path.join(d, "out")
        write_json(make_valid_square_loop(), geojson_path)
        write_loop_lengths(loop_lengths_path, [("west", 200)])  # wrong loop name
        expect_pipeline_error(lambda: tp.run(geojson_path, loop_lengths_path, out_dir, None), "authoritative_m")
    print("[ok] loop missing from loop_lengths.csv rejected")


def test_option_b_merges_and_closes_ring():
    # Three ways forming a triangle-ish closed ring with one real junction
    # (so it does NOT collapse to a single segment): A-B, B-C, C-A, plus a
    # spur C-D to force a degree-3 junction at C.
    a, b, c = NODE_A, NODE_B, NODE_C
    d_spur = (103.9010, 1.3005)
    features = [
        {"type": "Feature", "properties": {}, "geometry": {"type": "LineString",
         "coordinates": [list(p) for p in interp(a, b, 4)]}},
        {"type": "Feature", "properties": {}, "geometry": {"type": "LineString",
         "coordinates": [list(p) for p in interp(b, c, 4)]}},
        {"type": "Feature", "properties": {}, "geometry": {"type": "LineString",
         "coordinates": [list(p) for p in interp(c, a, 4)]}},
        {"type": "Feature", "properties": {}, "geometry": {"type": "LineString",
         "coordinates": [list(p) for p in interp(c, d_spur, 4)]}},
    ]
    fc = {"type": "FeatureCollection", "features": features}
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        loop_lengths_path = os.path.join(d, "loop_lengths.csv")
        out_dir = os.path.join(d, "out")
        write_json(fc, geojson_path)
        write_loop_lengths(loop_lengths_path, [("shuttle", 300)])
        tp.run(geojson_path, loop_lengths_path, out_dir, "shuttle")
        with open(os.path.join(out_dir, "segments.csv"), newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        # C has degree 3 (B-C, C-A, C-D all meet there) so it must be a
        # boundary node -- the ring must NOT collapse into one segment.
        assert len(rows) > 1, "junction at C should force a segment split, not one merged ring"
    print("[ok] Option B splits at a real junction instead of collapsing the ring")


def test_option_b_requires_loop_name():
    fc = {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": {
            "type": "LineString", "coordinates": [list(p) for p in interp(NODE_A, NODE_B, 4)]}}],
    }
    with tempfile.TemporaryDirectory() as d:
        geojson_path = os.path.join(d, "track.geojson")
        loop_lengths_path = os.path.join(d, "loop_lengths.csv")
        out_dir = os.path.join(d, "out")
        write_json(fc, geojson_path)
        write_loop_lengths(loop_lengths_path, [("shuttle", 100)])
        expect_pipeline_error(lambda: tp.run(geojson_path, loop_lengths_path, out_dir, None), "--loop-name")
    print("[ok] Option B without --loop-name rejected")


def main():
    test_happy_path_option_a()
    test_pinned_segment_excluded_from_scaling()
    test_wgs84_swap_rejected()
    test_endpoint_discontinuity_rejected()
    test_missing_wraparound_rejected()
    test_duplicate_seg_id_rejected()
    test_noncontiguous_order_rejected()
    test_too_few_points_rejected()
    test_multilinestring_rejected()
    test_unknown_loop_in_calibration_rejected()
    test_option_b_merges_and_closes_ring()
    test_option_b_requires_loop_name()
    print("all tests passed")


if __name__ == "__main__":
    main()
