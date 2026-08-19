#!/usr/bin/env python3
"""
track_pipeline.py -- track dataset drop-in pipeline (Build Plan Sec 4).

Consumes track.geojson (+ loop_lengths.csv) and emits segments.csv and
track_data.h. Every dataset rule in Build Plan Sec 4.2 is enforced as a
hard, loud error naming the offending seg_id/coordinates -- this module
must never fail silently.

Stdlib only, on purpose: this tool has to run on a contributor's laptop
with nothing installed beyond Python 3.

Usage:
    python3 track_pipeline.py --geojson track.geojson \\
        --loop-lengths loop_lengths.csv --out-dir build/ \\
        [--loop-name NAME]   # required only for an Option B (raw trace) file

Outputs (in --out-dir):
    segments.csv   seg_id, order, loop, from, to, length_m (post-calibration), bidir
    track_data.h   fixed-point C arrays for the firmware matcher
"""
import argparse
import csv
import json
import math
import sys
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

RESAMPLE_STEP_M = 5.0          # TDD Sec 5.5: 5 m resampled polyline, chainage = 5*i
MIN_POINTS_PER_SEGMENT = 4     # Build Plan Sec 4.2
ENDPOINT_TOLERANCE_M = 0.5     # "share endpoint exactly" allowing for float round-trip
RESIDUAL_WARN_PCT = 3.0        # Build Plan Sec 4.5: <1% GPS-logged, <3% hand-traced

Coord = Tuple[float, float]  # (lon, lat)


class PipelineError(Exception):
    """A dataset rule violation. Message must be specific and actionable."""


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------

def haversine_m(a: Coord, b: Coord) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def polyline_length_m(coords: List[Coord]) -> float:
    return sum(haversine_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def resample_polyline(coords: List[Coord], step_m: float) -> List[Coord]:
    """Resamples a polyline to ~step_m spacing by linear interpolation in
    lon/lat, always keeping the first and last vertex exactly."""
    if len(coords) < 2:
        return list(coords)
    total = polyline_length_m(coords)
    if total <= 0:
        return [coords[0], coords[-1]]
    n_steps = max(1, round(total / step_m))
    out = [coords[0]]
    seg_idx = 0
    seg_start_d = 0.0
    seg_len = haversine_m(coords[0], coords[1])
    for i in range(1, n_steps):
        target_d = total * i / n_steps
        while seg_idx < len(coords) - 2 and seg_start_d + seg_len < target_d:
            seg_start_d += seg_len
            seg_idx += 1
            seg_len = haversine_m(coords[seg_idx], coords[seg_idx + 1])
        frac = 0.0 if seg_len == 0 else (target_d - seg_start_d) / seg_len
        frac = min(1.0, max(0.0, frac))
        lon = coords[seg_idx][0] + frac * (coords[seg_idx + 1][0] - coords[seg_idx][0])
        lat = coords[seg_idx][1] + frac * (coords[seg_idx + 1][1] - coords[seg_idx][1])
        out.append((lon, lat))
    out.append(coords[-1])
    return out


def coords_close(a: Coord, b: Coord, tol_m: float) -> bool:
    return haversine_m(a, b) <= tol_m


def validate_wgs84(coords: List[Coord], where: str) -> None:
    for (x, y) in coords:
        if not (-180.0 <= x <= 180.0) or not (-90.0 <= y <= 90.0):
            raise PipelineError(
                f"{where}: coordinate ({x}, {y}) is outside WGS84 lon,lat range. "
                f"GeoJSON coordinates are always [lon, lat] -- check for a lat,lon swap."
            )


# --------------------------------------------------------------------------
# Segment model
# --------------------------------------------------------------------------

@dataclass
class Segment:
    seg_id: str
    order: int
    loop: str
    frm: str
    to: str
    bidir: bool
    coords: List[Coord]
    pinned_len_m: Optional[float] = None
    length_m: float = field(init=False, default=0.0)  # filled after calibration

    @property
    def raw_length_m(self) -> float:
        return polyline_length_m(self.coords)


# --------------------------------------------------------------------------
# GeoJSON loading + mode detection
# --------------------------------------------------------------------------

def load_geojson(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise PipelineError(f"could not read/parse '{path}' as JSON: {e}")
    if data.get("type") != "FeatureCollection":
        raise PipelineError(f"'{path}': top-level 'type' must be 'FeatureCollection'")
    features = data.get("features")
    if not isinstance(features, list) or len(features) == 0:
        raise PipelineError(f"'{path}': 'features' must be a non-empty array")
    return data


def feature_coords(feat: dict, index: int) -> List[Coord]:
    geom = feat.get("geometry") or {}
    gtype = geom.get("type")
    if gtype == "MultiLineString":
        raise PipelineError(
            f"feature[{index}]: geometry is MultiLineString, not LineString. "
            f"One LineString per Feature only (Build Plan Sec 4.2)."
        )
    if gtype != "LineString":
        raise PipelineError(f"feature[{index}]: geometry.type must be 'LineString', got '{gtype}'")
    coords = geom.get("coordinates")
    if not isinstance(coords, list):
        raise PipelineError(f"feature[{index}]: geometry.coordinates missing or malformed")
    out = []
    for c in coords:
        if not (isinstance(c, list) and len(c) >= 2):
            raise PipelineError(f"feature[{index}]: malformed coordinate {c!r}")
        out.append((float(c[0]), float(c[1])))
    return out


def detect_mode(features: List[dict]) -> str:
    have = [bool((f.get("properties") or {}).get("seg_id")) for f in features]
    if all(have):
        return "A"
    if not any(have):
        return "B"
    raise PipelineError(
        "features mix seg_id-tagged and untagged entries -- pick either Option A "
        "(every Feature carries seg_id/order/from/to/loop) or Option B (no properties "
        "required), not a mixture of the two."
    )


# --------------------------------------------------------------------------
# Option A: pre-segmented
# --------------------------------------------------------------------------

def build_segments_option_a(geojson: dict) -> List[Segment]:
    features = geojson["features"]
    segments: List[Segment] = []
    seen_ids = set()

    for i, feat in enumerate(features):
        props = feat.get("properties") or {}
        seg_id = props.get("seg_id")
        if not seg_id or not isinstance(seg_id, str) or " " in seg_id:
            raise PipelineError(f"feature[{i}]: seg_id missing, non-string, or contains spaces: {seg_id!r}")
        if seg_id in seen_ids:
            raise PipelineError(f"seg_id '{seg_id}' is not unique across the file")
        seen_ids.add(seg_id)

        order = props.get("order")
        if not isinstance(order, int) or order < 0:
            raise PipelineError(f"segment '{seg_id}': order must be a non-negative integer, got {order!r}")

        loop = props.get("loop")
        if not loop or not isinstance(loop, str):
            raise PipelineError(f"segment '{seg_id}': loop is missing or not a string")

        frm, to = props.get("from"), props.get("to")
        if not frm or not to:
            raise PipelineError(f"segment '{seg_id}': from/to node names are required")

        bidir = props.get("bidir")
        if not isinstance(bidir, bool):
            raise PipelineError(f"segment '{seg_id}': bidir must be true/false, got {bidir!r}")

        len_m_override = props.get("len_m")
        if len_m_override is not None and not isinstance(len_m_override, (int, float)):
            raise PipelineError(f"segment '{seg_id}': len_m must be null or a number, got {len_m_override!r}")

        coords = feature_coords(feat, i)
        validate_wgs84(coords, f"segment '{seg_id}'")
        if len(coords) < MIN_POINTS_PER_SEGMENT:
            raise PipelineError(
                f"segment '{seg_id}': only {len(coords)} coordinate points, needs at least "
                f"{MIN_POINTS_PER_SEGMENT} (curves need more -- chord under-read is s^2/(24R^2) per chord)"
            )

        segments.append(Segment(
            seg_id=seg_id, order=order, loop=loop, frm=frm, to=to, bidir=bidir,
            coords=coords, pinned_len_m=float(len_m_override) if len_m_override is not None else None,
        ))

    # order contiguous 0..N-1 within each loop
    by_loop: Dict[str, List[Segment]] = {}
    for s in segments:
        by_loop.setdefault(s.loop, []).append(s)

    for loop, segs in by_loop.items():
        segs.sort(key=lambda s: s.order)
        expected = list(range(len(segs)))
        actual = [s.order for s in segs]
        if actual != expected:
            raise PipelineError(
                f"loop '{loop}': order values {sorted(actual)} are not contiguous 0..{len(segs) - 1} "
                f"(duplicate or gapped order breaks the matcher's reachable-next-segment topology)"
            )

        # closed iff the author's own from/to topology says so
        closed = segs[-1].to == segs[0].frm
        n = len(segs)
        for i in range(n):
            j = i + 1
            is_wrap = (j == n)
            if is_wrap:
                if not closed:
                    continue
                j = 0
            a, b = segs[i], segs[j]
            end_a, start_b = a.coords[-1], b.coords[0]
            if not coords_close(end_a, start_b, ENDPOINT_TOLERANCE_M):
                dist = haversine_m(end_a, start_b)
                kind = "closed-loop wraparound" if is_wrap else "consecutive segment"
                raise PipelineError(
                    f"loop '{loop}': {kind} discontinuity between '{a.seg_id}' (order {a.order}) "
                    f"end {end_a} and '{b.seg_id}' (order {b.order}) start {start_b}, "
                    f"{dist:.2f} m apart (must share an endpoint exactly). "
                    f"linemerge fails silently on this -- a gap becomes two disconnected "
                    f"components and mileage under-counts."
                )

    return segments


# --------------------------------------------------------------------------
# Option B: raw merged trace -- degree-based topology split
# --------------------------------------------------------------------------

def _node_key(c: Coord, precision: int = 6) -> Coord:
    return (round(c[0], precision), round(c[1], precision))


def build_segments_option_b(geojson: dict, loop_name: str) -> List[Segment]:
    features = geojson["features"]
    ways: List[List[Coord]] = []
    for i, feat in enumerate(features):
        coords = feature_coords(feat, i)
        validate_wgs84(coords, f"feature[{i}]")
        if len(coords) < 2:
            raise PipelineError(f"feature[{i}]: LineString needs at least 2 points")
        ways.append(coords)

    # Degree of each endpoint node across all ways.
    degree: Dict[Coord, int] = {}
    for w in ways:
        for end in (_node_key(w[0]), _node_key(w[-1])):
            degree[end] = degree.get(end, 0) + 1

    # Adjacency: node -> list of (way_index, is_forward)
    adjacency: Dict[Coord, List[Tuple[int, bool]]] = {}
    for idx, w in enumerate(ways):
        adjacency.setdefault(_node_key(w[0]), []).append((idx, True))
        adjacency.setdefault(_node_key(w[-1]), []).append((idx, False))

    boundary_nodes = {n for n, d in degree.items() if d != 2}
    used = [False] * len(ways)

    def walk_from(start_way: int, forward: bool) -> List[Coord]:
        """Walks a chain of degree-2 pass-through ways starting at
        start_way, stopping at the next boundary node (or back at start
        for an isolated ring with no boundary nodes at all)."""
        chain: List[Coord] = list(ways[start_way]) if forward else list(reversed(ways[start_way]))
        used[start_way] = True
        cur_end = _node_key(chain[-1])
        first_node = _node_key(chain[0])
        while cur_end not in boundary_nodes:
            candidates = [(i, fwd) for (i, fwd) in adjacency.get(cur_end, []) if not used[i]]
            if not candidates:
                break
            nxt_idx, nxt_fwd_at_node = candidates[0]
            piece = list(ways[nxt_idx])
            # orient piece so it starts at cur_end
            if _node_key(piece[0]) != cur_end:
                piece = list(reversed(piece))
            used[nxt_idx] = True
            chain.extend(piece[1:])
            cur_end = _node_key(chain[-1])
            if cur_end == first_node:
                break  # closed ring with no internal junctions
        return chain

    chains: List[List[Coord]] = []
    for idx in range(len(ways)):
        if used[idx]:
            continue
        start_node = _node_key(ways[idx][0])
        if start_node in boundary_nodes:
            chains.append(walk_from(idx, forward=True))
        # else: interior of some other chain, will be consumed by its walk

    # Any leftover ways form closed rings with zero boundary nodes anywhere.
    for idx in range(len(ways)):
        if not used[idx]:
            chains.append(walk_from(idx, forward=True))

    if not chains:
        raise PipelineError("Option B: no segments could be derived from the input geometry")

    segments: List[Segment] = []
    for order, chain in enumerate(chains):
        if len(chain) < MIN_POINTS_PER_SEGMENT:
            raise PipelineError(
                f"Option B: derived segment #{order} (loop '{loop_name}') has only "
                f"{len(chain)} points, needs at least {MIN_POINTS_PER_SEGMENT}"
            )
        frm, to = f"N{order}", f"N{order + 1}"
        segments.append(Segment(
            seg_id=f"{loop_name}_{order}", order=order, loop=loop_name,
            frm=frm, to=to, bidir=True, coords=chain,
        ))

    if len(segments) == 1:
        print(
            f"WARNING: Option B found no junction/dead-end boundary nodes for loop "
            f"'{loop_name}' -- the whole trace merged into a single segment. If you "
            f"need per-station segments, use Option A with explicit seg_id/order/from/to.",
            file=sys.stderr,
        )

    return segments


# --------------------------------------------------------------------------
# Calibration (Build Plan Sec 4.3)
# --------------------------------------------------------------------------

def load_loop_lengths(path: str) -> Dict[str, float]:
    out: Dict[str, float] = {}
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            if reader.fieldnames is None or set(reader.fieldnames) < {"loop", "authoritative_m"}:
                raise PipelineError(
                    f"'{path}': expected columns 'loop,authoritative_m', got {reader.fieldnames!r}"
                )
            for row in reader:
                loop = row["loop"].strip()
                try:
                    val = float(row["authoritative_m"])
                except ValueError:
                    raise PipelineError(f"'{path}': non-numeric authoritative_m for loop '{loop}': {row['authoritative_m']!r}")
                if loop in out:
                    raise PipelineError(f"'{path}': loop '{loop}' listed more than once")
                out[loop] = val
    except OSError as e:
        raise PipelineError(f"could not read '{path}': {e}")
    return out


def calibrate(segments: List[Segment], loop_lengths: Dict[str, float]) -> None:
    by_loop: Dict[str, List[Segment]] = {}
    for s in segments:
        by_loop.setdefault(s.loop, []).append(s)

    for loop, segs in by_loop.items():
        if loop not in loop_lengths:
            raise PipelineError(
                f"loop '{loop}' appears in the track data but has no authoritative_m "
                f"entry in loop_lengths.csv"
            )
        target_m = loop_lengths[loop]

        pinned = [s for s in segs if s.pinned_len_m is not None]
        scalable = [s for s in segs if s.pinned_len_m is None]
        pinned_total = sum(s.pinned_len_m for s in pinned)
        remaining = target_m - pinned_total
        scalable_raw_total = sum(s.raw_length_m for s in scalable)

        if remaining < 0:
            raise PipelineError(
                f"loop '{loop}': pinned segment lengths already total {pinned_total:.1f} m, "
                f"more than the authoritative {target_m:.1f} m"
            )
        if scalable and scalable_raw_total <= 0:
            raise PipelineError(f"loop '{loop}': scalable segments have zero total raw length, cannot calibrate")

        residual_pct = 0.0 if target_m == 0 else abs(scalable_raw_total - remaining) / target_m * 100.0
        if residual_pct > RESIDUAL_WARN_PCT:
            print(
                f"WARNING: loop '{loop}' pre-calibration residual is {residual_pct:.1f}% "
                f"(expect <1% for GPS-logged traces, <3% for hand-traced)",
                file=sys.stderr,
            )

        for s in pinned:
            s.length_m = round(s.pinned_len_m)

        if scalable:
            scale = remaining / scalable_raw_total
            raw_scaled = [(s, s.raw_length_m * scale) for s in scalable]
            floors = [(s, math.floor(v), v - math.floor(v)) for s, v in raw_scaled]
            total_floor = sum(f for _, f, _ in floors)
            deficit = int(round(remaining)) - int(total_floor)
            # largest-remainder method, deterministic tie-break by seg_id
            floors.sort(key=lambda t: (-t[2], t[0].seg_id))
            for i, (s, f, _r) in enumerate(floors):
                s.length_m = f + (1 if i < deficit else 0)


# --------------------------------------------------------------------------
# Outputs
# --------------------------------------------------------------------------

def write_segments_csv(path: str, segments: List[Segment]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["seg_id", "order", "loop", "from", "to", "length_m", "bidir"])
        for s in sorted(segments, key=lambda s: (s.loop, s.order)):
            w.writerow([s.seg_id, s.order, s.loop, s.frm, s.to, int(s.length_m), "1" if s.bidir else "0"])


def c_string_literal(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def write_track_data_h(path: str, segments: List[Segment]) -> None:
    ordered = sorted(segments, key=lambda s: (s.loop, s.order))
    loops = sorted({s.loop for s in ordered})
    loop_index = {name: i for i, name in enumerate(loops)}
    idx_by_seg_id = {s.seg_id: i for i, s in enumerate(ordered)}

    lines = []
    lines.append("/* Auto-generated by tools/track_pipeline.py -- DO NOT EDIT BY HAND.")
    lines.append(" * Regenerate after ANY track.geojson/loop_lengths.csv change. */")
    lines.append("#ifndef TRACK_DATA_H")
    lines.append("#define TRACK_DATA_H")
    lines.append("")
    lines.append("#include <stdint.h>")
    lines.append("")
    lines.append(f"#define TRACK_NUM_SEGMENTS {len(ordered)}")
    lines.append(f"#define TRACK_NUM_LOOPS {len(loops)}")
    lines.append("")
    lines.append("typedef struct { int32_t lat_e7; int32_t lon_e7; } track_point_t;")
    lines.append("")
    lines.append("typedef struct {")
    lines.append("    const char *seg_id;")
    lines.append("    const char *from_node;")
    lines.append("    const char *to_node;")
    lines.append("    uint8_t     loop_id;      /* index into TRACK_LOOP_NAMES */")
    lines.append("    uint8_t     bidir;")
    lines.append("    int32_t     length_mm;")
    lines.append("    uint16_t    num_points;")
    lines.append("    const track_point_t *points; /* ~5 m resampled polyline */")
    lines.append("} track_segment_t;")
    lines.append("")
    lines.append(f"static const char *const TRACK_LOOP_NAMES[TRACK_NUM_LOOPS] = {{")
    lines.append("    " + ", ".join(c_string_literal(n) for n in loops) + ",")
    lines.append("};")
    lines.append("")

    for s in ordered:
        pts = resample_polyline(s.coords, RESAMPLE_STEP_M)
        arr_name = f"track_pts_{idx_by_seg_id[s.seg_id]}"
        lines.append(f"static const track_point_t {arr_name}[{len(pts)}] = {{")
        for (lon, lat) in pts:
            lines.append(f"    {{ {round(lat * 1e7)}, {round(lon * 1e7)} }},")
        lines.append("};")

    lines.append("")
    lines.append(f"static const track_segment_t TRACK_SEGMENTS[TRACK_NUM_SEGMENTS] = {{")
    for s in ordered:
        i = idx_by_seg_id[s.seg_id]
        pts = resample_polyline(s.coords, RESAMPLE_STEP_M)
        lines.append(
            f"    {{ {c_string_literal(s.seg_id)}, {c_string_literal(s.frm)}, "
            f"{c_string_literal(s.to)}, {loop_index[s.loop]}, {1 if s.bidir else 0}, "
            f"{int(round(s.length_m * 1000))}, {len(pts)}, track_pts_{i} }},"
        )
    lines.append("};")
    lines.append("")

    # Adjacency: reachable next-segment indices per direction, derived from
    # shared from/to node names within the same loop.
    lines.append("/* Reachable next segments, forward direction (this.to == next.from). */")
    lines.append("static const int16_t TRACK_NEXT_FWD[TRACK_NUM_SEGMENTS][TRACK_NUM_SEGMENTS] = {")
    for s in ordered:
        nexts = [idx_by_seg_id[o.seg_id] for o in ordered if o.loop == s.loop and o.frm == s.to]
        padded = nexts + [-1] * (len(ordered) - len(nexts))
        lines.append("    { " + ", ".join(str(x) for x in padded) + " },")
    lines.append("};")
    lines.append(
        "static const uint8_t TRACK_NEXT_FWD_COUNT[TRACK_NUM_SEGMENTS] = { "
        + ", ".join(str(len([o for o in ordered if o.loop == s.loop and o.frm == s.to])) for s in ordered)
        + " };"
    )
    lines.append("")
    lines.append("#endif /* TRACK_DATA_H */")
    lines.append("")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def run(geojson_path: str, loop_lengths_path: str, out_dir: str, loop_name: Optional[str]) -> None:
    import os

    geojson = load_geojson(geojson_path)
    mode = detect_mode(geojson["features"])

    if mode == "A":
        if loop_name is not None:
            raise PipelineError("--loop-name is only used with Option B (raw trace) input")
        segments = build_segments_option_a(geojson)
        print(f"Option A: {len(segments)} pre-segmented features")
    else:
        if not loop_name:
            raise PipelineError("Option B (raw trace, no seg_id properties) requires --loop-name")
        segments = build_segments_option_b(geojson, loop_name)
        print(f"Option B: derived {len(segments)} segment(s) for loop '{loop_name}'")

    loop_lengths = load_loop_lengths(loop_lengths_path)
    calibrate(segments, loop_lengths)

    by_loop: Dict[str, float] = {}
    for s in segments:
        by_loop[s.loop] = by_loop.get(s.loop, 0.0) + s.length_m
    print(f"{len(by_loop)} loop(s) processed")
    for loop, total in sorted(by_loop.items()):
        print(f"  loop '{loop}': total length_m = {total:.0f}")

    os.makedirs(out_dir, exist_ok=True)
    segments_csv = os.path.join(out_dir, "segments.csv")
    track_data_h = os.path.join(out_dir, "track_data.h")
    write_segments_csv(segments_csv, segments)
    write_track_data_h(track_data_h, segments)
    print(f"wrote {segments_csv}")
    print(f"wrote {track_data_h}")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Track dataset drop-in pipeline (Build Plan Sec 4)")
    p.add_argument("--geojson", required=True, help="path to track.geojson")
    p.add_argument("--loop-lengths", required=True, help="path to loop_lengths.csv")
    p.add_argument("--out-dir", required=True, help="directory to write segments.csv / track_data.h into")
    p.add_argument("--loop-name", default=None, help="loop name for Option B (raw trace) input")
    args = p.parse_args(argv)

    try:
        run(args.geojson, args.loop_lengths, args.out_dir, args.loop_name)
    except PipelineError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
