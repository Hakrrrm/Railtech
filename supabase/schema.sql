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

-- Enables Supabase Realtime (a WebSocket push on INSERT/UPDATE/DELETE)
-- for the two tables frontend/src/App.jsx subscribes to for live
-- dashboard refresh. Without this, INSERTs land in the table fine, but
-- an already-open dashboard has no way to find out short of a manual
-- reload -- the subscription in App.jsx silently receives nothing.
alter publication supabase_realtime add table segment_traversals, mileage_anchors;

-- Dashboard operations v2 (kept inline so schema.sql creates a complete fresh project).
-- Railtech dashboard operations v2.
-- Apply after the original four-table schema. The migration is additive and
-- safe to rerun against the challenge demo project.

begin;
set local timezone to 'Asia/Singapore';

create extension if not exists btree_gist;

create table if not exists maintenance_cycle_rules (
  fleet text not null,
  cycle_type integer not null check (cycle_type in (2000, 13000, 40000, 120000, 360000)),
  threshold_km numeric not null check (threshold_km > 0),
  tolerance_km numeric not null default 0 check (tolerance_km >= 0),
  duration_minutes integer not null check (duration_minutes > 0),
  compatible_bay_type text not null,
  updated_at timestamptz not null default now(),
  primary key (fleet, cycle_type)
);

create table if not exists depot_bays (
  bay_id text primary key,
  fleet text not null,
  name text not null,
  bay_type text not null,
  opens_at time not null,
  closes_at time not null,
  active boolean not null default true,
  check (closes_at > opens_at)
);

create table if not exists maintenance_bookings (
  id uuid primary key default gen_random_uuid(),
  demo_key text unique,
  lrv_id text not null references vehicles(lrv_id),
  primary_cycle integer not null check (primary_cycle in (2000, 13000, 40000, 120000, 360000)),
  bundled_cycles integer[] not null default '{}',
  bay_id text not null references depot_bays(bay_id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'completed', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);

create table if not exists maintenance_events (
  id uuid primary key default gen_random_uuid(),
  demo_key text unique,
  booking_id uuid references maintenance_bookings(id),
  lrv_id text not null references vehicles(lrv_id),
  completion_mileage_km numeric not null check (completion_mileage_km >= 0),
  primary_cycle integer not null check (primary_cycle in (2000, 13000, 40000, 120000, 360000)),
  reset_cycles integer[] not null,
  technician_id text not null,
  source text not null,
  completed_at timestamptz not null default now(),
  notes text
);

create table if not exists duty_assignments (
  id uuid primary key default gen_random_uuid(),
  demo_key text unique,
  lrv_id text not null references vehicles(lrv_id),
  loop_id text not null,
  slot_label text not null,
  duty_start timestamptz not null,
  duty_end timestamptz not null,
  status text not null default 'planned' check (status in ('planned', 'active', 'completed', 'withdrawn', 'cancelled')),
  created_at timestamptz not null default now(),
  check (duty_end > duty_start)
);

create table if not exists stock_changes (
  id uuid primary key default gen_random_uuid(),
  demo_key text unique,
  withdrawn_assignment_id uuid not null references duty_assignments(id),
  replacement_assignment_id uuid references duty_assignments(id),
  withdrawn_lrv_id text not null references vehicles(lrv_id),
  replacement_lrv_id text not null references vehicles(lrv_id),
  reason text not null,
  projected_duty_km numeric not null check (projected_duty_km >= 0),
  decision_status text not null default 'proposed' check (decision_status in ('proposed', 'confirmed', 'cancelled')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (withdrawn_lrv_id <> replacement_lrv_id)
);

create table if not exists planning_settings (
  fleet text primary key,
  forecast_horizon_days integer not null default 14 check (forecast_horizon_days between 1 and 90),
  deployment_safety_margin_km numeric not null default 250 check (deployment_safety_margin_km >= 0),
  stale_telemetry_hours integer not null default 12 check (stale_telemetry_hours between 1 and 168),
  minimum_service_vehicles integer not null default 18 check (minimum_service_vehicles >= 0),
  operating_timezone text not null default 'Asia/Singapore',
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'maintenance_bookings_no_bay_overlap'
  ) then
    alter table maintenance_bookings
      add constraint maintenance_bookings_no_bay_overlap
      exclude using gist (
        bay_id with =,
        tstzrange(start_at, end_at, '[)') with &&
      ) where (status in ('proposed', 'confirmed'));
  end if;
end $$;

create index if not exists maintenance_bookings_vehicle_time_idx
  on maintenance_bookings (lrv_id, start_at desc);
create index if not exists maintenance_events_vehicle_time_idx
  on maintenance_events (lrv_id, completed_at desc);
create index if not exists duty_assignments_time_idx
  on duty_assignments (duty_start, duty_end, status);
create index if not exists stock_changes_created_idx
  on stock_changes (created_at desc);
create index if not exists segment_traversals_vehicle_ts_idx
  on segment_traversals (lrv_id, ts desc);
create index if not exists mileage_anchors_vehicle_ts_idx
  on mileage_anchors (lrv_id, ts desc);

create or replace function increment_cycle_state_from_traversal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update cycle_state
  set km_since = coalesce(km_since, 0) + new.length_m / 1000,
      km_to_next = coalesce(km_to_next, cycle_type) - new.length_m / 1000
  where lrv_id = new.lrv_id;
  return new;
end;
$$;

drop trigger if exists segment_traversal_increment_cycles on segment_traversals;
create trigger segment_traversal_increment_cycles
after insert on segment_traversals
for each row execute function increment_cycle_state_from_traversal();

create or replace view latest_vehicle_telemetry
with (security_invoker = true)
as
select
  vehicle.lrv_id,
  vehicle.fleet,
  vehicle.type,
  vehicle.status,
  latest.seq,
  latest.seg_id,
  latest.ts as latest_telemetry_at,
  latest.length_m,
  latest.dir,
  latest.odo_km as device_odo_km,
  latest.confidence,
  latest.hdop,
  extract(epoch from (now() - latest.ts)) / 3600 as telemetry_age_hours
from vehicles as vehicle
left join lateral (
  select traversal.*
  from segment_traversals as traversal
  where traversal.lrv_id = vehicle.lrv_id
  order by traversal.ts desc, traversal.id desc
  limit 1
) as latest on true;

create or replace view rolling_vehicle_daily_rate
with (security_invoker = true)
as
with daily as (
  select
    traversal.lrv_id,
    (traversal.ts at time zone 'Asia/Singapore')::date as operating_date,
    sum(traversal.length_m) / 1000 as distance_km
  from segment_traversals as traversal
  where (traversal.ts at time zone 'Asia/Singapore')::date
        between (now() at time zone 'Asia/Singapore')::date - 7
            and (now() at time zone 'Asia/Singapore')::date - 1
  group by traversal.lrv_id, (traversal.ts at time zone 'Asia/Singapore')::date
)
select
  vehicle.lrv_id,
  round(avg(daily.distance_km), 2) as rolling_daily_rate_km,
  count(daily.operating_date)::integer as observed_days
from vehicles as vehicle
left join daily on daily.lrv_id = vehicle.lrv_id
group by vehicle.lrv_id;

create or replace view vehicle_mileage_summary
with (security_invoker = true)
as
select
  vehicle.lrv_id,
  vehicle.fleet,
  vehicle.type,
  vehicle.status,
  latest.seg_id,
  latest.latest_telemetry_at,
  latest.telemetry_age_hours,
  latest.device_odo_km,
  latest.hdop,
  anchor.id as anchor_id,
  anchor.ts as last_physical_check_at,
  anchor.value_km as last_physical_check_km,
  anchor.divergence_km,
  case
    when anchor.id is not null then anchor.value_km + coalesce(post_anchor.distance_km, 0)
    else latest.device_odo_km
  end as lifetime_planning_mileage_km,
  coalesce(today.distance_km, 0) as mileage_today_km,
  rate.rolling_daily_rate_km,
  rate.observed_days
from vehicles as vehicle
left join latest_vehicle_telemetry as latest on latest.lrv_id = vehicle.lrv_id
left join lateral (
  select candidate.*
  from mileage_anchors as candidate
  where candidate.lrv_id = vehicle.lrv_id
    and candidate.superseded_by is null
  order by candidate.ts desc nulls last, candidate.id desc
  limit 1
) as anchor on true
left join lateral (
  select sum(traversal.length_m) / 1000 as distance_km
  from segment_traversals as traversal
  where traversal.lrv_id = vehicle.lrv_id
    and anchor.ts is not null
    and traversal.ts > anchor.ts
) as post_anchor on true
left join lateral (
  select sum(traversal.length_m) / 1000 as distance_km
  from segment_traversals as traversal
  where traversal.lrv_id = vehicle.lrv_id
    and (traversal.ts at time zone 'Asia/Singapore')::date =
        (now() at time zone 'Asia/Singapore')::date
) as today on true
left join rolling_vehicle_daily_rate as rate on rate.lrv_id = vehicle.lrv_id;

create or replace view cycle_forecasts
with (security_invoker = true)
as
select
  cycle.lrv_id,
  cycle.cycle_type,
  cycle.km_since,
  cycle.km_to_next,
  cycle.due_date as seeded_due_date,
  mileage.rolling_daily_rate_km,
  case
    when cycle.due_date <= (now() at time zone 'Asia/Singapore')::date then
      coalesce(cycle.due_date, (now() at time zone 'Asia/Singapore')::date)
      - (now() at time zone 'Asia/Singapore')::date
    when mileage.latest_telemetry_at is null then null
    when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then null
    when coalesce(mileage.rolling_daily_rate_km, 0) <= 0 then null
    else ceil(cycle.km_to_next / mileage.rolling_daily_rate_km)::integer
  end as forecast_days,
  case
    when cycle.due_date <= (now() at time zone 'Asia/Singapore')::date then cycle.due_date
    when mileage.latest_telemetry_at is null then null
    when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then null
    when coalesce(mileage.rolling_daily_rate_km, 0) <= 0 then null
    else (now() at time zone 'Asia/Singapore')::date
         + ceil(cycle.km_to_next / mileage.rolling_daily_rate_km)::integer
  end as forecast_date,
  (
    case when cycle.km_to_next <= 0 then 1000 else 0 end
    + case when mileage.status = 'faulty' then 700 when mileage.status = 'maintenance' then 350 else 0 end
    + case
        when mileage.latest_telemetry_at is null then 250
        when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then 200
        else 0
      end
    + greatest(0, 200 - coalesce(ceil(cycle.km_to_next / nullif(mileage.rolling_daily_rate_km, 0)), 200))
    + case when abs(coalesce(mileage.divergence_km, 0)) >= 50 then 300 else 0 end
  )::numeric as priority_score
from cycle_state as cycle
join vehicle_mileage_summary as mileage on mileage.lrv_id = cycle.lrv_id
left join planning_settings as settings on settings.fleet = mileage.fleet;

create or replace view deployment_eligibility
with (security_invoker = true)
as
select
  mileage.lrv_id,
  mileage.status,
  mileage.rolling_daily_rate_km,
  mileage.latest_telemetry_at,
  min(cycle.km_to_next) as nearest_cycle_margin_km,
  coalesce(settings.deployment_safety_margin_km, 250) as safety_margin_km,
  min(cycle.km_to_next) - coalesce(settings.deployment_safety_margin_km, 250) as available_duty_margin_km,
  not exists (
    select 1
    from maintenance_bookings as booking
    where booking.lrv_id = mileage.lrv_id
      and booking.status in ('proposed', 'confirmed')
      and booking.start_at < now() + interval '12 hours'
      and booking.end_at > now()
  ) as free_of_booking,
  (
    mileage.status in ('idle', 'in_service')
    and min(cycle.km_to_next) > coalesce(settings.deployment_safety_margin_km, 250)
    and not exists (
      select 1
      from maintenance_bookings as booking
      where booking.lrv_id = mileage.lrv_id
        and booking.status in ('proposed', 'confirmed')
        and booking.start_at < now() + interval '12 hours'
        and booking.end_at > now()
    )
  ) as eligible
from vehicle_mileage_summary as mileage
join cycle_state as cycle on cycle.lrv_id = mileage.lrv_id
left join planning_settings as settings on settings.fleet = mileage.fleet
group by mileage.lrv_id, mileage.status, mileage.rolling_daily_rate_km,
  mileage.latest_telemetry_at, settings.deployment_safety_margin_km;

create or replace function schedule_maintenance(
  p_lrv_id text,
  p_primary_cycle integer,
  p_bundled_cycles integer[],
  p_bay_id text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_status text default 'confirmed',
  p_notes text default null,
  p_booking_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_id uuid;
  v_fleet text;
  v_bay depot_bays%rowtype;
  v_rule maintenance_cycle_rules%rowtype;
  v_settings planning_settings%rowtype;
  v_serviceable integer;
  v_local_start timestamp;
  v_local_end timestamp;
begin
  if p_status not in ('proposed', 'confirmed', 'completed', 'cancelled') then
    raise exception 'Unsupported booking status';
  end if;
  if p_end_at <= p_start_at then
    raise exception 'Booking end must be after start';
  end if;

  select fleet into v_fleet from vehicles where lrv_id = p_lrv_id;
  if v_fleet is null then raise exception 'Unknown vehicle %', p_lrv_id; end if;

  select * into v_bay from depot_bays where bay_id = p_bay_id and active;
  if not found then raise exception 'Bay % is unavailable', p_bay_id; end if;

  select * into v_rule from maintenance_cycle_rules
  where fleet = v_fleet and cycle_type = p_primary_cycle;
  if not found then raise exception 'No maintenance rule for cycle %', p_primary_cycle; end if;
  if v_rule.compatible_bay_type = 'heavy'
     and v_bay.bay_type not in ('heavy', 'universal') then
    raise exception 'Bay % is incompatible with the % km cycle', p_bay_id, p_primary_cycle;
  end if;

  select * into v_settings from planning_settings where fleet = v_fleet;
  v_local_start := p_start_at at time zone coalesce(v_settings.operating_timezone, 'Asia/Singapore');
  v_local_end := p_end_at at time zone coalesce(v_settings.operating_timezone, 'Asia/Singapore');
  if v_local_start::date <> v_local_end::date
     or v_local_start::time < v_bay.opens_at
     or v_local_end::time > v_bay.closes_at then
    raise exception 'Booking falls outside bay operating hours';
  end if;

  if exists (
    select 1 from maintenance_bookings
    where bay_id = p_bay_id
      and status in ('proposed', 'confirmed')
      and id is distinct from p_booking_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'Bay % already has a booking in this period', p_bay_id;
  end if;

  if p_status = 'confirmed' then
    select count(*) into v_serviceable
    from vehicles where fleet = v_fleet and status = 'in_service';
    if v_serviceable - (case when (select status from vehicles where lrv_id = p_lrv_id) = 'in_service' then 1 else 0 end)
       < coalesce(v_settings.minimum_service_vehicles, 0) then
      raise exception 'Booking would reduce the operating fleet below its service minimum';
    end if;
  end if;

  if p_booking_id is null then
    insert into maintenance_bookings (
      lrv_id, primary_cycle, bundled_cycles, bay_id, start_at, end_at, status, notes
    ) values (
      p_lrv_id, p_primary_cycle, coalesce(p_bundled_cycles, '{}'), p_bay_id,
      p_start_at, p_end_at, p_status, p_notes
    ) returning id into v_booking_id;
  else
    update maintenance_bookings
    set lrv_id = p_lrv_id,
        primary_cycle = p_primary_cycle,
        bundled_cycles = coalesce(p_bundled_cycles, '{}'),
        bay_id = p_bay_id,
        start_at = p_start_at,
        end_at = p_end_at,
        status = p_status,
        notes = p_notes,
        updated_at = now()
    where id = p_booking_id
    returning id into v_booking_id;
    if v_booking_id is null then raise exception 'Booking not found'; end if;
  end if;
  return v_booking_id;
end;
$$;

create or replace function complete_maintenance(
  p_lrv_id text,
  p_primary_cycle integer,
  p_completion_mileage_km numeric,
  p_technician_id text,
  p_booking_id uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_reset_cycles integer[];
  v_device_odo numeric;
begin
  if p_primary_cycle not in (2000, 13000, 40000, 120000, 360000) then
    raise exception 'Unsupported maintenance cycle';
  end if;
  if not exists (select 1 from vehicles where lrv_id = p_lrv_id) then
    raise exception 'Unknown vehicle %', p_lrv_id;
  end if;

  select array_agg(cycle_type order by cycle_type)
  into v_reset_cycles
  from cycle_state
  where lrv_id = p_lrv_id and cycle_type <= p_primary_cycle;

  select odo_km into v_device_odo
  from segment_traversals
  where lrv_id = p_lrv_id
  order by ts desc, id desc
  limit 1;

  insert into maintenance_events (
    booking_id, lrv_id, completion_mileage_km, primary_cycle, reset_cycles,
    technician_id, source, completed_at, notes
  ) values (
    p_booking_id, p_lrv_id, p_completion_mileage_km, p_primary_cycle,
    v_reset_cycles, p_technician_id, 'dashboard', now(), p_notes
  ) returning id into v_event_id;

  insert into mileage_anchors (
    lrv_id, ts, technician_id, source, value_km, override, override_reason,
    gnss_odo_km, divergence_km
  ) values (
    p_lrv_id, now(), p_technician_id, 'maintenance_completion',
    p_completion_mileage_km, false, null, v_device_odo,
    p_completion_mileage_km - v_device_odo
  );

  update cycle_state
  set km_since = 0,
      km_to_next = cycle_type,
      due_date = null
  where lrv_id = p_lrv_id and cycle_type = any(v_reset_cycles);

  if p_booking_id is not null then
    update maintenance_bookings
    set status = 'completed', updated_at = now()
    where id = p_booking_id and lrv_id = p_lrv_id;
  end if;

  update vehicles set status = 'idle' where lrv_id = p_lrv_id;
  return v_event_id;
end;
$$;

create or replace function confirm_stock_change(
  p_stock_change_id uuid,
  p_decided_by text default 'OCC_DEMO'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change stock_changes%rowtype;
  v_assignment duty_assignments%rowtype;
  v_new_assignment_id uuid;
  v_available_margin numeric;
  v_free_of_booking boolean;
begin
  select * into v_change from stock_changes where id = p_stock_change_id for update;
  if not found then raise exception 'Stock-change proposal not found'; end if;
  if v_change.decision_status <> 'proposed' then
    raise exception 'Stock-change proposal has already been decided';
  end if;

  select * into v_assignment from duty_assignments
  where id = v_change.withdrawn_assignment_id for update;
  if not found or v_assignment.status not in ('planned', 'active') then
    raise exception 'Original duty is no longer replaceable';
  end if;

  select available_duty_margin_km, free_of_booking
  into v_available_margin, v_free_of_booking
  from deployment_eligibility
  where lrv_id = v_change.replacement_lrv_id and eligible;
  if not found or not v_free_of_booking or v_available_margin < v_change.projected_duty_km then
    raise exception 'Replacement vehicle is not eligible for the projected duty';
  end if;

  if exists (
    select 1 from duty_assignments
    where lrv_id = v_change.replacement_lrv_id
      and status in ('planned', 'active')
      and tstzrange(duty_start, duty_end, '[)') &&
          tstzrange(v_assignment.duty_start, v_assignment.duty_end, '[)')
  ) then
    raise exception 'Replacement vehicle already has an overlapping duty';
  end if;

  update duty_assignments set status = 'withdrawn' where id = v_assignment.id;
  insert into duty_assignments (
    lrv_id, loop_id, slot_label, duty_start, duty_end, status
  ) values (
    v_change.replacement_lrv_id, v_assignment.loop_id, v_assignment.slot_label,
    greatest(now(), v_assignment.duty_start), v_assignment.duty_end, 'active'
  ) returning id into v_new_assignment_id;

  update vehicles set status = 'faulty' where lrv_id = v_change.withdrawn_lrv_id;
  update vehicles set status = 'in_service' where lrv_id = v_change.replacement_lrv_id;
  update stock_changes
  set replacement_assignment_id = v_new_assignment_id,
      decision_status = 'confirmed',
      decided_by = p_decided_by,
      decided_at = now()
  where id = p_stock_change_id;
  return v_new_assignment_id;
end;
$$;

create or replace function select_stock_replacement(
  p_stock_change_id uuid,
  p_replacement_lrv_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from stock_changes
    where id = p_stock_change_id
      and decision_status = 'proposed'
      and withdrawn_lrv_id <> p_replacement_lrv_id
  ) then
    raise exception 'Stock-change proposal cannot be edited';
  end if;
  if not exists (
    select 1 from deployment_eligibility
    where lrv_id = p_replacement_lrv_id and eligible
  ) then
    raise exception 'Selected replacement is not currently eligible';
  end if;
  update stock_changes
  set replacement_lrv_id = p_replacement_lrv_id
  where id = p_stock_change_id;
end;
$$;

alter table vehicles enable row level security;
alter table segment_traversals enable row level security;
alter table mileage_anchors enable row level security;
alter table cycle_state enable row level security;
alter table maintenance_cycle_rules enable row level security;
alter table depot_bays enable row level security;
alter table maintenance_bookings enable row level security;
alter table maintenance_events enable row level security;
alter table duty_assignments enable row level security;
alter table stock_changes enable row level security;
alter table planning_settings enable row level security;

drop policy if exists "demo read vehicles" on vehicles;
create policy "demo read vehicles" on vehicles for select to anon, authenticated using (true);
drop policy if exists "demo read traversals" on segment_traversals;
create policy "demo read traversals" on segment_traversals for select to anon, authenticated using (true);
drop policy if exists "demo read anchors" on mileage_anchors;
create policy "demo read anchors" on mileage_anchors for select to anon, authenticated using (true);
drop policy if exists "demo insert anchors" on mileage_anchors;
create policy "demo insert anchors" on mileage_anchors for insert to anon, authenticated with check (true);
drop policy if exists "demo read cycles" on cycle_state;
create policy "demo read cycles" on cycle_state for select to anon, authenticated using (true);

drop policy if exists "demo read cycle rules" on maintenance_cycle_rules;
create policy "demo read cycle rules" on maintenance_cycle_rules for select to anon, authenticated using (true);
drop policy if exists "demo update cycle rules" on maintenance_cycle_rules;
create policy "demo update cycle rules" on maintenance_cycle_rules for update to anon, authenticated using (true) with check (true);
drop policy if exists "demo read bays" on depot_bays;
create policy "demo read bays" on depot_bays for select to anon, authenticated using (true);
drop policy if exists "demo mutate bays" on depot_bays;
create policy "demo mutate bays" on depot_bays for all to anon, authenticated using (true) with check (true);
drop policy if exists "demo read bookings" on maintenance_bookings;
create policy "demo read bookings" on maintenance_bookings for select to anon, authenticated using (true);
drop policy if exists "demo read maintenance events" on maintenance_events;
create policy "demo read maintenance events" on maintenance_events for select to anon, authenticated using (true);
drop policy if exists "demo read duties" on duty_assignments;
create policy "demo read duties" on duty_assignments for select to anon, authenticated using (true);
drop policy if exists "demo read stock changes" on stock_changes;
create policy "demo read stock changes" on stock_changes for select to anon, authenticated using (true);
drop policy if exists "demo create stock changes" on stock_changes;
create policy "demo create stock changes" on stock_changes for insert to anon, authenticated with check (decision_status = 'proposed');
drop policy if exists "demo read settings" on planning_settings;
create policy "demo read settings" on planning_settings for select to anon, authenticated using (true);
drop policy if exists "demo update settings" on planning_settings;
create policy "demo update settings" on planning_settings for update to anon, authenticated using (true) with check (true);

grant select on latest_vehicle_telemetry, rolling_vehicle_daily_rate,
  vehicle_mileage_summary, cycle_forecasts, deployment_eligibility to anon, authenticated;
grant select on vehicles, segment_traversals, mileage_anchors, cycle_state,
  maintenance_cycle_rules, depot_bays, maintenance_bookings,
  maintenance_events, duty_assignments, stock_changes, planning_settings
  to anon, authenticated;
grant insert on mileage_anchors to anon, authenticated;
grant usage, select on sequence mileage_anchors_id_seq to anon, authenticated;
grant insert on stock_changes to anon, authenticated;
grant update on planning_settings, maintenance_cycle_rules to anon, authenticated;
grant insert, update on depot_bays to anon, authenticated;
grant execute on function schedule_maintenance(text, integer, integer[], text, timestamptz, timestamptz, text, text, uuid) to anon, authenticated;
grant execute on function complete_maintenance(text, integer, numeric, text, uuid, text) to anon, authenticated;
grant execute on function confirm_stock_change(uuid, text) to anon, authenticated;
grant execute on function select_stock_replacement(uuid, text) to anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'cycle_state', 'vehicles', 'maintenance_bookings', 'maintenance_events',
    'duty_assignments', 'stock_changes', 'planning_settings'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table %I', v_table);
    end if;
  end loop;
end $$;

commit;

-- Systems audit hardening for synthetic, simulated-live and real MQTT data.
-- Apply after 202609150001_dashboard_operations_v2.sql. Safe to rerun.

begin;
set local timezone to 'Asia/Singapore';

-- LTA-confirmed standard package scope and continuous depot/bay occupancy.
-- Durations are elapsed time, including weekends and waiting time.
alter table maintenance_cycle_rules add column if not exists included_cycles integer[];
update maintenance_cycle_rules
set included_cycles = case cycle_type
  when 2000 then array[2000]
  when 13000 then array[2000,13000]
  when 40000 then array[2000,13000,40000]
  when 120000 then array[2000,13000,40000,120000]
  when 360000 then array[2000,13000,40000,120000,360000]
end
where included_cycles is null;
alter table maintenance_cycle_rules alter column included_cycles set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'maintenance_cycle_rules_included_cycles'
      and conrelid = 'maintenance_cycle_rules'::regclass
  ) then
    alter table maintenance_cycle_rules add constraint maintenance_cycle_rules_included_cycles check (
      cardinality(included_cycles) > 0
      and included_cycles <@ array[2000,13000,40000,120000,360000]
      and included_cycles @> array[cycle_type]
    ) not valid;
  end if;
end $$;

alter table maintenance_bookings drop constraint if exists maintenance_bookings_status_check;
alter table maintenance_bookings add constraint maintenance_bookings_status_check
  check (status in ('proposed', 'confirmed', 'completed', 'partially_completed', 'cancelled'));

-- Protect all new writes even when an older database contains rows that have
-- not yet been cleaned up. NOT VALID avoids blocking the upgrade on legacy
-- data; Supabase still enforces each constraint for every new/changed row.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vehicles_operational_values' and conrelid = 'vehicles'::regclass) then
    alter table vehicles add constraint vehicles_operational_values check (
      lrv_id ~ '^[A-Z][A-Z0-9_-]{0,31}$'
      and fleet is not null and btrim(fleet) <> ''
      and type is not null and btrim(type) <> ''
      and status is not null and status in ('in_service', 'maintenance', 'idle', 'faulty')
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'segment_traversals_valid_values' and conrelid = 'segment_traversals'::regclass) then
    alter table segment_traversals add constraint segment_traversals_valid_values check (
      seq between 1 and 4294967295
      and length_m > 0 and length_m <= 20000 and length_m::text <> 'NaN'
      and odo_km is not null and odo_km >= 0 and odo_km::text <> 'NaN'
      and (confidence is null or (confidence between 0 and 1 and confidence::text <> 'NaN'))
      and (hdop is null or (hdop between 0 and 99.9 and hdop::text <> 'NaN'))
      and dir is not null and dir in ('N', 'S', 'E', 'W')
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mileage_anchors_valid_values' and conrelid = 'mileage_anchors'::regclass) then
    alter table mileage_anchors add constraint mileage_anchors_valid_values check (
      value_km is not null and value_km >= 0 and value_km::text <> 'NaN'
      and (gnss_odo_km is null or (gnss_odo_km >= 0 and gnss_odo_km::text <> 'NaN'))
      and (divergence_km is null or (
        gnss_odo_km is not null
        and divergence_km::text <> 'NaN'
        and abs(divergence_km - (value_km - gnss_odo_km)) <= 0.01
      ))
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cycle_state_valid_values' and conrelid = 'cycle_state'::regclass) then
    alter table cycle_state add constraint cycle_state_valid_values check (
      cycle_type in (2000, 13000, 40000, 120000, 360000)
      and km_since is not null and km_since >= 0 and km_since::text <> 'NaN'
      and km_to_next is not null and km_to_next::text <> 'NaN'
      and abs((km_since + km_to_next) - cycle_type) <= 0.01
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'maintenance_events_one_per_booking' and conrelid = 'maintenance_events'::regclass) then
    alter table maintenance_events add constraint maintenance_events_one_per_booking unique (booking_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'maintenance_bookings_no_vehicle_overlap' and conrelid = 'maintenance_bookings'::regclass) then
    alter table maintenance_bookings add constraint maintenance_bookings_no_vehicle_overlap
      exclude using gist (
        lrv_id with =,
        tstzrange(start_at, end_at, '[)') with &&
      ) where (status in ('proposed', 'confirmed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'duty_assignments_no_vehicle_overlap' and conrelid = 'duty_assignments'::regclass) then
    alter table duty_assignments add constraint duty_assignments_no_vehicle_overlap
      exclude using gist (
        lrv_id with =,
        tstzrange(duty_start, duty_end, '[)') with &&
      ) where (status in ('planned', 'active'));
  end if;
end
$$;

create or replace function increment_cycle_state_from_traversal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.length_m is null or new.length_m::text = 'NaN' or new.length_m <= 0 then
    raise exception 'Traversal distance must be a positive finite value';
  end if;
  update cycle_state
  set km_since = coalesce(km_since, 0) + new.length_m / 1000,
      km_to_next = coalesce(km_to_next, cycle_type) - new.length_m / 1000
  where lrv_id = new.lrv_id;
  return new;
end;
$$;

create or replace function validate_traversal_ordering()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_odo numeric;
  v_next_odo numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('traversal:' || new.lrv_id, 0));
  select odo_km into v_previous_odo from segment_traversals
  where lrv_id = new.lrv_id and seq < new.seq
    and (tg_op = 'INSERT' or id <> new.id)
  order by seq desc limit 1;
  select odo_km into v_next_odo from segment_traversals
  where lrv_id = new.lrv_id and seq > new.seq
    and (tg_op = 'INSERT' or id <> new.id)
  order by seq limit 1;
  if v_previous_odo is not null and new.odo_km < v_previous_odo then
    raise exception 'Traversal odometer regresses below sequence %', new.seq;
  end if;
  if v_next_odo is not null and new.odo_km > v_next_odo then
    raise exception 'Traversal odometer exceeds the next known sequence';
  end if;
  return new;
end;
$$;

drop trigger if exists segment_traversal_validate_ordering on segment_traversals;
create trigger segment_traversal_validate_ordering
before insert or update of lrv_id, seq, odo_km on segment_traversals
for each row execute function validate_traversal_ordering();

create or replace view latest_vehicle_telemetry
with (security_invoker = true)
as
select
  vehicle.lrv_id, vehicle.fleet, vehicle.type, vehicle.status,
  latest.seq, latest.seg_id, latest.ts as latest_telemetry_at,
  latest.length_m, latest.dir, latest.odo_km as device_odo_km,
  latest.confidence, latest.hdop,
  extract(epoch from (now() - latest.ts)) / 3600 as telemetry_age_hours
from vehicles as vehicle
left join lateral (
  select traversal.*
  from segment_traversals as traversal
  where traversal.lrv_id = vehicle.lrv_id
    and traversal.ts <= now() + interval '10 minutes'
  order by traversal.ts desc, traversal.id desc
  limit 1
) as latest on true;

create or replace view vehicle_mileage_summary
with (security_invoker = true)
as
select
  vehicle.lrv_id, vehicle.fleet, vehicle.type, vehicle.status,
  latest.seg_id, latest.latest_telemetry_at, latest.telemetry_age_hours,
  latest.device_odo_km, latest.hdop,
  anchor.id as anchor_id, anchor.ts as last_physical_check_at,
  anchor.value_km as last_physical_check_km, anchor.divergence_km,
  case
    when anchor.id is not null then anchor.value_km + coalesce(post_anchor.distance_km, 0)
    else latest.device_odo_km
  end as lifetime_planning_mileage_km,
  coalesce(today.distance_km, 0) as mileage_today_km,
  rate.rolling_daily_rate_km, rate.observed_days
from vehicles as vehicle
left join latest_vehicle_telemetry as latest on latest.lrv_id = vehicle.lrv_id
left join lateral (
  select candidate.*
  from mileage_anchors as candidate
  where candidate.lrv_id = vehicle.lrv_id and candidate.superseded_by is null
  order by candidate.ts desc nulls last, candidate.id desc
  limit 1
) as anchor on true
left join lateral (
  select sum(traversal.length_m) / 1000 as distance_km
  from segment_traversals as traversal
  where traversal.lrv_id = vehicle.lrv_id
    and anchor.ts is not null and traversal.ts > anchor.ts
    and traversal.ts <= now() + interval '10 minutes'
) as post_anchor on true
left join lateral (
  select sum(traversal.length_m) / 1000 as distance_km
  from segment_traversals as traversal
  where traversal.lrv_id = vehicle.lrv_id
    and traversal.ts <= now() + interval '10 minutes'
    and (traversal.ts at time zone 'Asia/Singapore')::date =
        (now() at time zone 'Asia/Singapore')::date
) as today on true
left join rolling_vehicle_daily_rate as rate on rate.lrv_id = vehicle.lrv_id;

create or replace view cycle_forecasts
with (security_invoker = true)
as
with fleet_daily_rate as (
  select
    vehicle.fleet,
    round(avg(rate.rolling_daily_rate_km), 2) as rolling_daily_rate_km
  from vehicles as vehicle
  join rolling_vehicle_daily_rate as rate on rate.lrv_id = vehicle.lrv_id
  where vehicle.status = 'in_service'
    and rate.rolling_daily_rate_km > 0
  group by vehicle.fleet
)
select
  cycle.lrv_id, cycle.cycle_type, cycle.km_since, cycle.km_to_next,
  cycle.due_date as seeded_due_date, fleet_rate.rolling_daily_rate_km,
  case
    when cycle.km_to_next <= 0 then
      coalesce(least(cycle.due_date, (now() at time zone 'Asia/Singapore')::date),
               (now() at time zone 'Asia/Singapore')::date)
      - (now() at time zone 'Asia/Singapore')::date
    when mileage.latest_telemetry_at is null then null
    when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then null
    when coalesce(fleet_rate.rolling_daily_rate_km, 0) <= 0 then null
    else ceil(cycle.km_to_next / fleet_rate.rolling_daily_rate_km)::integer
  end as forecast_days,
  case
    when cycle.km_to_next <= 0 then
      coalesce(least(cycle.due_date, (now() at time zone 'Asia/Singapore')::date),
               (now() at time zone 'Asia/Singapore')::date)
    when mileage.latest_telemetry_at is null then null
    when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then null
    when coalesce(fleet_rate.rolling_daily_rate_km, 0) <= 0 then null
    else (now() at time zone 'Asia/Singapore')::date
         + ceil(cycle.km_to_next / fleet_rate.rolling_daily_rate_km)::integer
  end as forecast_date,
  (
    case when cycle.km_to_next <= 0 then 1000 else 0 end
    + case when mileage.status = 'faulty' then 700 when mileage.status = 'maintenance' then 350 else 0 end
    + case when mileage.latest_telemetry_at is null then 250
           when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then 200 else 0 end
    + greatest(0, 200 - coalesce(ceil(cycle.km_to_next / nullif(fleet_rate.rolling_daily_rate_km, 0)), 200))
    + case when abs(coalesce(mileage.divergence_km, 0)) >= 50 then 300 else 0 end
  )::numeric as priority_score
from cycle_state as cycle
join vehicle_mileage_summary as mileage on mileage.lrv_id = cycle.lrv_id
left join fleet_daily_rate as fleet_rate on fleet_rate.fleet = mileage.fleet
left join planning_settings as settings on settings.fleet = mileage.fleet;

create or replace view deployment_eligibility
with (security_invoker = true)
as
select
  mileage.lrv_id, mileage.status, mileage.rolling_daily_rate_km,
  mileage.latest_telemetry_at,
  min(cycle.km_to_next) as nearest_cycle_margin_km,
  coalesce(settings.deployment_safety_margin_km, 250) as safety_margin_km,
  min(cycle.km_to_next) - coalesce(settings.deployment_safety_margin_km, 250) as available_duty_margin_km,
  not exists (
    select 1 from maintenance_bookings as booking
    where booking.lrv_id = mileage.lrv_id
      and booking.status in ('proposed', 'confirmed')
      and booking.start_at < now() + interval '12 hours' and booking.end_at > now()
  ) as free_of_booking,
  (
    mileage.status in ('idle', 'in_service')
    and min(cycle.km_to_next) > coalesce(settings.deployment_safety_margin_km, 250)
    and not exists (
      select 1 from maintenance_bookings as booking
      where booking.lrv_id = mileage.lrv_id and booking.status in ('proposed', 'confirmed')
        and booking.start_at < now() + interval '12 hours' and booking.end_at > now()
    )
    and not exists (
      select 1 from duty_assignments as duty
      where duty.lrv_id = mileage.lrv_id and duty.status in ('planned', 'active')
        and duty.duty_start < now() + interval '12 hours' and duty.duty_end > now()
    )
  ) as eligible,
  not exists (
    select 1 from duty_assignments as duty
    where duty.lrv_id = mileage.lrv_id and duty.status in ('planned', 'active')
      and duty.duty_start < now() + interval '12 hours' and duty.duty_end > now()
  ) as free_of_duty
from vehicle_mileage_summary as mileage
join cycle_state as cycle on cycle.lrv_id = mileage.lrv_id
left join planning_settings as settings on settings.fleet = mileage.fleet
group by mileage.lrv_id, mileage.status, mileage.rolling_daily_rate_km,
  mileage.latest_telemetry_at, settings.deployment_safety_margin_km;

create or replace function schedule_maintenance(
  p_lrv_id text, p_primary_cycle integer, p_bundled_cycles integer[],
  p_bay_id text, p_start_at timestamptz, p_end_at timestamptz,
  p_status text default 'confirmed', p_notes text default null,
  p_booking_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_booking_id uuid; v_fleet text; v_vehicle_status text;
  v_bay depot_bays%rowtype; v_rule maintenance_cycle_rules%rowtype;
  v_settings planning_settings%rowtype; v_existing maintenance_bookings%rowtype;
  v_serviceable integer; v_concurrent integer; v_local_start timestamp; v_local_end timestamp;
  v_expected_cycles integer[]; v_requested_cycles integer[];
begin
  if p_status not in ('proposed', 'confirmed') then raise exception 'Bookings may only be proposed or confirmed'; end if;
  if p_end_at <= p_start_at then raise exception 'Booking end must be after start'; end if;

  select fleet, status into v_fleet, v_vehicle_status from vehicles where lrv_id = p_lrv_id for update;
  if not found then raise exception 'Unknown vehicle %', p_lrv_id; end if;
  perform pg_advisory_xact_lock(hashtextextended('maintenance:' || v_fleet, 0));

  select * into v_bay from depot_bays where bay_id = p_bay_id and active for update;
  if not found or v_bay.fleet <> v_fleet then raise exception 'Bay % is unavailable for fleet %', p_bay_id, v_fleet; end if;
  select * into v_rule from maintenance_cycle_rules where fleet = v_fleet and cycle_type = p_primary_cycle;
  if not found then raise exception 'No maintenance rule for cycle %', p_primary_cycle; end if;
  if v_rule.compatible_bay_type = 'heavy' and v_bay.bay_type not in ('heavy', 'universal') then
    raise exception 'Bay % is incompatible with the % km cycle', p_bay_id, p_primary_cycle;
  elsif v_rule.compatible_bay_type <> 'heavy' and v_bay.bay_type not in ('routine', 'universal', 'heavy') then
    raise exception 'Bay % is incompatible with the % km cycle', p_bay_id, p_primary_cycle;
  end if;
  if p_end_at - p_start_at < make_interval(mins => v_rule.duration_minutes) then
    raise exception 'Booking is shorter than the configured % minute duration', v_rule.duration_minutes;
  end if;

  select array_agg(distinct cycle order by cycle) into v_expected_cycles
  from unnest(v_rule.included_cycles) as standard(cycle);
  select array_agg(distinct cycle order by cycle) into v_requested_cycles
  from unnest(coalesce(p_bundled_cycles, '{}'::integer[])) as requested(cycle);
  if v_requested_cycles is distinct from v_expected_cycles then
    raise exception 'Bundled cycles must include the complete nested set %', v_expected_cycles;
  end if;

  select * into v_settings from planning_settings where fleet = v_fleet;
  v_local_start := p_start_at at time zone coalesce(v_settings.operating_timezone, 'Asia/Singapore');
  v_local_end := p_end_at at time zone coalesce(v_settings.operating_timezone, 'Asia/Singapore');
  if v_local_start::time < v_bay.opens_at or v_local_start::time > v_bay.closes_at
     or v_local_end::time < v_bay.opens_at or v_local_end::time > v_bay.closes_at then
    raise exception 'Booking must start and finish within bay operating hours';
  end if;

  if p_booking_id is not null then
    select * into v_existing from maintenance_bookings where id = p_booking_id for update;
    if not found then raise exception 'Booking not found'; end if;
    if v_existing.status in ('completed', 'cancelled') then raise exception 'A completed or cancelled booking cannot be changed'; end if;
  end if;
  if exists (
    select 1 from maintenance_bookings where bay_id = p_bay_id and status in ('proposed', 'confirmed')
      and id is distinct from p_booking_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then raise exception 'Bay % already has a booking in this period', p_bay_id; end if;
  if exists (
    select 1 from maintenance_bookings where lrv_id = p_lrv_id and status in ('proposed', 'confirmed')
      and id is distinct from p_booking_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then raise exception 'Vehicle % already has a booking in this period', p_lrv_id; end if;

  if p_status = 'confirmed' and exists (
    select 1 from duty_assignments
    where lrv_id = p_lrv_id and status in ('planned', 'active')
      and tstzrange(duty_start, duty_end, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then raise exception 'Vehicle % has an operating duty in this period', p_lrv_id; end if;

  if p_status = 'confirmed' then
    select count(*) into v_serviceable from vehicles where fleet = v_fleet and status = 'in_service';
    select coalesce(max(concurrent_bookings), 0) into v_concurrent
    from (
      select count(distinct vehicle.lrv_id) as concurrent_bookings
      from (
        select p_start_at as boundary
        union
        select candidate.start_at
        from maintenance_bookings as candidate
        where candidate.status = 'confirmed'
          and candidate.id is distinct from p_booking_id
          and tstzrange(candidate.start_at, candidate.end_at, '[)')
              && tstzrange(p_start_at, p_end_at, '[)')
      ) as boundaries
      left join maintenance_bookings as booking
        on booking.status = 'confirmed'
       and booking.id is distinct from p_booking_id
       and booking.start_at <= boundaries.boundary
       and booking.end_at > boundaries.boundary
      left join vehicles as vehicle
        on vehicle.lrv_id = booking.lrv_id
       and vehicle.fleet = v_fleet
       and vehicle.status = 'in_service'
      group by boundaries.boundary
    ) as concurrency;
    if v_serviceable - v_concurrent - (case when v_vehicle_status = 'in_service' then 1 else 0 end)
       < coalesce(v_settings.minimum_service_vehicles, 0) then
      raise exception 'Booking would reduce the operating fleet below its service minimum';
    end if;
  end if;

  if p_booking_id is null then
    insert into maintenance_bookings (lrv_id, primary_cycle, bundled_cycles, bay_id, start_at, end_at, status, notes)
    values (p_lrv_id, p_primary_cycle, v_expected_cycles, p_bay_id, p_start_at, p_end_at, p_status, p_notes)
    returning id into v_booking_id;
  else
    update maintenance_bookings set lrv_id = p_lrv_id, primary_cycle = p_primary_cycle,
      bundled_cycles = v_expected_cycles, bay_id = p_bay_id, start_at = p_start_at,
      end_at = p_end_at, status = p_status, notes = p_notes, updated_at = now()
    where id = p_booking_id returning id into v_booking_id;
  end if;
  return v_booking_id;
end;
$$;

create or replace function cancel_maintenance_booking(p_booking_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public
as $$
begin
  update maintenance_bookings
  set status = 'cancelled', notes = concat_ws(E'\n', nullif(notes, ''), nullif(p_reason, '')), updated_at = now()
  where id = p_booking_id and status in ('proposed', 'confirmed');
  if not found then raise exception 'Booking is missing or can no longer be cancelled'; end if;
end;
$$;

drop function if exists complete_maintenance(text, integer, numeric, text, uuid, text);

create or replace function complete_maintenance(
  p_lrv_id text, p_primary_cycle integer, p_completion_mileage_km numeric,
  p_technician_id text, p_booking_id uuid default null, p_notes text default null,
  p_completed_cycles integer[] default null
)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_event_id uuid; v_expected_cycles integer[]; v_completed_cycles integer[]; v_device_odo numeric;
  v_last_anchor numeric; v_divergence numeric; v_booking maintenance_bookings%rowtype;
begin
  if p_primary_cycle not in (2000, 13000, 40000, 120000, 360000) then raise exception 'Unsupported maintenance cycle'; end if;
  if p_completion_mileage_km is null or p_completion_mileage_km::text = 'NaN' or p_completion_mileage_km < 0 then
    raise exception 'Completion mileage must be a finite non-negative value';
  end if;
  if nullif(btrim(p_technician_id), '') is null then raise exception 'Technician ID is required'; end if;
  perform 1 from vehicles where lrv_id = p_lrv_id for update;
  if not found then raise exception 'Unknown vehicle %', p_lrv_id; end if;

  if p_booking_id is not null then
    select * into v_booking from maintenance_bookings where id = p_booking_id for update;
    if not found or v_booking.lrv_id <> p_lrv_id or v_booking.primary_cycle <> p_primary_cycle then
      raise exception 'Booking does not match this vehicle and maintenance cycle';
    end if;
    if v_booking.status <> 'confirmed' then raise exception 'Only a confirmed booking can be completed'; end if;
    if now() < v_booking.start_at then raise exception 'A maintenance visit cannot be completed before it starts'; end if;
    v_expected_cycles := v_booking.bundled_cycles;
  else
    select included_cycles into v_expected_cycles
    from maintenance_cycle_rules as rule
    join vehicles as vehicle on vehicle.fleet = rule.fleet
    where vehicle.lrv_id = p_lrv_id and rule.cycle_type = p_primary_cycle;
  end if;

  select array_agg(distinct cycle order by cycle) into v_expected_cycles
  from unnest(v_expected_cycles) as planned(cycle);

  select array_agg(distinct cycle order by cycle) into v_completed_cycles
  from unnest(coalesce(p_completed_cycles, v_expected_cycles)) as completed(cycle);
  if v_completed_cycles is null or cardinality(v_completed_cycles) = 0 then
    raise exception 'At least one completed maintenance cycle is required';
  end if;
  if not (v_completed_cycles <@ v_expected_cycles) then
    raise exception 'Completed cycles % are outside the planned package %', v_completed_cycles, v_expected_cycles;
  end if;
  if v_completed_cycles is distinct from v_expected_cycles and nullif(btrim(p_notes), '') is null then
    raise exception 'A reason is required when the completed scope differs from the planned package';
  end if;

  select value_km into v_last_anchor from mileage_anchors
  where lrv_id = p_lrv_id and superseded_by is null order by ts desc nulls last, id desc limit 1;
  if v_last_anchor is not null and p_completion_mileage_km < v_last_anchor then
    raise exception 'Completion mileage cannot be below the latest accepted physical reading (%)', v_last_anchor;
  end if;
  perform 1 from cycle_state
  where lrv_id = p_lrv_id and cycle_type = any(v_completed_cycles) for update;
  if (select count(*) from cycle_state
      where lrv_id = p_lrv_id and cycle_type = any(v_completed_cycles)) <> cardinality(v_completed_cycles) then
    raise exception 'Vehicle cycle state is incomplete for completed scope %', v_completed_cycles;
  end if;
  select odo_km into v_device_odo from segment_traversals
  where lrv_id = p_lrv_id and ts <= now() + interval '10 minutes' order by ts desc, id desc limit 1;
  v_divergence := case when v_device_odo is null then null else p_completion_mileage_km - v_device_odo end;

  insert into maintenance_events (booking_id, lrv_id, completion_mileage_km, primary_cycle, reset_cycles,
    technician_id, source, completed_at, notes)
  values (p_booking_id, p_lrv_id, p_completion_mileage_km, p_primary_cycle, v_completed_cycles,
    btrim(p_technician_id), 'dashboard', now(), p_notes) returning id into v_event_id;
  insert into mileage_anchors (lrv_id, ts, technician_id, source, value_km, override, override_reason,
    gnss_odo_km, divergence_km)
  values (p_lrv_id, now(), btrim(p_technician_id), 'maintenance_completion', p_completion_mileage_km,
    abs(coalesce(v_divergence, 0)) >= 50,
    case when abs(coalesce(v_divergence, 0)) >= 50 then 'Physical/device divergence requires evidence review' end,
    v_device_odo, v_divergence);
  update cycle_state set km_since = 0, km_to_next = cycle_type, due_date = null
  where lrv_id = p_lrv_id and cycle_type = any(v_completed_cycles);
  if p_booking_id is not null then
    update maintenance_bookings
    set status = case when v_completed_cycles = v_expected_cycles then 'completed' else 'partially_completed' end,
        updated_at = now()
    where id = p_booking_id;
  end if;
  update vehicles set status = 'idle' where lrv_id = p_lrv_id;
  return v_event_id;
end;
$$;

create or replace function select_stock_replacement(p_stock_change_id uuid, p_replacement_lrv_id text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_change stock_changes%rowtype; v_assignment duty_assignments%rowtype;
  v_status text; v_margin numeric; v_safety numeric;
begin
  select * into v_change from stock_changes where id = p_stock_change_id for update;
  if not found or v_change.decision_status <> 'proposed' or v_change.withdrawn_lrv_id = p_replacement_lrv_id then
    raise exception 'Stock-change proposal cannot be edited';
  end if;
  select * into v_assignment from duty_assignments where id = v_change.withdrawn_assignment_id;
  if not found or v_assignment.status not in ('planned', 'active') or v_assignment.duty_end <= now() then
    raise exception 'Original duty is no longer replaceable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('stock:' || p_replacement_lrv_id, 0));
  select status into v_status from vehicles where lrv_id = p_replacement_lrv_id for update;
  if v_status not in ('idle', 'in_service') then raise exception 'Selected replacement is not serviceable'; end if;
  select min(cycle.km_to_next), coalesce(settings.deployment_safety_margin_km, 250)
  into v_margin, v_safety from cycle_state as cycle
  join vehicles as vehicle on vehicle.lrv_id = cycle.lrv_id
  left join planning_settings as settings on settings.fleet = vehicle.fleet
  where cycle.lrv_id = p_replacement_lrv_id group by settings.deployment_safety_margin_km;
  if v_margin - v_safety < v_change.projected_duty_km then raise exception 'Selected replacement has insufficient maintenance margin'; end if;
  if exists (select 1 from maintenance_bookings where lrv_id = p_replacement_lrv_id
      and status in ('proposed', 'confirmed') and tstzrange(start_at, end_at, '[)') && tstzrange(greatest(now(), v_assignment.duty_start), v_assignment.duty_end, '[)')) then
    raise exception 'Selected replacement has an overlapping depot booking';
  end if;
  if exists (select 1 from duty_assignments where lrv_id = p_replacement_lrv_id
      and status in ('planned', 'active') and tstzrange(duty_start, duty_end, '[)') && tstzrange(greatest(now(), v_assignment.duty_start), v_assignment.duty_end, '[)')) then
    raise exception 'Selected replacement already has an overlapping duty';
  end if;
  update stock_changes set replacement_lrv_id = p_replacement_lrv_id where id = p_stock_change_id;
end;
$$;

create or replace function confirm_stock_change(p_stock_change_id uuid, p_decided_by text default 'OCC_DEMO')
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_change stock_changes%rowtype; v_assignment duty_assignments%rowtype;
  v_new_assignment_id uuid; v_status text; v_margin numeric; v_safety numeric;
begin
  if nullif(btrim(p_decided_by), '') is null then raise exception 'Decision-maker ID is required'; end if;
  select * into v_change from stock_changes where id = p_stock_change_id for update;
  if not found then raise exception 'Stock-change proposal not found'; end if;
  if v_change.decision_status <> 'proposed' then raise exception 'Stock-change proposal has already been decided'; end if;
  select * into v_assignment from duty_assignments where id = v_change.withdrawn_assignment_id for update;
  if not found or v_assignment.lrv_id <> v_change.withdrawn_lrv_id or v_assignment.status not in ('planned', 'active') or v_assignment.duty_end <= now() then
    raise exception 'Original duty is no longer replaceable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('stock:' || v_change.replacement_lrv_id, 0));
  select status into v_status from vehicles where lrv_id = v_change.replacement_lrv_id for update;
  if v_status not in ('idle', 'in_service') then raise exception 'Replacement vehicle is not serviceable'; end if;
  select min(cycle.km_to_next), coalesce(settings.deployment_safety_margin_km, 250)
  into v_margin, v_safety from cycle_state as cycle
  join vehicles as vehicle on vehicle.lrv_id = cycle.lrv_id
  left join planning_settings as settings on settings.fleet = vehicle.fleet
  where cycle.lrv_id = v_change.replacement_lrv_id group by settings.deployment_safety_margin_km;
  if v_margin - v_safety < v_change.projected_duty_km then raise exception 'Replacement vehicle is not eligible for the projected duty'; end if;
  if exists (select 1 from maintenance_bookings where lrv_id = v_change.replacement_lrv_id
      and status in ('proposed', 'confirmed') and tstzrange(start_at, end_at, '[)') && tstzrange(greatest(now(), v_assignment.duty_start), v_assignment.duty_end, '[)')) then
    raise exception 'Replacement vehicle has an overlapping depot booking';
  end if;
  if exists (select 1 from duty_assignments where lrv_id = v_change.replacement_lrv_id
      and status in ('planned', 'active') and tstzrange(duty_start, duty_end, '[)') && tstzrange(greatest(now(), v_assignment.duty_start), v_assignment.duty_end, '[)')) then
    raise exception 'Replacement vehicle already has an overlapping duty';
  end if;
  update duty_assignments set status = 'withdrawn' where id = v_assignment.id;
  insert into duty_assignments (lrv_id, loop_id, slot_label, duty_start, duty_end, status)
  values (v_change.replacement_lrv_id, v_assignment.loop_id, v_assignment.slot_label,
    greatest(now(), v_assignment.duty_start), v_assignment.duty_end, 'active') returning id into v_new_assignment_id;
  update vehicles set status = 'faulty' where lrv_id = v_change.withdrawn_lrv_id;
  update vehicles set status = 'in_service' where lrv_id = v_change.replacement_lrv_id;
  update stock_changes set replacement_assignment_id = v_new_assignment_id, decision_status = 'confirmed',
    decided_by = btrim(p_decided_by), decided_at = now() where id = p_stock_change_id;
  return v_new_assignment_id;
end;
$$;

-- The prototype is intentionally unauthenticated, but direct table mutations
-- are limited to the settings that the UI actually edits. Operational writes
-- pass through the validating functions above.
drop policy if exists "demo insert anchors" on mileage_anchors;
drop policy if exists "demo mutate bays" on depot_bays;
drop policy if exists "demo update bays" on depot_bays;
create policy "demo update bays" on depot_bays for update to anon, authenticated using (true) with check (true);
drop policy if exists "demo create stock changes" on stock_changes;

revoke update on maintenance_cycle_rules from anon, authenticated;
grant update (tolerance_km, duration_minutes, compatible_bay_type, updated_at)
  on maintenance_cycle_rules to anon, authenticated;

revoke execute on function increment_cycle_state_from_traversal() from public;
revoke execute on function validate_traversal_ordering() from public;
revoke execute on function schedule_maintenance(text, integer, integer[], text, timestamptz, timestamptz, text, text, uuid) from public;
revoke execute on function complete_maintenance(text, integer, numeric, text, uuid, text, integer[]) from public;
revoke execute on function cancel_maintenance_booking(uuid, text) from public;
revoke execute on function confirm_stock_change(uuid, text) from public;
revoke execute on function select_stock_replacement(uuid, text) from public;
grant execute on function schedule_maintenance(text, integer, integer[], text, timestamptz, timestamptz, text, text, uuid) to anon, authenticated;
grant execute on function complete_maintenance(text, integer, numeric, text, uuid, text, integer[]) to anon, authenticated;
grant execute on function cancel_maintenance_booking(uuid, text) to anon, authenticated;
grant execute on function confirm_stock_change(uuid, text) to anon, authenticated;
grant execute on function select_stock_replacement(uuid, text) to anon, authenticated;

-- Corrective maintenance work model and fault scheduling.
create extension if not exists btree_gist;

create table if not exists maintenance_faults (
  id uuid primary key default gen_random_uuid(),
  demo_key text unique,
  lrv_id text not null references vehicles(lrv_id),
  fault_code text not null,
  description text not null,
  severity text not null default 'medium' check (severity in ('critical', 'high', 'medium', 'low')),
  reported_at timestamptz not null default now(),
  estimated_duration_minutes integer not null default 240 check (estimated_duration_minutes > 0),
  required_bay_type text not null default 'heavy' check (required_bay_type in ('routine', 'heavy', 'universal')),
  status text not null default 'open' check (status in ('open', 'scheduled', 'resolved', 'deferred')),
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table maintenance_bookings add column if not exists work_type text not null default 'preventive';
alter table maintenance_bookings add column if not exists fault_id uuid references maintenance_faults(id);
alter table maintenance_bookings alter column primary_cycle drop not null;
alter table maintenance_bookings drop constraint if exists maintenance_bookings_primary_cycle_check;
alter table maintenance_bookings drop constraint if exists maintenance_bookings_work_type_check;
alter table maintenance_bookings drop constraint if exists maintenance_bookings_work_scope_check;
alter table maintenance_bookings add constraint maintenance_bookings_work_type_check
  check (work_type in ('preventive', 'corrective'));
alter table maintenance_bookings add constraint maintenance_bookings_work_scope_check check (
  (work_type = 'preventive'
    and primary_cycle in (2000, 13000, 40000, 120000, 360000)
    and cardinality(bundled_cycles) > 0
    and fault_id is null)
  or
  (work_type = 'corrective'
    and primary_cycle is null
    and cardinality(bundled_cycles) = 0
    and fault_id is not null)
);

alter table maintenance_events add column if not exists work_type text not null default 'preventive';
alter table maintenance_events add column if not exists fault_id uuid references maintenance_faults(id);
alter table maintenance_events alter column primary_cycle drop not null;
alter table maintenance_events drop constraint if exists maintenance_events_primary_cycle_check;
alter table maintenance_events drop constraint if exists maintenance_events_work_type_check;
alter table maintenance_events drop constraint if exists maintenance_events_work_scope_check;
alter table maintenance_events add constraint maintenance_events_work_type_check
  check (work_type in ('preventive', 'corrective'));
alter table maintenance_events add constraint maintenance_events_work_scope_check check (
  (work_type = 'preventive'
    and primary_cycle in (2000, 13000, 40000, 120000, 360000)
    and cardinality(reset_cycles) > 0
    and fault_id is null)
  or
  (work_type = 'corrective'
    and primary_cycle is null
    and cardinality(reset_cycles) = 0
    and fault_id is not null)
);

create index if not exists maintenance_faults_vehicle_status_idx
  on maintenance_faults (lrv_id, status, reported_at desc);
create unique index if not exists maintenance_bookings_active_fault_idx
  on maintenance_bookings (fault_id)
  where fault_id is not null and status in ('proposed', 'confirmed');

alter table maintenance_bookings drop constraint if exists maintenance_bookings_no_bay_overlap;
alter table maintenance_bookings add constraint maintenance_bookings_no_bay_overlap
  exclude using gist (
    bay_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('proposed', 'confirmed'));

alter table maintenance_bookings drop constraint if exists maintenance_bookings_no_vehicle_overlap;
alter table maintenance_bookings add constraint maintenance_bookings_no_vehicle_overlap
  exclude using gist (
    lrv_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('proposed', 'confirmed'));

drop function if exists schedule_maintenance(text, integer, integer[], text, timestamptz, timestamptz, text, text, uuid);
drop function if exists schedule_maintenance(text, integer, integer[], text, timestamptz, timestamptz, text, text, uuid, text, uuid);

create function schedule_maintenance(
  p_lrv_id text, p_primary_cycle integer, p_bundled_cycles integer[],
  p_bay_id text, p_start_at timestamptz, p_end_at timestamptz,
  p_status text default 'confirmed', p_notes text default null,
  p_booking_id uuid default null, p_work_type text default 'preventive',
  p_fault_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_booking_id uuid; v_fleet text; v_vehicle_status text;
  v_bay depot_bays%rowtype; v_rule maintenance_cycle_rules%rowtype;
  v_fault maintenance_faults%rowtype; v_settings planning_settings%rowtype;
  v_existing maintenance_bookings%rowtype; v_serviceable integer; v_concurrent integer;
  v_local_start timestamp; v_local_end timestamp;
  v_expected_cycles integer[] := '{}'::integer[]; v_requested_cycles integer[] := '{}'::integer[];
begin
  if p_status not in ('proposed', 'confirmed') then raise exception 'Bookings may only be proposed or confirmed'; end if;
  if p_work_type not in ('preventive', 'corrective') then raise exception 'Unsupported maintenance work type'; end if;
  if p_end_at <= p_start_at then raise exception 'Booking end must be after start'; end if;

  select fleet, status into v_fleet, v_vehicle_status from vehicles where lrv_id = p_lrv_id for update;
  if not found then raise exception 'Unknown vehicle %', p_lrv_id; end if;
  perform pg_advisory_xact_lock(hashtextextended('maintenance:' || v_fleet, 0));

  select * into v_bay from depot_bays where bay_id = p_bay_id and active for update;
  if not found or v_bay.fleet <> v_fleet then raise exception 'Bay % is unavailable for fleet %', p_bay_id, v_fleet; end if;

  if p_work_type = 'preventive' then
    if p_fault_id is not null then raise exception 'Preventive work cannot reference a fault'; end if;
    select * into v_rule from maintenance_cycle_rules where fleet = v_fleet and cycle_type = p_primary_cycle;
    if not found then raise exception 'No maintenance rule for cycle %', p_primary_cycle; end if;
    if v_rule.compatible_bay_type = 'heavy' and v_bay.bay_type not in ('heavy', 'universal') then
      raise exception 'Bay % is incompatible with the % km cycle', p_bay_id, p_primary_cycle;
    elsif v_rule.compatible_bay_type <> 'heavy' and v_bay.bay_type not in ('routine', 'universal', 'heavy') then
      raise exception 'Bay % is incompatible with the % km cycle', p_bay_id, p_primary_cycle;
    end if;
    if p_end_at - p_start_at < make_interval(mins => v_rule.duration_minutes) then
      raise exception 'Booking is shorter than the configured % minute duration', v_rule.duration_minutes;
    end if;
    select array_agg(distinct cycle order by cycle) into v_expected_cycles
    from unnest(v_rule.included_cycles) as standard(cycle);
    select array_agg(distinct cycle order by cycle) into v_requested_cycles
    from unnest(coalesce(p_bundled_cycles, '{}'::integer[])) as requested(cycle);
    if v_requested_cycles is distinct from v_expected_cycles then
      raise exception 'Bundled cycles must include the complete nested set %', v_expected_cycles;
    end if;
  else
    if p_primary_cycle is not null or cardinality(coalesce(p_bundled_cycles, '{}'::integer[])) <> 0 then
      raise exception 'Corrective work must not reset a mileage cycle';
    end if;
    select * into v_fault from maintenance_faults where id = p_fault_id for update;
    if not found or v_fault.lrv_id <> p_lrv_id or v_fault.status not in ('open', 'scheduled') then
      raise exception 'An open fault for vehicle % is required', p_lrv_id;
    end if;
    if v_fault.required_bay_type = 'heavy' and v_bay.bay_type not in ('heavy', 'universal') then
      raise exception 'Bay % cannot perform the required heavy corrective work', p_bay_id;
    elsif v_fault.required_bay_type = 'routine' and v_bay.bay_type not in ('routine', 'heavy', 'universal') then
      raise exception 'Bay % is incompatible with this corrective repair', p_bay_id;
    end if;
    if p_end_at - p_start_at < make_interval(mins => v_fault.estimated_duration_minutes) then
      raise exception 'Booking is shorter than the estimated % minute corrective repair', v_fault.estimated_duration_minutes;
    end if;
  end if;

  select * into v_settings from planning_settings where fleet = v_fleet;
  v_local_start := p_start_at at time zone coalesce(v_settings.operating_timezone, 'Asia/Singapore');
  v_local_end := p_end_at at time zone coalesce(v_settings.operating_timezone, 'Asia/Singapore');
  if v_local_start::time < v_bay.opens_at or v_local_start::time > v_bay.closes_at
     or v_local_end::time < v_bay.opens_at or v_local_end::time > v_bay.closes_at then
    raise exception 'Booking must start and finish within bay operating hours';
  end if;

  if p_booking_id is not null then
    select * into v_existing from maintenance_bookings where id = p_booking_id for update;
    if not found then raise exception 'Booking not found'; end if;
    if v_existing.status in ('completed', 'partially_completed', 'cancelled') then
      raise exception 'A closed booking cannot be changed';
    end if;
  end if;
  if exists (
    select 1 from maintenance_bookings where bay_id = p_bay_id and status in ('proposed', 'confirmed')
      and id is distinct from p_booking_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then raise exception 'Bay % already has a booking in this period', p_bay_id; end if;
  if exists (
    select 1 from maintenance_bookings where lrv_id = p_lrv_id and status in ('proposed', 'confirmed')
      and id is distinct from p_booking_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then raise exception 'Vehicle % already has a booking in this period', p_lrv_id; end if;

  if p_status = 'confirmed' and exists (
    select 1 from duty_assignments where lrv_id = p_lrv_id and status in ('planned', 'active')
      and tstzrange(duty_start, duty_end, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then raise exception 'Vehicle % has an operating duty in this period', p_lrv_id; end if;

  if p_status = 'confirmed' then
    select count(*) into v_serviceable from vehicles where fleet = v_fleet and status = 'in_service';
    select coalesce(max(concurrent_bookings), 0) into v_concurrent
    from (
      select count(distinct vehicle.lrv_id) as concurrent_bookings
      from (
        select p_start_at as boundary
        union
        select candidate.start_at from maintenance_bookings as candidate
        where candidate.status = 'confirmed' and candidate.id is distinct from p_booking_id
          and tstzrange(candidate.start_at, candidate.end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
      ) as boundaries
      left join maintenance_bookings as booking
        on booking.status = 'confirmed' and booking.id is distinct from p_booking_id
       and booking.start_at <= boundaries.boundary and booking.end_at > boundaries.boundary
      left join vehicles as vehicle
        on vehicle.lrv_id = booking.lrv_id and vehicle.fleet = v_fleet and vehicle.status = 'in_service'
      group by boundaries.boundary
    ) as concurrency;
    if v_serviceable - v_concurrent - (case when v_vehicle_status = 'in_service' then 1 else 0 end)
       < coalesce(v_settings.minimum_service_vehicles, 0) then
      raise exception 'Booking would reduce the operating fleet below its service minimum';
    end if;
  end if;

  if p_booking_id is null then
    insert into maintenance_bookings (
      lrv_id, work_type, primary_cycle, bundled_cycles, fault_id, bay_id, start_at, end_at, status, notes
    ) values (
      p_lrv_id, p_work_type, p_primary_cycle, v_expected_cycles, p_fault_id,
      p_bay_id, p_start_at, p_end_at, p_status, p_notes
    ) returning id into v_booking_id;
  else
    update maintenance_bookings set
      lrv_id = p_lrv_id, work_type = p_work_type, primary_cycle = p_primary_cycle,
      bundled_cycles = v_expected_cycles, fault_id = p_fault_id, bay_id = p_bay_id,
      start_at = p_start_at, end_at = p_end_at, status = p_status, notes = p_notes, updated_at = now()
    where id = p_booking_id returning id into v_booking_id;
    if v_existing.fault_id is not null and v_existing.fault_id is distinct from p_fault_id then
      update maintenance_faults set status = 'open', updated_at = now()
      where id = v_existing.fault_id and status = 'scheduled';
    end if;
  end if;
  if p_work_type = 'corrective' then
    update maintenance_faults set status = 'scheduled', updated_at = now() where id = p_fault_id;
  end if;
  return v_booking_id;
end;
$$;

create or replace function cancel_maintenance_booking(p_booking_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public
as $$
declare v_fault_id uuid;
begin
  update maintenance_bookings
  set status = 'cancelled', notes = concat_ws(E'\n', nullif(notes, ''), nullif(p_reason, '')), updated_at = now()
  where id = p_booking_id and status in ('proposed', 'confirmed')
  returning fault_id into v_fault_id;
  if not found then raise exception 'Booking is missing or can no longer be cancelled'; end if;
  if v_fault_id is not null then
    update maintenance_faults set status = 'open', updated_at = now()
    where id = v_fault_id and status = 'scheduled';
  end if;
end;
$$;

drop function if exists complete_maintenance(text, integer, numeric, text, uuid, text, integer[]);
drop function if exists complete_maintenance(text, integer, numeric, text, uuid, text, integer[], text, uuid);

create function complete_maintenance(
  p_lrv_id text, p_primary_cycle integer, p_completion_mileage_km numeric,
  p_technician_id text, p_booking_id uuid default null, p_notes text default null,
  p_completed_cycles integer[] default null, p_work_type text default 'preventive',
  p_fault_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_event_id uuid; v_expected_cycles integer[] := '{}'::integer[];
  v_completed_cycles integer[] := '{}'::integer[]; v_device_odo numeric;
  v_last_anchor numeric; v_divergence numeric; v_booking maintenance_bookings%rowtype;
  v_work_type text := p_work_type; v_fault_id uuid := p_fault_id;
begin
  if p_completion_mileage_km is null or p_completion_mileage_km::text = 'NaN' or p_completion_mileage_km < 0 then
    raise exception 'Completion mileage must be a finite non-negative value';
  end if;
  if nullif(btrim(p_technician_id), '') is null then raise exception 'Technician ID is required'; end if;
  perform 1 from vehicles where lrv_id = p_lrv_id for update;
  if not found then raise exception 'Unknown vehicle %', p_lrv_id; end if;

  if p_booking_id is not null then
    select * into v_booking from maintenance_bookings where id = p_booking_id for update;
    if not found or v_booking.lrv_id <> p_lrv_id then raise exception 'Booking does not match this vehicle'; end if;
    if v_booking.status <> 'confirmed' then raise exception 'Only a confirmed booking can be completed'; end if;
    if now() < v_booking.start_at then raise exception 'A maintenance visit cannot be completed before it starts'; end if;
    v_work_type := v_booking.work_type;
    v_fault_id := v_booking.fault_id;
    if v_work_type = 'preventive' and v_booking.primary_cycle is distinct from p_primary_cycle then
      raise exception 'Booking does not match this maintenance cycle';
    end if;
    v_expected_cycles := v_booking.bundled_cycles;
  elsif v_work_type = 'preventive' then
    select included_cycles into v_expected_cycles
    from maintenance_cycle_rules as rule
    join vehicles as vehicle on vehicle.fleet = rule.fleet
    where vehicle.lrv_id = p_lrv_id and rule.cycle_type = p_primary_cycle;
  end if;

  if v_work_type = 'preventive' then
    if p_primary_cycle not in (2000, 13000, 40000, 120000, 360000) then
      raise exception 'Unsupported maintenance cycle';
    end if;
    select array_agg(distinct cycle order by cycle) into v_expected_cycles
    from unnest(v_expected_cycles) as planned(cycle);
    select array_agg(distinct cycle order by cycle) into v_completed_cycles
    from unnest(coalesce(p_completed_cycles, v_expected_cycles)) as completed(cycle);
    if v_completed_cycles is null or cardinality(v_completed_cycles) = 0 then
      raise exception 'At least one completed maintenance cycle is required';
    end if;
    if not (v_completed_cycles <@ v_expected_cycles) then
      raise exception 'Completed cycles % are outside the planned package %', v_completed_cycles, v_expected_cycles;
    end if;
    if v_completed_cycles is distinct from v_expected_cycles and nullif(btrim(p_notes), '') is null then
      raise exception 'A reason is required when the completed scope differs from the planned package';
    end if;
  elsif v_work_type = 'corrective' then
    if v_fault_id is null then raise exception 'Corrective completion requires a fault record'; end if;
    if cardinality(coalesce(p_completed_cycles, '{}'::integer[])) <> 0 then
      raise exception 'Corrective work cannot reset mileage cycles';
    end if;
    perform 1 from maintenance_faults where id = v_fault_id and lrv_id = p_lrv_id and status = 'scheduled' for update;
    if not found then raise exception 'The scheduled fault is unavailable for completion'; end if;
    v_expected_cycles := '{}'::integer[];
    v_completed_cycles := '{}'::integer[];
  else
    raise exception 'Unsupported maintenance work type';
  end if;

  select value_km into v_last_anchor from mileage_anchors
  where lrv_id = p_lrv_id and superseded_by is null order by ts desc nulls last, id desc limit 1;
  if v_last_anchor is not null and p_completion_mileage_km < v_last_anchor then
    raise exception 'Completion mileage cannot be below the latest accepted physical reading (%)', v_last_anchor;
  end if;
  if v_work_type = 'preventive' then
    perform 1 from cycle_state where lrv_id = p_lrv_id and cycle_type = any(v_completed_cycles) for update;
    if (select count(*) from cycle_state where lrv_id = p_lrv_id and cycle_type = any(v_completed_cycles))
       <> cardinality(v_completed_cycles) then
      raise exception 'Vehicle cycle state is incomplete for completed scope %', v_completed_cycles;
    end if;
  end if;
  select odo_km into v_device_odo from segment_traversals
  where lrv_id = p_lrv_id and ts <= now() + interval '10 minutes' order by ts desc, id desc limit 1;
  v_divergence := case when v_device_odo is null then null else p_completion_mileage_km - v_device_odo end;

  insert into maintenance_events (
    booking_id, lrv_id, completion_mileage_km, work_type, primary_cycle, reset_cycles,
    fault_id, technician_id, source, completed_at, notes
  ) values (
    p_booking_id, p_lrv_id, p_completion_mileage_km, v_work_type,
    case when v_work_type = 'preventive' then p_primary_cycle end,
    v_completed_cycles, v_fault_id, btrim(p_technician_id), 'dashboard', now(), p_notes
  ) returning id into v_event_id;
  insert into mileage_anchors (
    lrv_id, ts, technician_id, source, value_km, override, override_reason, gnss_odo_km, divergence_km
  ) values (
    p_lrv_id, now(), btrim(p_technician_id), 'maintenance_completion', p_completion_mileage_km,
    abs(coalesce(v_divergence, 0)) >= 50,
    case when abs(coalesce(v_divergence, 0)) >= 50 then 'Physical/device divergence requires evidence review' end,
    v_device_odo, v_divergence
  );
  if v_work_type = 'preventive' then
    update cycle_state set km_since = 0, km_to_next = cycle_type, due_date = null
    where lrv_id = p_lrv_id and cycle_type = any(v_completed_cycles);
  else
    update maintenance_faults set status = 'resolved', resolved_at = now(),
      resolution_notes = p_notes, updated_at = now() where id = v_fault_id;
  end if;
  if p_booking_id is not null then
    update maintenance_bookings
    set status = case
      when v_work_type = 'corrective' or v_completed_cycles = v_expected_cycles then 'completed'
      else 'partially_completed'
    end, updated_at = now()
    where id = p_booking_id;
  end if;
  update vehicles set status = 'idle' where lrv_id = p_lrv_id;
  return v_event_id;
end;
$$;

alter table maintenance_faults enable row level security;
drop policy if exists "demo read maintenance faults" on maintenance_faults;
create policy "demo read maintenance faults" on maintenance_faults
  for select to anon, authenticated using (true);

grant select on maintenance_faults to anon, authenticated;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'maintenance_faults'
  ) then
    alter publication supabase_realtime add table maintenance_faults;
  end if;
end $$;
revoke execute on function schedule_maintenance(text, integer, integer[], text, timestamptz, timestamptz, text, text, uuid, text, uuid) from public;
revoke execute on function complete_maintenance(text, integer, numeric, text, uuid, text, integer[], text, uuid) from public;
grant execute on function schedule_maintenance(text, integer, integer[], text, timestamptz, timestamptz, text, text, uuid, text, uuid) to anon, authenticated;
grant execute on function complete_maintenance(text, integer, numeric, text, uuid, text, integer[], text, uuid) to anon, authenticated;

-- Demo reset function for restoring the seeded test state.
create or replace function reset_dashboard_demo()
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Singapore')::date;
begin
  perform pg_advisory_xact_lock(hashtextextended('dashboard-demo-reset:splrt', 0));

  -- Remove changes created through the dashboard. Seed-owned evidence and
  -- telemetry remain available, while optional simulator events are cleared.
  delete from maintenance_events
  where source = 'dashboard' and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  delete from mileage_anchors
  where source = 'maintenance_completion' and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  delete from maintenance_bookings
  where (demo_key is null or demo_key not like 'demo:%')
    and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

  update stock_changes
  set replacement_assignment_id = null, replacement_lrv_id = 'D27',
      decision_status = 'proposed', decided_by = null, decided_at = null,
      reason = 'Brake pressure fault reported in service; replace at the next safe handover',
      projected_duty_km = 118
  where demo_key = 'demo:stock:D29:D27';
  delete from stock_changes
  where demo_key is null and withdrawn_lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  delete from duty_assignments
  where demo_key is null and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  update duty_assignments
  set duty_start = now() - interval '2 hours'
        + ((substring(lrv_id from 2))::integer % 4) * interval '5 minutes',
      duty_end = now() + interval '5 hours'
        - ((substring(lrv_id from 2))::integer % 3) * interval '10 minutes',
      status = 'active'
  where demo_key like 'demo:duty:%';

  delete from segment_traversals
  where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$' and seq >= 950000000;

  update vehicles
  set status = case
    when lrv_id in ('D18', 'D24', 'D25', 'D26') then 'maintenance'
    when lrv_id in ('D27', 'D28') then 'idle'
    when lrv_id in ('D29', 'D30') then 'faulty'
    else 'in_service'
  end
  where fleet = 'splrt' and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

  update maintenance_faults
  set status = 'open', resolved_at = null, resolution_notes = null, updated_at = now()
  where demo_key like 'demo:fault:%';

  -- Clear active ranges before moving seeded bookings back to their canonical
  -- slots, so even heavily edited calendars reset without transient conflicts.
  update maintenance_bookings set status = 'cancelled', updated_at = now()
  where demo_key like 'demo:booking:%';

  update maintenance_bookings as booking
  set work_type = 'preventive', primary_cycle = seed.primary_cycle,
      bundled_cycles = seed.bundled_cycles, fault_id = null, bay_id = seed.bay_id,
      start_at = ((v_today + seed.start_days + seed.start_time) at time zone 'Asia/Singapore'),
      end_at = ((v_today + seed.end_days + seed.end_time) at time zone 'Asia/Singapore'),
      status = seed.status, notes = seed.notes, updated_at = now()
  from (values
    ('demo:booking:D18', 2000, array[2000], 'SPLRT-BAY-1', 0, time '09:00', 0, time '11:00', 'confirmed', 'Overdue 2K recall; vehicle already in depot'),
    ('demo:booking:D07', 13000, array[2000,13000], 'SPLRT-BAY-1', 1, time '09:00', 1, time '13:00', 'confirmed', 'Bundle the 2K and 13K cycles in one visit'),
    ('demo:booking:D24', 13000, array[2000,13000], 'SPLRT-BAY-1', 2, time '13:00', 2, time '17:00', 'confirmed', 'Routine planned maintenance'),
    ('demo:booking:D25', 40000, array[2000,13000,40000], 'SPLRT-BAY-2', 3, time '08:00', 3, time '14:00', 'confirmed', '40K package with nested-cycle completion'),
    ('demo:booking:D26', 120000, array[2000,13000,40000,120000], 'SPLRT-BAY-2', 4, time '08:00', 5, time '08:00', 'confirmed', '24-hour package with continuous bay occupation'),
    ('demo:booking:D22', 360000, array[2000,13000,40000,120000,360000], 'SPLRT-BAY-2', 6, time '08:00', 27, time '08:00', 'confirmed', 'Three-week package including weekends and waiting time')
  ) as seed(demo_key, primary_cycle, bundled_cycles, bay_id, start_days, start_time, end_days, end_time, status, notes)
  where booking.demo_key = seed.demo_key;

  with vehicle_profile as (
    select
      vehicle_no,
      format('D%s', lpad(vehicle_no::text, 2, '0')) as lrv_id,
      case vehicle_no
        when 7 then 410 when 9 then 92 when 12 then 400 when 18 then 105
        when 21 then 148 when 23 then 402 when 24 then 84 when 25 then 96
        when 26 then 78 when 27 then 86 when 28 then 82 when 29 then 110
        when 30 then 75 else 55 + ((vehicle_no * 17) % 66)
      end::numeric as daily_km
    from generate_series(1, 30) as vehicle_no
  ),
  cycles(cycle_type, cycle_order) as (
    values (2000, 1), (13000, 2), (40000, 3), (120000, 4), (360000, 5)
  ),
  overrides(lrv_id, cycle_type, km_since, km_to_next, due_offset_days) as (
    values
      ('D07',2000,1610::numeric,390::numeric,1), ('D07',13000,12200,800,2),
      ('D12',2000,2000,0,0), ('D18',2000,2060,-60,-3),
      ('D21',2000,520,1480,10), ('D21',13000,12680,320,2),
      ('D22',360000,359500,500,6), ('D23',2000,50,1950,5),
      ('D23',40000,39580,420,1), ('D24',13000,13020,-20,-1),
      ('D25',40000,39950,50,0), ('D26',120000,118900,1100,5),
      ('D27',2000,550,1450,17), ('D28',2000,1020,980,12)
  ),
  calculated as (
    select profile.lrv_id, profile.daily_km, cycle.cycle_type,
      least(cycle.cycle_type - 10,
        greatest(50, round(profile.daily_km * (8 + ((profile.vehicle_no * 11 + cycle.cycle_order * 17) % 113)))))::numeric
        as default_remaining
    from vehicle_profile as profile cross join cycles as cycle
  )
  insert into cycle_state (lrv_id, cycle_type, km_since, km_to_next, due_date)
  select calculated.lrv_id, calculated.cycle_type,
    coalesce(overrides.km_since, calculated.cycle_type - calculated.default_remaining),
    coalesce(overrides.km_to_next, calculated.default_remaining),
    v_today + coalesce(overrides.due_offset_days,
      ceil(calculated.default_remaining / calculated.daily_km)::integer)
  from calculated
  left join overrides using (lrv_id, cycle_type)
  on conflict (lrv_id, cycle_type) do update
  set km_since = excluded.km_since, km_to_next = excluded.km_to_next,
      due_date = excluded.due_date;

  update planning_settings set forecast_horizon_days = 14,
    deployment_safety_margin_km = 250, stale_telemetry_hours = 12,
    minimum_service_vehicles = 18, operating_timezone = 'Asia/Singapore', updated_at = now()
  where fleet = 'splrt';
  update maintenance_cycle_rules as rule set
    tolerance_km = seed.tolerance_km, duration_minutes = seed.duration_minutes,
    compatible_bay_type = seed.bay_type, included_cycles = seed.included_cycles, updated_at = now()
  from (values
    (2000,120,120,'universal',array[2000]),
    (13000,350,240,'universal',array[2000,13000]),
    (40000,600,360,'heavy',array[2000,13000,40000]),
    (120000,900,1440,'heavy',array[2000,13000,40000,120000]),
    (360000,1500,30240,'heavy',array[2000,13000,40000,120000,360000])
  ) as seed(cycle_type, tolerance_km, duration_minutes, bay_type, included_cycles)
  where rule.fleet = 'splrt' and rule.cycle_type = seed.cycle_type;
  update depot_bays set
    name = case bay_id when 'SPLRT-BAY-1' then 'Bay 1 · Routine' else 'Bay 2 · Heavy' end,
    bay_type = case bay_id when 'SPLRT-BAY-1' then 'universal' else 'heavy' end,
    opens_at = time '06:00', closes_at = time '23:00', active = true
  where bay_id in ('SPLRT-BAY-1', 'SPLRT-BAY-2');
end;
$$;

revoke execute on function reset_dashboard_demo() from public;
grant execute on function reset_dashboard_demo() to anon, authenticated;

commit;

-- Technician mobile capture and OCR audit workflow.

begin;

create table if not exists technician_observations (
  id uuid primary key default gen_random_uuid(),
  lrv_id text not null references vehicles(lrv_id),
  booking_id uuid references maintenance_bookings(id) on delete set null,
  maintenance_event_id uuid references maintenance_events(id) on delete set null,
  anchor_id bigint not null unique references mileage_anchors(id) on delete cascade,
  technician_id text not null,
  image_uri text not null,
  ocr_value_km numeric not null check (ocr_value_km >= 0),
  ocr_confidence numeric(5,4) not null check (ocr_confidence between 0 and 1),
  reviewed_manually boolean not null default false,
  submitted_value_km numeric not null check (submitted_value_km >= 0),
  captured_at timestamptz not null default now()
);

alter table technician_observations
  add column if not exists maintenance_event_id uuid references maintenance_events(id) on delete set null;

create index if not exists technician_observations_vehicle_time_idx
  on technician_observations (lrv_id, captured_at desc);

alter table technician_observations enable row level security;
drop policy if exists "demo read technician observations" on technician_observations;
create policy "demo read technician observations"
  on technician_observations for select to anon, authenticated using (true);
grant select on technician_observations to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'hubometer-evidence', 'hubometer-evidence', false, 8388608,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "demo upload hubometer evidence" on storage.objects;
create policy "demo upload hubometer evidence"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'hubometer-evidence');

drop policy if exists "demo read hubometer evidence" on storage.objects;
create policy "demo read hubometer evidence"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'hubometer-evidence');

drop policy if exists "demo remove failed hubometer evidence" on storage.objects;
create policy "demo remove failed hubometer evidence"
  on storage.objects for delete to anon, authenticated
  using (bucket_id = 'hubometer-evidence');

drop function if exists submit_hubometer_observation(text, numeric, text, text, numeric, boolean, uuid);
drop function if exists submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid);
drop function if exists submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid, integer[], text);

create or replace function submit_hubometer_observation(
  p_lrv_id text,
  p_value_km numeric,
  p_technician_id text,
  p_image_uri text,
  p_ocr_value_km numeric,
  p_ocr_confidence numeric,
  p_reviewed_manually boolean,
  p_booking_id uuid default null,
  p_completed_cycles integer[] default null,
  p_completion_notes text default null
)
returns bigint language plpgsql security definer set search_path = public
as $$
declare
  v_booking maintenance_bookings%rowtype;
  v_event_id uuid;
  v_anchor_id bigint;
  v_anchor_floor bigint;
  v_notes text;
begin
  if p_value_km is null or p_value_km < 0 then
    raise exception 'A valid non-negative hubometer reading is required';
  end if;
  if nullif(btrim(p_technician_id), '') is null then
    raise exception 'Technician ID is required';
  end if;
  if nullif(btrim(p_image_uri), '') is null then
    raise exception 'A hubometer photo is required';
  end if;
  if p_ocr_confidence is null or p_ocr_confidence < 0 or p_ocr_confidence > 1 then
    raise exception 'OCR confidence must be between zero and one';
  end if;
  if p_ocr_value_km is null or p_ocr_value_km < 0 then
    raise exception 'A valid OCR reading is required';
  end if;
  if p_ocr_confidence < 0.85 and not p_reviewed_manually then
    raise exception 'Low-confidence OCR readings require manual verification';
  end if;
  if p_booking_id is null then
    raise exception 'A confirmed maintenance booking is required';
  end if;

  perform 1 from vehicles where lrv_id = p_lrv_id for update;
  if not found then
    raise exception 'Unknown LRV %', p_lrv_id;
  end if;
  select * into v_booking
  from maintenance_bookings
  where id = p_booking_id
  for update;
  if not found or v_booking.lrv_id <> p_lrv_id then
    raise exception 'The selected maintenance booking does not belong to %', p_lrv_id;
  end if;
  if v_booking.status <> 'confirmed' then
    raise exception 'Only a confirmed maintenance booking can be completed';
  end if;

  if v_booking.work_type = 'preventive' then
    if cardinality(coalesce(p_completed_cycles, '{}'::integer[])) = 0 then
      raise exception 'Select at least one completed maintenance cycle';
    end if;
    if not (p_completed_cycles <@ v_booking.bundled_cycles) then
      raise exception 'Completed cycles are outside the assigned package';
    end if;
    if p_completed_cycles is distinct from v_booking.bundled_cycles
       and nullif(btrim(p_completion_notes), '') is null then
      raise exception 'A reason is required when assigned maintenance was not completed';
    end if;
  elsif cardinality(coalesce(p_completed_cycles, '{}'::integer[])) <> 0 then
    raise exception 'Corrective work cannot complete mileage cycles';
  end if;

  select coalesce(max(id), 0) into v_anchor_floor from mileage_anchors;

  v_notes := concat_ws(' — ', 'Hubometer reading confirmed through technician OCR workflow', nullif(btrim(p_completion_notes), ''));

  v_event_id := complete_maintenance(
    p_lrv_id,
    v_booking.primary_cycle,
    p_value_km,
    btrim(p_technician_id),
    p_booking_id,
    v_notes,
    coalesce(p_completed_cycles, '{}'::integer[]),
    v_booking.work_type,
    v_booking.fault_id
  );

  select id into v_anchor_id
  from mileage_anchors
  where id > v_anchor_floor
    and lrv_id = p_lrv_id
    and technician_id = btrim(p_technician_id)
    and source = 'maintenance_completion'
    and value_km = p_value_km
  order by id desc
  limit 1;
  if v_anchor_id is null then
    raise exception 'Maintenance completed without a matching mileage anchor';
  end if;

  insert into technician_observations (
    lrv_id, booking_id, maintenance_event_id, anchor_id, technician_id, image_uri,
    ocr_value_km, ocr_confidence, reviewed_manually, submitted_value_km
  ) values (
    p_lrv_id, p_booking_id, v_event_id, v_anchor_id, btrim(p_technician_id), btrim(p_image_uri),
    p_ocr_value_km, p_ocr_confidence, p_reviewed_manually, p_value_km
  );

  return v_anchor_id;
end;
$$;

revoke execute on function submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid, integer[], text) from public;
grant execute on function submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid, integer[], text) to anon, authenticated;

do $$
begin
  if to_regprocedure('public.reset_dashboard_demo_core()') is null then
    execute 'alter function public.reset_dashboard_demo() rename to reset_dashboard_demo_core';
  end if;
end;
$$;

create or replace function reset_dashboard_demo()
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_latest_demo_telemetry timestamptz;
  v_telemetry_shift interval;
begin
  delete from technician_observations
  where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  delete from mileage_anchors
  where source = 'technician_ocr'
    and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  perform reset_dashboard_demo_core();

  update maintenance_bookings
  set status = 'confirmed', updated_at = now()
  where demo_key in ('demo:booking:D07', 'demo:booking:D26', 'demo:booking:D22')
    and status = 'proposed';

  select max(ts)
  into v_latest_demo_telemetry
  from segment_traversals
  where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
    and seq >= 900000000
    and seq < 950000000
    and seg_id like 'SIM\_%' escape '\';

  if v_latest_demo_telemetry is not null then
    v_telemetry_shift := now() - interval '5 minutes' - v_latest_demo_telemetry;

    update segment_traversals
    set ts = ts + v_telemetry_shift
    where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
      and seq >= 900000000
      and seq < 950000000
      and seg_id like 'SIM\_%' escape '\';
  end if;
end;
$$;

revoke execute on function reset_dashboard_demo_core() from public, anon, authenticated;
revoke execute on function reset_dashboard_demo() from public;
grant execute on function reset_dashboard_demo() to anon, authenticated;

commit;
