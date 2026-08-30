-- Railtech Supabase schema (Build Plan Sec 8, TDD Sec 5.8).
-- Run once in the Supabase SQL editor for a new project.
--
-- Table order matters: vehicles first, everything else references it.

create table vehicles (
  lrv_id text primary key,
  fleet text,
  type text,
  status text
);

create table segment_traversals (
  id bigint generated always as identity primary key,
  lrv_id text references vehicles,
  seq bigint not null,
  seg_id text not null,
  ts timestamptz not null,
  length_m numeric not null,
  dir text,        -- 'E'/'W' from the Tier 1 event -- forward/reverse
                    -- placeholder, not a real cardinal direction (see
                    -- firmware map_matcher.h). text, not char(1): the
                    -- direction model may grow beyond a single letter
                    -- before it grows real semantics.
  odo_km numeric,   -- device's own cumulative odometer AFTER this
                    -- segment, as reported in the same event -- lets you
                    -- detect device/backend divergence (device odo_km
                    -- vs. sum(length_m) here) without recomputing
                    -- anything.
  confidence numeric,
  hdop numeric,
  unique (lrv_id, seq)
);

-- Append-only: corrections are new rows with superseded_by set, never
-- UPDATE/DELETE (TDD Sec 5.8, non-negotiable). Enforced below by revoking
-- UPDATE/DELETE from the roles the app/bridge use.
create table mileage_anchors (
  id bigint generated always as identity primary key,
  lrv_id text references vehicles,
  ts timestamptz,
  technician_id text,
  source text,
  value_km numeric,
  override boolean default false,
  override_reason text,
  image_uri text,
  gnss_odo_km numeric,
  divergence_km numeric,
  superseded_by bigint references mileage_anchors
);

create table cycle_state (
  lrv_id text references vehicles,
  cycle_type int,
  km_since numeric,
  km_to_next numeric,
  due_date date,
  primary key (lrv_id, cycle_type)
);

-- Enforce append-only on mileage_anchors (Build Plan Sec 8 "Manual
-- configuration"). The service-role key used by the ingest bridge bypasses
-- RLS/grants, so this only constrains the anon/authenticated roles used by
-- client-facing apps -- exactly the roles that must never edit history.
revoke update, delete on mileage_anchors from anon, authenticated;
