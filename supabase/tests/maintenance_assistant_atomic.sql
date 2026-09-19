-- Run after 202609190003. Isolated fixtures; all writes roll back.
begin;
create function pg_temp.atomic_expect_error(p_sql text, p_contains text) returns void language plpgsql as $$
declare v_failed boolean := false;
begin
  begin execute p_sql;
  exception when others then
    if position(p_contains in sqlerrm) = 0 then raise exception 'Unexpected error: % (wanted %)', sqlerrm,p_contains; end if;
    v_failed := true;
  end;
  if not v_failed then raise exception 'Expected rejection containing %',p_contains; end if;
end $$;
create function pg_temp.reject_test_metadata() returns trigger language plpgsql as $$
begin
  if new.metadata->>'atomicTest'='force_failure' then raise exception 'Synthetic metadata write failure'; end if;
  return new;
end $$;
create trigger assistant_test_metadata_failure before update of metadata on assistant_batches
for each row execute function pg_temp.reject_test_metadata();

do $$
declare s uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); fault uuid:=gen_random_uuid();
  session_result jsonb; b jsonb; retry jsonb; input jsonb; metadata jsonb;
  actor text := md5(gen_random_uuid()::text); old_count integer;
  tomorrow timestamptz := (((now() at time zone 'Asia/Singapore')::date+1+time '08:00') at time zone 'Asia/Singapore');
begin
  assert not has_function_privilege('anon','assistant_store_proposal(uuid,uuid,jsonb,jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','assistant_create_session(uuid,text,uuid,boolean,text)','EXECUTE');
  assert not has_function_privilege('anon','assistant_apply_proposal(uuid,uuid,text)','EXECUTE');
  session_result := assistant_create_session(s,repeat('a',64),null,true,actor);
  retry := assistant_create_session(s,repeat('b',64),null,true,actor);
  assert retry->>'token_hash'=repeat('a',64), 'Replay replaced session capability';
  assert (select count(*) from assistant_audit where session_id=s and event='session_created')=1, 'Replay consumed another session';
  perform pg_temp.atomic_expect_error(format('select assistant_create_session(%L,%L,null,false,%L)',gen_random_uuid(),repeat('a',64),actor),'owner is required');
  insert into assistant_audit(event,details)
    select 'session_created',jsonb_build_object('actorHash',actor) from generate_series(1,19);
  perform pg_temp.atomic_expect_error(format('select assistant_create_session(%L,%L,null,true,%L)',gen_random_uuid(),repeat('a',64),actor),'creation limit');

  insert into vehicles(lrv_id,fleet,type,status) values ('ZZ-AT1','__assistant_atomic','test','in_service');
  insert into planning_settings(fleet,minimum_service_vehicles) values ('__assistant_atomic',0);
  insert into depot_bays(bay_id,fleet,name,bay_type,opens_at,closes_at)
    values ('ZZ-ATB','__assistant_atomic','Atomic test','universal','06:00','23:00');
  insert into maintenance_faults(id,lrv_id,fault_code,description,estimated_duration_minutes,required_bay_type)
    values(fault,'ZZ-AT1','TEST','Synthetic atomic test',120,'routine');
  update assistant_sessions set fleet='__assistant_atomic' where id=s;
  input := jsonb_build_array(jsonb_build_object('lrvId','ZZ-AT1','workType','corrective','primaryCycle',null,
    'bundledCycles','[]'::jsonb,'faultId',fault,'bayId','ZZ-ATB','startAt',tomorrow,'endAt',tomorrow+interval '2 hours'));
  metadata := jsonb_build_object('plan',jsonb_build_object('bookings',input,'summary','Synthetic test'),'constraints','{}'::jsonb);
  select count(*) into old_count from maintenance_bookings;
  perform pg_temp.atomic_expect_error(format('select assistant_store_proposal(%L,%L,%L,%L)',s,r,input,'{}'),'exact reviewed booking plan');
  perform pg_temp.atomic_expect_error(format('select assistant_store_proposal(%L,%L,%L,%L)',s,r,input,metadata||'{"atomicTest":"force_failure"}'),'metadata write failure');
  assert (select count(*) from maintenance_bookings)=old_count, 'Bookings survived failed metadata commit';
  assert not exists(select 1 from assistant_batches where session_id=s), 'Batch survived failed metadata commit';
  assert (select status from maintenance_faults where id=fault)='open', 'Fault changed after failed metadata commit';

  b := assistant_store_proposal(s,r,input,metadata);
  assert b->'metadata'=metadata, 'Stored plan missing';
  assert not(b ? 'booking_snapshot') and not(b ? 'cycle_snapshot') and not(b ? 'request_hash'), 'Internal fields leaked';
  retry := assistant_store_proposal(s,r,input,metadata);
  assert b->>'id'=retry->>'id';
  perform pg_temp.atomic_expect_error(format('select assistant_store_proposal(%L,%L,%L,%L)',s,r,input,metadata||'{"different":true}'),'different proposal metadata');
  assert (select batch.metadata from assistant_batches batch where id=(b->>'id')::uuid)=metadata;
  update assistant_sessions set busy_until=now()+interval '1 minute' where id=s;
  perform pg_temp.atomic_expect_error(format('select assistant_apply_proposal(%L,%L,''confirm'')',s,b->>'id'),'still running');
  update assistant_sessions set busy_until=null where id=s;
  retry := assistant_apply_proposal(s,(b->>'id')::uuid,'confirm');
  assert retry->>'status'='confirmed';
  retry := assistant_apply_proposal(s,(b->>'id')::uuid,'confirm');
  assert retry->>'status'='confirmed';
  raise notice 'Atomic assistant wrapper tests passed';
end $$;
drop trigger assistant_test_metadata_failure on assistant_batches;
rollback;
