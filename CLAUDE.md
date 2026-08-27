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
