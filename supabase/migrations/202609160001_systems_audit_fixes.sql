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
select
  cycle.lrv_id, cycle.cycle_type, cycle.km_since, cycle.km_to_next,
  cycle.due_date as seeded_due_date, mileage.rolling_daily_rate_km,
  case
    when cycle.km_to_next <= 0 then
      coalesce(least(cycle.due_date, (now() at time zone 'Asia/Singapore')::date),
               (now() at time zone 'Asia/Singapore')::date)
      - (now() at time zone 'Asia/Singapore')::date
    when mileage.latest_telemetry_at is null then null
    when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then null
    when coalesce(mileage.rolling_daily_rate_km, 0) <= 0 then null
    else ceil(cycle.km_to_next / mileage.rolling_daily_rate_km)::integer
  end as forecast_days,
  case
    when cycle.km_to_next <= 0 then
      coalesce(least(cycle.due_date, (now() at time zone 'Asia/Singapore')::date),
               (now() at time zone 'Asia/Singapore')::date)
    when mileage.latest_telemetry_at is null then null
    when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then null
    when coalesce(mileage.rolling_daily_rate_km, 0) <= 0 then null
    else (now() at time zone 'Asia/Singapore')::date
         + ceil(cycle.km_to_next / mileage.rolling_daily_rate_km)::integer
  end as forecast_date,
  (
    case when cycle.km_to_next <= 0 then 1000 else 0 end
    + case when mileage.status = 'faulty' then 700 when mileage.status = 'maintenance' then 350 else 0 end
    + case when mileage.latest_telemetry_at is null then 250
           when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then 200 else 0 end
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

commit;
