begin;

-- All assistant state is private to the Edge Function. A browser capability is
-- checked by that function; the database never accepts an anonymous tool call.
create table assistant_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  owner_id uuid,
  fleet text not null default 'splrt',
  is_demo boolean not null default true,
  busy_until timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours',
  created_at timestamptz not null default now()
);
create table assistant_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references assistant_sessions on delete cascade,
  request_id uuid,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) <= 24000),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (session_id, role, request_id)
);
create table assistant_batches (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references assistant_sessions on delete cascade,
  request_id uuid not null,
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'discarded')),
  booking_ids uuid[] not null default '{}',
  request_hash text not null,
  cycle_snapshot jsonb not null default '[]',
  booking_snapshot jsonb not null default '[]',
  metadata jsonb not null default '{}',
  expires_at timestamptz not null default now() + interval '2 hours',
  created_at timestamptz not null default now(),
  unique (session_id, request_id)
);
create table assistant_audit (
  id bigint generated always as identity primary key,
  session_id uuid references assistant_sessions on delete set null,
  event text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index assistant_messages_session_time on assistant_messages(session_id, created_at);
create index assistant_batches_pending on assistant_batches(expires_at) where status = 'proposed';
create index assistant_audit_limits on assistant_audit(event, created_at);
create index assistant_audit_session_time on assistant_audit(session_id, created_at);

alter table assistant_sessions enable row level security;
alter table assistant_messages enable row level security;
alter table assistant_batches enable row level security;
alter table assistant_audit enable row level security;
revoke all on assistant_sessions, assistant_messages, assistant_batches, assistant_audit from public, anon, authenticated;
grant all on assistant_sessions, assistant_messages, assistant_batches, assistant_audit to service_role;
grant usage, select on sequence assistant_audit_id_seq to service_role;

-- Expired drafts must release their bay reservations. Run on assistant entry;
-- this is also suitable for a periodic server job. Never cancel confirmed work.
create function assistant_expire_proposals()
returns integer language plpgsql security definer set search_path = public
as $$
declare v_batch assistant_batches%rowtype; v_id uuid; v_status text; v_count integer := 0;
begin
  for v_batch in select * from assistant_batches
    where status = 'proposed' and expires_at <= now() for update skip locked
  loop
    foreach v_id in array v_batch.booking_ids loop
      select status into v_status from maintenance_bookings where id = v_id for update;
      if found and v_status = 'proposed' then
        perform cancel_maintenance_booking(v_id, 'Assistant draft expired before confirmation');
      end if;
    end loop;
    update assistant_batches set status = 'discarded' where id = v_batch.id;
    insert into assistant_audit(session_id, event, details)
      values (v_batch.session_id, 'proposal_expired', jsonb_build_object('batchId', v_batch.id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create function assistant_reserve_turn(p_session_id uuid, p_actor_hash text)
returns boolean language plpgsql security definer set search_path = public
as $$
declare v_session assistant_sessions%rowtype;
begin
  if length(coalesce(p_actor_hash, '')) < 16 then raise exception 'Missing rate-limit identity'; end if;
  -- A global transaction lock prevents simultaneous workers exceeding limits.
  perform pg_advisory_xact_lock(hashtextextended('maintenance-assistant:budget', 0));
  select * into v_session from assistant_sessions where id = p_session_id for update;
  if not found or v_session.expires_at <= now() then raise exception 'Assistant session expired'; end if;
  if v_session.busy_until > now() then raise exception 'Another assistant turn is still running'; end if;
  if (select count(*) from assistant_audit where event = 'turn_reserved'
      and session_id = p_session_id and created_at > now() - interval '1 hour') >= 30
     or (select count(*) from assistant_audit where event = 'turn_reserved'
      and details->>'actorHash' = p_actor_hash and created_at > now() - interval '24 hours') >= 60
     or (select count(*) from assistant_audit where event = 'turn_reserved'
      and created_at > now() - interval '24 hours') >= 200 then
    raise exception 'Assistant usage limit reached. Please try again later';
  end if;
  update assistant_sessions set busy_until = now() + interval '90 seconds' where id = p_session_id;
  insert into assistant_audit(session_id, event, details)
    values (p_session_id, 'turn_reserved', jsonb_build_object('actorHash', p_actor_hash));
  return true;
end;
$$;

-- Both save and confirm revalidate operating constraints in the transaction.
-- Existing schedule_maintenance remains authoritative for nesting, duration,
-- compatibility, exclusion conflicts and the minimum operating fleet.
create function assistant_validate_slot(p_lrv_id text, p_bay_id text, p_start timestamptz, p_end timestamptz, p_booking_id uuid default null)
returns void language plpgsql security definer set search_path = public
as $$
declare v_fleet text; v_status text; v_bay depot_bays%rowtype; v_settings planning_settings%rowtype;
  v_start timestamp; v_end timestamp; v_duration numeric; v_serviceable integer; v_concurrent integer;
begin
  select fleet, status into v_fleet, v_status from vehicles where lrv_id = p_lrv_id;
  select * into v_bay from depot_bays where bay_id = p_bay_id;
  select * into v_settings from planning_settings where fleet = v_fleet;
  v_start := p_start at time zone coalesce(v_settings.operating_timezone, 'Asia/Singapore');
  v_end := p_end at time zone coalesce(v_settings.operating_timezone, 'Asia/Singapore');
  v_duration := extract(epoch from p_end - p_start) / 60;
  -- Short visits do not work through lunch or overnight. Long packages retain
  -- continuous bay occupancy; lunch is a crew break inside that occupancy.
  if v_duration < 1440 then
    if v_start::date <> v_end::date or (v_start::time < time '13:00' and v_end::time > time '12:00') then
      raise exception 'Short maintenance visits must avoid the 12:00-13:00 lunch break';
    end if;
  end if;
  select count(*) into v_serviceable from vehicles where fleet = v_fleet and status = 'in_service';
  select coalesce(max(total), 0) into v_concurrent from (
    select count(distinct vehicle.lrv_id) total from (
      select p_start boundary union select start_at from maintenance_bookings
      where status in ('proposed', 'confirmed') and id is distinct from p_booking_id
        and start_at >= p_start and start_at < p_end
    ) boundaries
    left join maintenance_bookings booking on booking.status in ('proposed', 'confirmed')
      and booking.id is distinct from p_booking_id and booking.start_at <= boundaries.boundary and booking.end_at > boundaries.boundary
    left join vehicles vehicle on vehicle.lrv_id = booking.lrv_id and vehicle.fleet = v_fleet and vehicle.status = 'in_service'
    group by boundaries.boundary
  ) capacity;
  if v_serviceable - v_concurrent - (case when v_status = 'in_service' then 1 else 0 end)
      < coalesce(v_settings.minimum_service_vehicles, 0) then
    raise exception 'Proposal would reduce the operating fleet below its service minimum';
  end if;
end;
$$;

create function assistant_save_proposal(p_session_id uuid, p_request_id uuid, p_bookings jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_session assistant_sessions%rowtype; v_batch assistant_batches%rowtype;
  v_item jsonb; v_id uuid; v_ids uuid[] := '{}'; v_snapshot jsonb; v_booking_snapshot jsonb;
  v_start timestamptz; v_end timestamptz; v_cycles integer[]; v_lrv text;
  v_hash text := md5(p_bookings::text);
begin
  select * into v_session from assistant_sessions where id = p_session_id for update;
  if not found or v_session.expires_at <= now() then raise exception 'Assistant session expired'; end if;
  if p_request_id is null then raise exception 'Proposal request ID is required'; end if;
  select * into v_batch from assistant_batches where session_id = p_session_id and request_id = p_request_id;
  if found then
    if v_batch.request_hash <> v_hash then raise exception 'Request ID already used for a different proposal'; end if;
    return to_jsonb(v_batch) - 'request_hash' - 'cycle_snapshot' - 'booking_snapshot';
  end if;
  if exists (select 1 from assistant_batches where session_id = p_session_id and status = 'proposed') then
    raise exception 'Confirm or discard the existing proposal before creating another';
  end if;
  if jsonb_typeof(p_bookings) is distinct from 'array' then raise exception 'Bookings must be an array'; end if;
  if jsonb_array_length(p_bookings) not between 1 and 12 then raise exception 'A proposal must contain 1 to 12 bookings'; end if;
  if (select count(distinct item->>'lrvId') from jsonb_array_elements(p_bookings) item) <> jsonb_array_length(p_bookings) then
    raise exception 'A proposal may include each LRV only once';
  end if;
  -- Match the existing writer's vehicle-before-fleet lock order.
  perform 1 from vehicles where lrv_id in (select item->>'lrvId' from jsonb_array_elements(p_bookings) item)
    order by lrv_id for update;
  perform pg_advisory_xact_lock(hashtextextended('maintenance:' || v_session.fleet, 0));
  for v_item in select * from jsonb_array_elements(p_bookings) loop
    v_lrv := v_item->>'lrvId';
    if not exists (select 1 from vehicles where lrv_id = v_lrv and fleet = v_session.fleet) then
      raise exception 'Vehicle is outside the session fleet';
    end if;
    if exists (select 1 from maintenance_bookings where lrv_id = v_lrv and status in ('proposed', 'confirmed')) then
      raise exception 'Vehicle % already has an active maintenance visit. Refresh the plan', v_lrv;
    end if;
    v_start := (v_item->>'startAt')::timestamptz; v_end := (v_item->>'endAt')::timestamptz;
    if v_start is null or v_end is null or v_start < now() or v_start > now() + interval '120 days' then
      raise exception 'Proposal start is past or outside the 120-day planning horizon';
    end if;
    if v_end <= v_start or v_end > v_start + interval '30 days' then raise exception 'Invalid proposal duration'; end if;
    if length(coalesce(v_item->>'notes', '')) > 2000 then raise exception 'Booking notes are too long'; end if;
    select coalesce(array_agg(value::integer), '{}') into v_cycles
      from jsonb_array_elements_text(coalesce(v_item->'bundledCycles', '[]'));
    if coalesce(v_item->>'workType', 'preventive') = 'preventive' then
      if exists (select 1 from vehicles where lrv_id = v_lrv and status in ('faulty', 'maintenance')) then
        raise exception 'Vehicle % is not available for preventive planning', v_lrv;
      end if;
      if not exists (select 1 from cycle_forecasts where lrv_id = v_lrv
          and cycle_type = (v_item->>'primaryCycle')::integer and forecast_days is not null) then
        raise exception 'A current maintenance forecast is required for %', v_lrv;
      end if;
    end if;
    if exists (select 1 from duty_assignments where lrv_id = v_lrv and status in ('planned', 'active')
        and tstzrange(duty_start, duty_end, '[)') && tstzrange(v_start, v_end, '[)')) then
      raise exception 'Vehicle % has an operating duty in this period', v_lrv;
    end if;
    if exists (select 1 from maintenance_bookings where bay_id = v_item->>'bayId' and status in ('proposed', 'confirmed')
        and tstzrange(start_at - interval '30 minutes', end_at + interval '30 minutes', '[)') && tstzrange(v_start, v_end, '[)')) then
      raise exception 'Booking must preserve a 30-minute bay turnaround buffer';
    end if;
    perform assistant_validate_slot(v_lrv, v_item->>'bayId', v_start, v_end);
    v_id := schedule_maintenance(v_lrv, (v_item->>'primaryCycle')::integer, v_cycles,
      v_item->>'bayId', v_start, v_end, 'proposed', v_item->>'notes', null,
      coalesce(v_item->>'workType', 'preventive'), (v_item->>'faultId')::uuid);
    v_ids := array_append(v_ids, v_id);
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('lrvId', state.lrv_id, 'cycleType', state.cycle_type,
    'kmSince', state.km_since, 'kmToNext', state.km_to_next)), '[]') into v_snapshot
  from cycle_state state join maintenance_bookings booking on booking.lrv_id = state.lrv_id
    and state.cycle_type = any(booking.bundled_cycles) where booking.id = any(v_ids);
  select jsonb_agg(to_jsonb(booking) - 'created_at' - 'updated_at' - 'status') into v_booking_snapshot
    from maintenance_bookings booking where booking.id = any(v_ids);
  insert into assistant_batches(session_id, request_id, booking_ids, request_hash, cycle_snapshot, booking_snapshot)
    values (p_session_id, p_request_id, v_ids, v_hash, v_snapshot, v_booking_snapshot) returning * into v_batch;
  insert into assistant_audit(session_id, event, details)
    values (p_session_id, 'proposal_created', jsonb_build_object('batchId', v_batch.id, 'bookingIds', v_ids));
  return to_jsonb(v_batch) - 'request_hash' - 'cycle_snapshot' - 'booking_snapshot';
end;
$$;

create function assistant_resolve_proposal(p_session_id uuid, p_batch_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_session assistant_sessions%rowtype; v_batch assistant_batches%rowtype;
  v_booking maintenance_bookings%rowtype; v_id uuid;
begin
  if p_action not in ('confirm', 'discard') or p_action is null then raise exception 'Unsupported proposal action'; end if;
  select * into v_session from assistant_sessions where id = p_session_id for update;
  if not found or v_session.expires_at <= now() then raise exception 'Assistant session expired'; end if;
  select * into v_batch from assistant_batches where id = p_batch_id and session_id = p_session_id for update;
  if not found then raise exception 'Proposal does not belong to this session'; end if;
  if (p_action = 'confirm' and v_batch.status = 'confirmed') or (p_action = 'discard' and v_batch.status = 'discarded') then
    return to_jsonb(v_batch) - 'request_hash' - 'cycle_snapshot' - 'booking_snapshot';
  end if;
  if v_batch.status <> 'proposed' then raise exception 'Proposal has already been resolved'; end if;
  perform 1 from vehicles where lrv_id in (select lrv_id from maintenance_bookings where id = any(v_batch.booking_ids))
    order by lrv_id for update;
  perform pg_advisory_xact_lock(hashtextextended('maintenance:' || v_session.fleet, 0));
  if p_action = 'confirm' then
    if v_batch.expires_at <= now() then raise exception 'Proposal expired. Discard it and request a fresh plan'; end if;
    if exists (select 1 from jsonb_array_elements(v_batch.cycle_snapshot) item
        left join cycle_state state on state.lrv_id = item->>'lrvId' and state.cycle_type = (item->>'cycleType')::integer
        where state.lrv_id is null or state.km_since < (item->>'kmSince')::numeric
          or state.km_to_next > (item->>'kmToNext')::numeric) then
      raise exception 'Maintenance cycles changed since this proposal. Request a fresh plan';
    end if;
  end if;
  foreach v_id in array v_batch.booking_ids loop
    select * into v_booking from maintenance_bookings where id = v_id for update;
    if p_action = 'discard' then
      if found and v_booking.status = 'proposed' then
        perform cancel_maintenance_booking(v_id, 'Assistant proposal discarded by operator');
      end if;
    else
      if not found or v_booking.status <> 'proposed' then raise exception 'A proposed booking changed. Refresh the plan'; end if;
      if not exists (select 1 from jsonb_array_elements(v_batch.booking_snapshot) item
          where item = to_jsonb(v_booking) - 'created_at' - 'updated_at' - 'status') then
        raise exception 'A proposed booking changed. Refresh the plan';
      end if;
      if v_booking.start_at < now() then raise exception 'A proposed booking now starts in the past. Request a fresh plan'; end if;
      if not exists (select 1 from vehicles where lrv_id = v_booking.lrv_id and fleet = v_session.fleet) then
        raise exception 'Vehicle is outside the session fleet';
      end if;
      if v_booking.work_type = 'preventive' then
        if exists (select 1 from vehicles where lrv_id = v_booking.lrv_id and status in ('faulty', 'maintenance'))
           or not exists (select 1 from cycle_forecasts where lrv_id = v_booking.lrv_id
             and cycle_type = v_booking.primary_cycle and forecast_days is not null) then
          raise exception 'Vehicle status or forecast changed. Request a fresh plan';
        end if;
      end if;
      if exists (select 1 from maintenance_bookings where lrv_id = v_booking.lrv_id
          and id <> v_id and status in ('proposed', 'confirmed')) then
        raise exception 'Vehicle already has another active visit. Refresh the plan';
      end if;
      if exists (select 1 from maintenance_bookings where bay_id = v_booking.bay_id and id <> v_id
          and status in ('proposed', 'confirmed') and tstzrange(start_at - interval '30 minutes', end_at + interval '30 minutes', '[)')
          && tstzrange(v_booking.start_at, v_booking.end_at, '[)')) then
        raise exception 'Bay turnaround changed. Request a fresh plan';
      end if;
      perform assistant_validate_slot(v_booking.lrv_id, v_booking.bay_id, v_booking.start_at, v_booking.end_at, v_booking.id);
      perform schedule_maintenance(v_booking.lrv_id, v_booking.primary_cycle, v_booking.bundled_cycles,
        v_booking.bay_id, v_booking.start_at, v_booking.end_at, 'confirmed', v_booking.notes,
        v_booking.id, v_booking.work_type, v_booking.fault_id);
    end if;
  end loop;
  update assistant_batches set status = case when p_action = 'confirm' then 'confirmed' else 'discarded' end
    where id = p_batch_id returning * into v_batch;
  insert into assistant_audit(session_id, event, details)
    values (p_session_id, 'proposal_' || v_batch.status, jsonb_build_object('batchId', p_batch_id));
  return to_jsonb(v_batch) - 'request_hash' - 'cycle_snapshot' - 'booking_snapshot';
end;
$$;

revoke all on function assistant_validate_slot(text,text,timestamptz,timestamptz,uuid), assistant_expire_proposals(), assistant_reserve_turn(uuid,text),
  assistant_save_proposal(uuid,uuid,jsonb), assistant_resolve_proposal(uuid,uuid,text) from public, anon, authenticated;
grant execute on function assistant_validate_slot(text,text,timestamptz,timestamptz,uuid), assistant_expire_proposals(), assistant_reserve_turn(uuid,text),
  assistant_save_proposal(uuid,uuid,jsonb), assistant_resolve_proposal(uuid,uuid,text) to service_role;

-- Preserve the existing reset implementation; clear only explicitly demo-owned
-- assistant conversations and their drafts. Production sessions are retained.
alter function reset_dashboard_demo() rename to reset_dashboard_demo_before_assistant;
revoke all on function reset_dashboard_demo_before_assistant() from public, anon, authenticated;
create function reset_dashboard_demo()
returns void language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('dashboard-demo-reset:splrt', 0));
  for v_id in select booking.id from maintenance_bookings booking
    join assistant_batches batch on booking.id = any(batch.booking_ids)
    join assistant_sessions session on session.id = batch.session_id
    where session.is_demo and session.fleet = 'splrt' and booking.status = 'proposed'
  loop
    perform cancel_maintenance_booking(v_id, 'Demo reset');
  end loop;
  delete from assistant_sessions where is_demo and fleet = 'splrt';
  perform reset_dashboard_demo_before_assistant();
end;
$$;
revoke all on function reset_dashboard_demo() from public;
grant execute on function reset_dashboard_demo() to anon, authenticated;

-- Release abandoned drafts even when no operator opens the chat again. Retain
-- only seven days of conversations and thirty days of audit/rate-limit data.
create function assistant_housekeeping()
returns void language plpgsql security definer set search_path = public
as $$
begin
  perform assistant_expire_proposals();
  delete from assistant_sessions where expires_at < now() - interval '7 days';
  delete from assistant_audit where created_at < now() - interval '30 days';
end;
$$;
revoke all on function assistant_housekeeping() from public, anon, authenticated;
grant execute on function assistant_housekeeping() to service_role;
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('maintenance-assistant-housekeeping', '*/5 * * * *', 'select public.assistant_housekeeping()');

notify pgrst, 'reload schema';
commit;
