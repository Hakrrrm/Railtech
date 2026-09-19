begin;

-- One transactional validator/writer serves previews and final approval. Preview
-- callers run it in a rolled-back subtransaction; no reservation is released.
create function assistant_write_reschedule(p_fleet text, p_bookings jsonb, p_snapshot jsonb)
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
    if original.work_type='preventive' and exists(select 1 from vehicles where lrv_id=original.lrv_id and status in ('faulty','maintenance')) then
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

create function assistant_store_reschedule(p_session_id uuid,p_request_id uuid,p_bookings jsonb,p_metadata jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare session assistant_sessions%rowtype; batch assistant_batches%rowtype; snapshot jsonb; ids uuid[]; item jsonb; original maintenance_bookings%rowtype;
begin
  select * into session from assistant_sessions where id=p_session_id for update;
  if not found or session.expires_at<=now() then raise exception 'Assistant session expired'; end if;
  if p_request_id is null then raise exception 'Proposal request ID is required'; end if;
  if jsonb_typeof(p_metadata) is distinct from 'object' or octet_length(p_metadata::text)>128000
    or p_metadata->>'kind' is distinct from 'reschedule' or p_metadata->'plan'->>'kind' is distinct from 'reschedule'
    or p_metadata->'plan'->'bookings' is distinct from p_bookings then
    raise exception 'Reschedule metadata must contain the exact reviewed booking plan';
  end if;
  select * into batch from assistant_batches where session_id=p_session_id and request_id=p_request_id;
  if found then
    if batch.request_hash<>md5(p_bookings::text) or batch.metadata<>p_metadata then raise exception 'Request ID already used for a different proposal'; end if;
    return to_jsonb(batch)-'request_hash'-'cycle_snapshot'-'booking_snapshot';
  end if;
  if exists(select 1 from assistant_batches where session_id=p_session_id and status='proposed') then
    raise exception 'Confirm or discard the existing proposal before creating another';
  end if;
  if jsonb_typeof(p_bookings) is distinct from 'array' or jsonb_array_length(p_bookings) not between 1 and 12 then
    raise exception 'A reschedule must contain 1 to 12 bookings';
  end if;
  select array_agg((value->>'bookingId')::uuid) into ids from jsonb_array_elements(p_bookings);
  perform 1 from vehicles where lrv_id in (select lrv_id from maintenance_bookings where id=any(ids)) order by lrv_id for update;
  perform pg_advisory_xact_lock(hashtextextended('maintenance:' || session.fleet,0));
  perform 1 from maintenance_bookings where id=any(ids) order by id for update;
  for item in select * from jsonb_array_elements(p_bookings) loop
    select * into original from maintenance_bookings where id=(item->>'bookingId')::uuid;
    if not found or (item->'original'->>'id')::uuid is distinct from original.id
      or item->'original'->>'bayId' is distinct from original.bay_id
      or (item->'original'->>'startAt')::timestamptz is distinct from original.start_at
      or (item->'original'->>'endAt')::timestamptz is distinct from original.end_at
      or (item->'original'->>'updatedAt')::timestamptz is distinct from original.updated_at then
      raise exception 'A source booking changed. Request a fresh reschedule';
    end if;
  end loop;
  select jsonb_agg(to_jsonb(b) order by b.id) into snapshot from maintenance_bookings b where id=any(ids);
  begin
    perform assistant_write_reschedule(session.fleet,p_bookings,snapshot);
    raise exception using errcode='PZ001',message='Validated preview rollback';
  exception when sqlstate 'PZ001' then null;
  end;
  insert into assistant_batches(session_id,request_id,booking_ids,request_hash,booking_snapshot,metadata)
    values(p_session_id,p_request_id,ids,md5(p_bookings::text),snapshot,p_metadata) returning * into batch;
  insert into assistant_audit(session_id,event,details) values(p_session_id,'reschedule_proposed',jsonb_build_object('batchId',batch.id,'bookingIds',ids));
  return to_jsonb(batch)-'request_hash'-'cycle_snapshot'-'booking_snapshot';
end $$;

create function assistant_resolve_reschedule(p_session_id uuid,p_batch_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare session assistant_sessions%rowtype; batch assistant_batches%rowtype;
begin
  if p_action is null or p_action not in ('confirm','discard') then raise exception 'Unsupported proposal action'; end if;
  select * into session from assistant_sessions where id=p_session_id for update;
  if not found or session.expires_at<=now() then raise exception 'Assistant session expired'; end if;
  select * into batch from assistant_batches where id=p_batch_id and session_id=p_session_id for update;
  if not found or batch.metadata->>'kind' is distinct from 'reschedule' then raise exception 'Reschedule does not belong to this session'; end if;
  if (p_action='confirm' and batch.status='confirmed') or (p_action='discard' and batch.status='discarded') then
    return to_jsonb(batch)-'request_hash'-'cycle_snapshot'-'booking_snapshot';
  end if;
  if batch.status<>'proposed' then raise exception 'Proposal has already been resolved'; end if;
  if p_action='confirm' then
    if batch.expires_at<=now() then raise exception 'Proposal expired. Request a fresh reschedule'; end if;
    perform assistant_write_reschedule(session.fleet,batch.metadata->'plan'->'bookings',batch.booking_snapshot);
  end if;
  update assistant_batches set status=case when p_action='confirm' then 'confirmed' else 'discarded' end where id=batch.id returning * into batch;
  insert into assistant_audit(session_id,event,details) values(p_session_id,'reschedule_'||batch.status,jsonb_build_object('batchId',batch.id));
  return to_jsonb(batch)-'request_hash'-'cycle_snapshot'-'booking_snapshot';
end $$;

create or replace function assistant_apply_proposal(p_session_id uuid,p_batch_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare session assistant_sessions%rowtype;
begin
  select * into session from assistant_sessions where id=p_session_id for update;
  if not found or session.expires_at<=now() then raise exception 'Assistant session expired'; end if;
  if session.busy_until>now() then raise exception 'Another assistant turn is still running'; end if;
  if exists(select 1 from assistant_batches where id=p_batch_id and session_id=p_session_id and metadata->>'kind'='reschedule') then
    return assistant_resolve_reschedule(p_session_id,p_batch_id,p_action);
  end if;
  return assistant_resolve_proposal(p_session_id,p_batch_id,p_action);
end $$;

create or replace function assistant_expire_proposals()
returns integer language plpgsql security definer set search_path=public as $$
declare batch assistant_batches%rowtype; booking_id uuid; count_expired integer:=0;
begin
  for batch in select * from assistant_batches where status='proposed' and expires_at<=now() for update skip locked loop
    if batch.metadata->>'kind' is distinct from 'reschedule' then
      foreach booking_id in array batch.booking_ids loop
        perform 1 from maintenance_bookings where id=booking_id and status='proposed' for update;
        if found then perform cancel_maintenance_booking(booking_id,'Assistant draft expired before confirmation'); end if;
      end loop;
    end if;
    update assistant_batches set status='discarded' where id=batch.id;
    insert into assistant_audit(session_id,event,details) values(batch.session_id,'proposal_expired',jsonb_build_object('batchId',batch.id));
    count_expired:=count_expired+1;
  end loop;
  return count_expired;
end $$;

-- Reset cleans assistant-created drafts only. Reschedule batches reference
-- pre-existing bookings and must never turn those references into cancellation.
create or replace function reset_dashboard_demo()
returns void language plpgsql security definer set search_path=public as $$
declare booking_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('dashboard-demo-reset:splrt',0));
  for booking_id in select booking.id from maintenance_bookings booking
    join assistant_batches batch on booking.id=any(batch.booking_ids)
    join assistant_sessions session on session.id=batch.session_id
    where session.is_demo and session.fleet='splrt' and booking.status='proposed'
      and batch.metadata->>'kind' is distinct from 'reschedule'
  loop
    perform cancel_maintenance_booking(booking_id,'Demo reset');
  end loop;
  delete from assistant_sessions where is_demo and fleet='splrt';
  perform reset_dashboard_demo_before_assistant();
end $$;

revoke all on function assistant_write_reschedule(text,jsonb,jsonb),assistant_store_reschedule(uuid,uuid,jsonb,jsonb),assistant_resolve_reschedule(uuid,uuid,text) from public,anon,authenticated;
grant execute on function assistant_write_reschedule(text,jsonb,jsonb),assistant_store_reschedule(uuid,uuid,jsonb,jsonb),assistant_resolve_reschedule(uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
