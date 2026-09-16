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
