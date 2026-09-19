begin;
-- A maintenance status can describe a reserved future depot visit. The booking
-- start time already guards work in progress; permit future visits to move.
-- Faulty vehicles still require their corrective repair workflow.
create or replace function assistant_write_reschedule(p_fleet text, p_bookings jsonb, p_snapshot jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare item jsonb; original maintenance_bookings%rowtype; ids uuid[]; starts timestamptz; ends timestamptz;
begin
  if jsonb_typeof(p_bookings) is distinct from 'array' or jsonb_array_length(p_bookings) not between 1 and 12 then
    raise exception 'A reschedule must contain 1 to 12 bookings';
  end if;
  select array_agg((value->>'bookingId')::uuid) into ids from jsonb_array_elements(p_bookings);
  if (select count(distinct x) from unnest(ids) x) <> cardinality(ids) or array_position(ids,null) is not null then
    raise exception 'Each source booking must be selected exactly once';
  end if;
  perform 1 from vehicles where lrv_id in (select lrv_id from maintenance_bookings where id=any(ids)) order by lrv_id for update;
  perform pg_advisory_xact_lock(hashtextextended('maintenance:' || p_fleet,0));
  perform 1 from maintenance_bookings where id=any(ids) order by id for update;
  for item in select * from jsonb_array_elements(p_bookings) loop
    select * into original from maintenance_bookings where id=(item->>'bookingId')::uuid;
    if not found or original.status <> 'confirmed' or original.start_at <= now() then
      raise exception 'Only confirmed bookings that have not started can be rescheduled';
    end if;
    if not exists(select 1 from jsonb_array_elements(p_snapshot) s where s=to_jsonb(original)) then
      raise exception 'A source booking changed. Request a fresh reschedule';
    end if;
    if not exists(select 1 from vehicles where lrv_id=original.lrv_id and fleet=p_fleet) then
      raise exception 'Vehicle is outside the session fleet';
    end if;
    if original.work_type='preventive' and exists(select 1 from vehicles where lrv_id=original.lrv_id and status = 'faulty') then
      raise exception 'Vehicle is not available for preventive rescheduling';
    end if;
    if item->>'lrvId' is distinct from original.lrv_id
      or item->>'workType' is distinct from original.work_type
      or (item->>'primaryCycle')::integer is distinct from original.primary_cycle
      or coalesce(item->'bundledCycles','[]') is distinct from to_jsonb(coalesce(original.bundled_cycles,'{}'))
      or (item->>'faultId')::uuid is distinct from original.fault_id
      or item->>'notes' is distinct from original.notes then
      raise exception 'Rescheduling must preserve vehicle, maintenance scope, fault and notes';
    end if;
    starts := (item->>'startAt')::timestamptz; ends := (item->>'endAt')::timestamptz;
    if starts is null or ends is null or starts < now() or (starts at time zone 'Asia/Singapore')::date > (now() at time zone 'Asia/Singapore')::date+42
      or ends-starts is distinct from original.end_at-original.start_at then
      raise exception 'Reschedule must preserve duration and start within the next 42 days';
    end if;
  end loop;
  -- All sources leave the exclusion index together, enabling swaps. These
  -- intermediate rows are never committed or visible outside this transaction.
  update maintenance_bookings set status='cancelled' where id=any(ids);
  for item in select * from jsonb_array_elements(p_bookings) loop
    update maintenance_bookings set status='proposed',bay_id=item->>'bayId',
      start_at=(item->>'startAt')::timestamptz,end_at=(item->>'endAt')::timestamptz
      where id=(item->>'bookingId')::uuid;
  end loop;
  for original in select * from maintenance_bookings where id=any(ids) order by id loop
    if exists(select 1 from maintenance_bookings b where b.id<>original.id
      and b.bay_id=original.bay_id and b.status in ('proposed','confirmed')
      and tstzrange(b.start_at-interval '30 minutes',b.end_at+interval '30 minutes','[)')
        && tstzrange(original.start_at,original.end_at,'[)')) then
      raise exception 'Reschedule must preserve a 30-minute bay turnaround buffer';
    end if;
    perform assistant_validate_slot(original.lrv_id,original.bay_id,original.start_at,original.end_at,original.id);
    perform schedule_maintenance(original.lrv_id,original.primary_cycle,original.bundled_cycles,original.bay_id,
      original.start_at,original.end_at,'confirmed',original.notes,original.id,original.work_type,original.fault_id);
  end loop;
end $$;
notify pgrst, 'reload schema';
commit;
