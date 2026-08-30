# CLAUDE.md

Project-level notes for Claude Code sessions working on this repo. See
`README.md` for the repository layout, host-test/build instructions, and
the track-data regeneration workflow -- this file is for design notes and
decisions worth remembering across sessions, not day-to-day usage.

## Future work: remote mileage correction over MQTT (post-Stage 7)

Not yet built. Captured here so the design isn't lost before Stage 7
(LTE + MQTT) exists to build it on.

**Goal:** let a central backend push a corrected odometer value down to
an LRV (e.g. after a technician enters a manual hubometer reading), and
have the correction survive the device losing power at any point before
it's confirmed applied.

**Current state this builds on:**
- MQTT today is publish-only, QoS 0 (`firmware/harness/stage3/main_hotspot_test.cpp`,
  `s_mqtt.publish(..., false)`) -- no `subscribe()` anywhere yet, and no
  backend-to-device push path exists at all.
- `supabase/schema.sql`'s `mileage_anchors` table already models the
  backend side of a manual correction (`value_km`, `override`,
  `technician_id`, `gnss_odo_km`, `divergence_km`, `superseded_by`) --
  nothing currently turns a new row there into a command sent to the
  vehicle.
- `firmware/src/seq_store.c/.h` already has the durability primitive this
  needs: NVS-backed, commit-before-act discipline. The design below
  reuses that pattern for an *inbound* command instead of an outbound
  event.

**Why a single persisted value isn't enough:** applying a remote
correction is a 3-step process (receive, apply, acknowledge), and a
power loss can happen between any two steps. The device needs a small
persisted state machine, not one NVS write, or a crash mid-sequence
either loses the correction or double-acks/double-applies it.

**Proposed NVS layout** (alongside `seq_store`'s existing `seq`/`odo_mm`):
```c
pend_cmd_id    uint32_t   /* 0 = nothing pending */
pend_target_mm int64_t    /* odometer value to set, millimetres */
pend_applied   bool       /* false = received, not yet applied to odo_mm
                            * true  = applied, waiting to confirm ack */
```

**Flow**, each step durable before the next is attempted:
1. Command arrives, e.g. topic `lrv/{fleet}/{id}/cmd/set_odo`, payload
   `{"cmd_id":"...", "target_km":128500.0}`.
2. If `cmd_id == pend_cmd_id` and `pend_applied` already true: this is a
   re-delivery -- just re-send the ack, don't reapply.
3. Otherwise, persist first: `pend_cmd_id`, `pend_target_mm`,
   `pend_applied = false`.
4. Apply: `seq_store_commit(seq+1, pend_target_mm)` -- the same call the
   bench reset button (`config.example.h`'s `RESET_BUTTON_ENABLED`) uses,
   just with the backend's value instead of 0.
5. Mark `pend_applied = true`. The odometer is now correct even if the
   device dies right here.
6. Publish an ack, e.g. `lrv/{fleet}/{id}/cmd_ack`,
   `{"cmd_id":"...","applied_odo_km":128500.0}`.
7. Once the publish succeeds, clear `pend_cmd_id = 0`.

**On every boot**, before resuming normal operation, check
`pend_cmd_id != 0`:
- `!pend_applied` -> crashed between step 3 and 4 -> apply now, continue
  to step 5/6.
- `pend_applied` -> crashed between step 5 and 7 -> odometer is already
  correct, just (re)send the ack once MQTT reconnects.

**QoS matters here.** Today's publish is QoS 0. This needs QoS >= 1 both
directions: subscribe at QoS 1 so the broker retries delivery of the
command, and publish the ack at QoS 1 too. The backend must treat a
duplicate ack for a `cmd_id` it's already seen as a no-op (idempotent),
not a second correction -- the device's own retry-until-cleared logic
above can legitimately send the same ack twice (e.g. applies and marks
`pend_applied`, then loses connectivity before confirming the publish
landed; next boot it tries the ack again).

**Not yet decided / worth revisiting when this gets built:** whether
`set_odo` should be an absolute value (as sketched above) or a signed
delta; whether the pending-command module should be its own
`firmware/src/pending_cmd_store.c/.h` (host-testable like `seq_store`) or
folded into `seq_store` itself; retry/backoff policy for the ack publish
if the broker is unreachable for an extended period.

**If `set_odo` ends up a signed delta**, `firmware/src/event_serializer.c`'s
`round_div_nonneg()` needs revisiting first. It rounds `d_mm`/`odo_mm` for
the SEG_DONE JSON assuming both are always >= 0 (true today -- a segment
length and a cumulative odometer never go negative) and is NOT correct
for a negative input (integer division/remainder sign handling in C
differs for negative operands, and the function's own name says
"nonneg"). A signed correction delta flowing through `seq_store_commit()`
into `odo_mm` and then through this same serialization path would hit
that unhandled case silently -- verify/fix `round_div_nonneg()` (or add a
signed-safe variant) as part of building this, don't assume it already
works.

## Known limitation: `seq_store_commit()`'s two NVS keys aren't one atomic write

Flagged during a Stage 7 audit, not yet fixed -- low real-world impact so
left as-is for now, but worth knowing before leaning on it harder (e.g.
for the remote-correction work above, which explicitly depends on
`seq_store`'s commit-before-act discipline being trustworthy).

`seq_store_commit()` (`firmware/src/seq_store.c`, target/NVS path) writes
`seq` and `odo_mm` as two separate NVS keys (`nvs_set_u32` then
`nvs_set_i64`), then calls `nvs_commit()`. There is no multi-key
transaction here: if the first write succeeds and the second fails, the
function correctly returns -1 (so that event is NOT published -- the
commit-before-publish contract itself still holds), but `seq` may already
be durably written to flash while `odo_mm` is not. A reboot right after
that exact failure would resume with a `seq` one ahead of what `odo_mm`
reflects.

Not independently verified against ESP-IDF's actual NVS write-durability
timing (no hardware/docs access when this was flagged) -- the failure
window might be narrower or wider than described above depending on
whether `nvs_set_u32` is durable immediately or only after `nvs_commit()`.
Either way, the two keys are never written as one atomic unit today.

Practical impact is limited, which is why this is deferred rather than
fixed immediately: the ingest bridge's `unique(lrv_id, seq)` constraint
does not require `seq` to be contiguous, only unique and increasing, so
the actual consequence of hitting this window is a gap in `seq` numbering
-- not odometer corruption, not a double-count, not a lost mileage
segment. Revisit if `seq` is ever relied on as a literal traversal count
rather than just a dedup/ordering key, or if the remote-correction work
above wants a stronger atomicity guarantee than this provides.

## Future work: multi-branch/depot track topology

Not yet built. The current matcher and track pipeline target a single
loop or a simple point-to-point line; this is what a real depot network
(one origin, several branch lines) would require and why it's a real
redesign, not a config flag. Verified against the code as it stands
(`map_matcher.c`, `track_pipeline.py`) rather than assumed -- see the
line references below.

**Verified against**: branch `main`, commit `db8e7ac` (the tip immediately
before this note was added). If `map_matcher.c`, `track_pipeline.py`, or
`track_types.h` have changed since, re-check the specific claims below
against current source before relying on them -- the line-level behaviour
described (loop-scoped `TRACK_NEXT_FWD`, the single-chain validation in
`build_segments_option_a`, the loop-agnostic bootstrap/re-acquisition
scan) is what was true at that commit, not a guarantee about later code.

**What already works today, and why:**
- Multiple independent loops can already coexist in one compiled
  dataset. `track_pipeline.py`'s `calibrate()` already groups segments
  `by_loop` and calibrates each independently; `track_types.h`/
  `track_data.h` already carry `TRACK_NUM_LOOPS`, `TRACK_LOOP_NAMES[]`,
  and a `loop_id` per segment. Nothing stops `track.geojson` from
  declaring a second `"loop"` name today.
- The matcher's bootstrap match (`st->cur_seg_idx < 0`) and the
  blackout re-acquisition path (`consecutive_miss >=
  MAP_MATCHER_REACQUIRE_MISSES`) both scan every segment across every
  loop with no loop filter -- so a vehicle that physically moved from
  one loop to an unrelated one will eventually be found there, as a
  side effect of the blackout-bridging work, not by original design.
  It re-bootstraps silently rather than fabricating an inferred
  traversal across the gap (`find_forward_path`'s BFS only walks
  same-loop `next_fwd` edges, so a cross-loop reappearance always finds
  no path and correctly credits nothing).

**What's actually missing for a real depot/branch network:**
1. **Steady-state tracking never crosses loops.** Forward adjacency
   (`TRACK_NEXT_FWD`) is built in `track_pipeline.py` filtered to
   `o.loop == s.loop` only; the matcher's reverse-neighbour scan in
   `map_matcher.c` has the same `loop_id` filter. While locked onto a
   segment, another loop's segments are never candidates, however close
   they are physically.
2. **The pipeline's validation model is a single chain, not a graph.**
   `build_segments_option_a` requires `order` to be contiguous 0..N-1
   and walks consecutive pairs asserting segment i's end coordinate is
   adjacent to segment i+1's start (plus one wraparound check for
   closure). This is one path or one ring -- there is no way to express
   a branch point (one node with 3+ outgoing segments) inside a single
   "loop" today. A depot with three lines would have to be three
   separate loops that merely happen to share a coordinate, and per
   point 1 above, those loops would NOT be connected in
   `TRACK_NEXT_FWD` even though they physically meet.
3. **Junction disambiguation is a real algorithmic gap, not just a data
   problem.** `nearest_on_segment()` is pure point-to-polyline
   distance. Right at a fork, every branch's polyline starts at
   (near enough) the same coordinate, so all candidate branches have
   near-zero, barely-distinguishable distance error at the moment of
   the fork. There's no "wait for more evidence before committing"
   state -- the matcher would pick whichever candidate wins the
   comparison first, which right at a shared point is close to
   arbitrary. Real disambiguation needs the vehicle to travel some
   minimum chainage down one specific branch before the geometry
   actually diverges enough to be confident.

**Rough scope, if this gets built:**
- Cross-loop adjacency: small, mechanical -- drop the `o.loop ==
  s.loop` filter in `track_pipeline.py`'s `TRACK_NEXT_FWD` builder and
  in `map_matcher.c`'s reverse-scan filter. The matcher's forward-
  neighbour lookup itself doesn't care about loop_id at all; the
  restriction lives only in those two specific filters.
- Relaxing the pipeline to allow real branch points: moderate, not
  small. The order-contiguity and endpoint-continuity validation is
  built entirely around "one sequential chain," and a good chunk of
  `test_track_pipeline.py`'s fixtures assume that shape. This is a real
  schema/validation redesign (loop -> network with junction nodes), not
  a tweak.
- Junction disambiguation (a short "tentative match" state that only
  promotes to a real crossing after a minimum chainage past the fork):
  the newest, most design-sensitive piece. Order of magnitude: a
  focused, testable addition (new state field(s) + new host tests), not
  a rewrite of the matcher.

**Hardware/processing verdict: not the bottleneck, memory shape is.**
`nearest_on_segment()` is cheap (one `cos()` per candidate segment, then
simple per-point arithmetic at ~5 m resampled spacing, one `sqrt` only
for the eventual winner) -- even a fairly large network (10 branches x
10 segments x ~100 points = 10,000 point evaluations for a full
re-acquisition scan) is a few hundred thousand flops, comfortably
sub-millisecond on the ESP32-S3's 240 MHz dual-core Xtensa with hardware
FPU. Steady-state per-second cost is far smaller (bounded to the current
segment plus its few neighbours).

The one real scaling concern is `TRACK_NEXT_FWD[TRACK_NUM_SEGMENTS]
[TRACK_NUM_SEGMENTS]` -- a DENSE `int16_t` matrix, O(N^2) in the TOTAL
segment count across the whole compiled dataset, not per loop. Fine
today (6 segments); at ~500 total segments across a depot network
that's 500 KB, at ~1000 it's 2 MB. Should sit in flash (`.rodata`,
XIP-mapped, this board has 16 MB) rather than the much smaller internal
SRAM, but that placement should be CONFIRMED, not assumed, once this is
real. Either way it's a wasteful representation for what's actually a
sparse graph (most segments have 0-2 neighbours) -- worth switching to
a small fixed-size per-segment neighbour list (bounded to e.g. 4)
instead of a dense N x N table once the network grows into the
hundreds of total segments. That swap is itself contained, not a
redesign.

**Bottom line:** for a realistic single-depot, few-branch network with
segment counts in the tens, none of the above is a hardware constraint
-- it's entirely a software/data-model design question. The compute and
flash budget only start to matter if the combined network grows into
the hundreds of total segments, and even then the fix (sparse adjacency)
is a contained change, not a rewrite.
