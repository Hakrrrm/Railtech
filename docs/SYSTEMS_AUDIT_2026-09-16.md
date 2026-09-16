# Railtech systems audit — 16 September 2026

## Scope and decision

This review covered the React dashboard, Supabase schema/migrations/seed,
Realtime subscriptions, MQTT ingest bridge and simulator, track-data pipeline,
and both ESP32 firmware targets. The review used the SGRTGC 2026 challenge brief
as the product baseline.

The implementation is ready for the deterministic showcase after the two
operations migrations are applied. The simulated MQTT path is code-complete and
its broker transport has been exercised. Field use remains conditional on an
authenticated TLS broker, role-based dashboard access, and automatic replay of
events retained on the device SD card.

## Critical finding

The original operations migration contained an invalid PL/pgSQL expression in
`schedule_maintenance`. Because the migration is transactional, PostgreSQL rolls
back every table, view and function in that migration when it reaches the syntax
error. A read-only check of the configured Supabase project found the 30 vehicles
and 150 original cycle rows, but none of the operations tables or views. This
explains a dashboard shell with empty or unavailable operations content.

The expression is corrected on this branch. Existing four-table projects must
run, in order:

1. `supabase/migrations/202609150001_dashboard_operations_v2.sql`
2. `supabase/migrations/202609160001_systems_audit_fixes.sql`
3. `supabase/seed.dashboard_demo.sql`
4. `supabase/validate.dashboard_demo.sql`

## Level 1 — deterministic synthetic data

**Status: ready after migration.**

- A real PostgreSQL 18 test covered both a fresh `schema.sql` installation and
  an upgrade from the original four-table database.
- On both paths the audit migration was run twice, the seed was run twice, and
  the validation was run after the second seed.
- The result remained 30 vehicles and 150 cycle states, with more than 28,000
  time-relative traversal rows. The 22/4/2/2 status split and named D07–D30
  scenarios passed without duplicate demo records.
- D12 is now due today because its mileage has reached the threshold; a stale
  seeded `due_date` can no longer override a positive mileage remainder.
- Nested maintenance completion, duplicate-event idempotency, booking conflicts,
  service coverage, replacement eligibility and stock-change atomicity passed.
- Anonymous reads and approved RPCs passed under RLS; direct anonymous depot-bay
  deletion was rejected.
- LTA-confirmed package rules are encoded as continuous bay occupancy: 2K is
  2 hours, 13K is 4 hours, 40K is 6 hours, 120K is 24 hours and 360K is 21
  elapsed days including weekends and waiting time. Every higher package
  includes all lower cycles.

## Level 2 — simulated live run

**Status: ready after migration and bridge configuration.**

- The simulator emits the same Tier 1 `SEG_DONE` object as firmware and now uses
  QoS 1 for the demo path.
- A live broker round trip successfully published, received and validated a
  simulator packet.
- `SIM_SPEED` now changes cadence and dwell time. It no longer corrupts the
  calibrated distance associated with a segment ID.
- Initial odometers match the SQL seed for every vehicle. If credentials are
  available, startup reconciles local state with Supabase so a reset state file
  cannot move mileage backwards.
- Reserved simulator sequences and database uniqueness make retransmission safe.
- The bridge retries short database failures three times, serializes work per
  vehicle and durably dead-letters exhausted rows.

The configured Supabase project cannot pass the final simulator-to-dashboard
test until the corrected operations migrations are applied. No external data was
mutated during this audit.

## Level 3 — real MQTT packets

**Status: contract-compatible, with field-readiness gates.**

- Both ESP32 targets compile. The serializer's byte-for-byte packet matches the
  ingest contract, including `nsv` and `dwell_s`.
- The ingest boundary rejects invalid topics, mismatched topic/payload vehicle
  IDs, non-finite numbers, impossible ranges, bad directions and implausible
  timestamps before they can affect planning mileage.
- Database constraints protect direct writes, and a per-vehicle ordering trigger
  rejects odometer regression even when a client bypasses the bridge.
- Duplicate `(lrv_id, seq)` packets do not increment maintenance cycles twice.
- Future event types with a valid common envelope are ignored cleanly instead of
  being incorrectly required to carry every `SEG_DONE` field.

Remaining field gates:

- Cellular firmware publishes QoS 0. Failed packets remain on SD, but automatic
  SD-to-MQTT replay is not implemented. An outage can therefore leave the cloud
  behind until a manual recovery is performed.
- The default public test broker is unencrypted and unauthenticated. It is useful
  for a bench demo, not an operational network.
- The modem/GNSS path still needs a supervised run on the target LRV route to
  measure lock continuity, segment-match accuracy and reconnect behavior.
- Device sequence identity has no boot/session epoch. Reflashing NVS to zero can
  collide with historical `(lrv_id, seq)` values and needs a commissioning rule
  or a future protocol revision.

## Corrections made

- Fixed the operations migration syntax that prevented the whole migration from
  installing.
- Added an idempotent audit migration and kept `schema.sql` complete for fresh
  projects.
- Added value constraints and odometer-order validation for telemetry, anchors,
  vehicles and cycle state.
- Made maintenance booking safe against bay overlap, same-vehicle overlap,
  undersized slots, incompatible bays, incomplete nested-cycle sets and
  concurrent service-floor violations.
- Made booking completion one-time and, when a booking ID is supplied, required
  a matching confirmed booking, rejected physical-mileage regression and
  recorded high divergence for review.
- Separated planned package scope from technician-confirmed work. A reduced
  completion resets only the selected cycles, is marked partially completed and
  requires an explanation.
- Added cross-day continuous bay occupation, accurate long-window concurrency
  checks and rejection of confirmed depot stays that overlap operating duties.
- Added booking cancellation through a validating RPC.
- Excluded already-assigned LRVs from replacement recommendations and checked
  the exact replacement duty against bookings, duties and maintenance margin.
- Limited direct anonymous writes to configuration fields used by the prototype;
  operational changes use guarded functions.
- Prevented browser use of `sb_secret_` and service-role JWTs, and separated
  frontend and ingest environment examples.
- Removed the unused OCR dependency, corrected Singapore-date calculations,
  used configured stale thresholds, and stopped the route view from inventing a
  position when real segment geometry is unavailable.
- Expanded the root test command so firmware logic, track generation, ingest,
  simulator, frontend tests, lint and production build run together.

## Challenge alignment

| Brief criterion / demand | Current alignment | Evidence and gap |
| --- | --- | --- |
| Automated, timely mileage capture | Strong prototype | Segment completion updates planning mileage and all five PM cycles automatically. Field reliability still needs SD replay. |
| Central visibility and usable UI | Strong | Fleet, vehicle, maintenance, deployment and audit views convert distance into forecast days and ranked actions. |
| Effective maintenance planning | Strong demo, unmeasured operations | Forecast queue, LTA-confirmed nested packages and durations, continuous bay occupancy and service-floor protection are implemented. Actual bay count and staffing rules still need owner validation. |
| Service-preserving deployment | Strong demo | D29 withdrawal and D27/D28 reserve ranking show an atomic stock change with duty and mileage-margin checks. Live duty feeds are still synthetic. |
| Innovation | Good | Reconciled physical/device mileage, evidence retention, forecast-based recall and maintenance-aware stock selection form one decision loop. OCR remains deferred. |
| Feasibility and low disruption | Good prototype | Existing vehicle packets feed an additive cloud model without changing the dashboard contract. Authentication, secure broker operation and field commissioning remain before deployment. |
| Scalability | Suitable for the 30-LRV challenge fleet | Indexed per-vehicle telemetry and derived views are appropriate at this size. Higher packet rates should replace page-level refetches with cached per-vehicle updates and add retention/aggregation policies. |
| Demonstrable impact | Needs measurement | The demo clearly shows decisions, but judging will be stronger with measured manual-entry time saved, mileage error, forecast error and avoided service withdrawals. |

The strongest judging story is the closed loop: capture completed segments,
reconcile them with definite physical readings, express maintenance risk in days,
reserve compatible capacity, and choose a replacement that preserves both
service and maintenance margin. The presentation should label depot capacity
and duty distance as synthetic assumptions. Package duration and nesting are
now based on LTA clarification.

## Verification evidence

- `run_tests.sh`: all firmware host suites, track-pipeline tests, ingest tests,
  simulator tests, frontend component tests, lint and production build passed.
- PlatformIO: `stage3-wifi-hotspot` and `stage5-gnss-matcher` passed release builds.
- SQL: fresh install, four-table upgrade, rerun safety, double seed, validation,
  RLS read/RPC access and rejected direct mutation passed on PostgreSQL 18.
- Dependencies: production audits reported zero known vulnerabilities for both
  Node projects.
- MQTT: one QoS 1 public-broker round trip passed through the production mapper.
