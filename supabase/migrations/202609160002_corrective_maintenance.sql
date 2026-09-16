begin;

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

commit;
