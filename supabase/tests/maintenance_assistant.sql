-- Run after the migration. Everything rolls back, including these isolated
-- synthetic fixtures. No production fleet or booking is changed.
begin;
create function pg_temp.expect_error(p_sql text, p_contains text) returns void language plpgsql as $$
declare v_failed boolean := false;
begin
  begin execute p_sql;
  exception when others then
    if position(p_contains in sqlerrm) = 0 then raise exception 'Unexpected error: % (wanted %)', sqlerrm, p_contains; end if;
    v_failed := true;
  end;
  if not v_failed then raise exception 'Expected rejection containing: %', p_contains; end if;
end $$;

do $$
declare
  s uuid := gen_random_uuid(); s2 uuid := gen_random_uuid(); r uuid := gen_random_uuid();
  fault1 uuid := gen_random_uuid(); fault2 uuid := gen_random_uuid();
  b jsonb; retry jsonb; input jsonb; one jsonb; draft jsonb; old_count integer;
  tomorrow timestamptz := (((now() at time zone 'Asia/Singapore')::date + 1 + time '08:00') at time zone 'Asia/Singapore');
begin
  assert not has_table_privilege('anon', 'assistant_sessions', 'SELECT'), 'Anonymous session read';
  assert not has_table_privilege('authenticated', 'assistant_messages', 'SELECT'), 'Authenticated conversation read';
  assert not has_function_privilege('anon', 'assistant_save_proposal(uuid,uuid,jsonb)', 'EXECUTE'), 'Anonymous proposal write';
  assert not has_function_privilege('authenticated', 'assistant_resolve_proposal(uuid,uuid,text)', 'EXECUTE'), 'Client bypasses confirmation endpoint';
  assert has_function_privilege('service_role', 'assistant_resolve_proposal(uuid,uuid,text)', 'EXECUTE');
  insert into vehicles(lrv_id, fleet, type, status) values
    ('ZZ-AI1', '__assistant_test', 'test', 'in_service'), ('ZZ-AI2', '__assistant_test', 'test', 'in_service'),
    ('ZZ-AI3', '__assistant_test', 'test', 'in_service'), ('ZZ-AI4', '__assistant_test', 'test', 'in_service');
  insert into planning_settings(fleet, minimum_service_vehicles) values ('__assistant_test', 2);
  insert into depot_bays(bay_id,fleet,name,bay_type,opens_at,closes_at) values
    ('ZZ-AIB1','__assistant_test','Test1','universal','06:00','23:00'),
    ('ZZ-AIB2','__assistant_test','Test2','universal','06:00','23:00');
  insert into maintenance_cycle_rules(fleet,cycle_type,threshold_km,duration_minutes,compatible_bay_type,included_cycles)
    values ('__assistant_test',2000,2000,120,'routine',array[2000]);
  insert into cycle_state(lrv_id,cycle_type,km_since,km_to_next) values ('ZZ-AI3',2000,2000,0);
  insert into maintenance_faults(id,lrv_id,fault_code,description,estimated_duration_minutes,required_bay_type)
    values (fault1,'ZZ-AI1','TEST','Synthetic brake repair',120,'routine'),
      (fault2,'ZZ-AI2','TEST','Synthetic control repair',120,'routine');
  insert into assistant_sessions(id,token_hash,fleet,is_demo) values
    (s,repeat('a',64),'__assistant_test',false),(s2,repeat('b',64),'__assistant_test',false);
  one := jsonb_build_object('lrvId','ZZ-AI1','workType','corrective','faultId',fault1,'primaryCycle',null,
    'bundledCycles','[]'::jsonb,'bayId','ZZ-AIB1','startAt',tomorrow,'endAt',tomorrow+interval '2 hours','notes','Test');
  input := jsonb_build_array(one);
  b := assistant_save_proposal(s,r,input);
  retry := assistant_save_proposal(s,r,input);
  assert b->>'id' = retry->>'id', 'Retry duplicated a batch';
  assert (select count(*) from maintenance_bookings where lrv_id='ZZ-AI1') = 1, 'Retry duplicated a booking';
  assert (select status from maintenance_bookings where id=(b->'booking_ids'->>0)::uuid) = 'proposed';
  perform pg_temp.expect_error(format('select assistant_save_proposal(%L,%L,%L)',s,r,jsonb_build_array(one||'{"notes":"different"}')), 'different proposal');
  perform pg_temp.expect_error(format('select assistant_save_proposal(%L,%L,%L)',s,gen_random_uuid(),input), 'existing proposal');
  perform pg_temp.expect_error(format('select assistant_save_proposal(%L,%L,%L)',s2,gen_random_uuid(),input), 'active maintenance visit');
  perform pg_temp.expect_error(format('select assistant_resolve_proposal(%L,%L,''confirm'')',s2,b->>'id'), 'does not belong');
  perform pg_temp.expect_error(format('select assistant_resolve_proposal(%L,%L,''execute_sql'')',s,b->>'id'), 'Unsupported');
  retry := assistant_resolve_proposal(s,(b->>'id')::uuid,'confirm');
  assert retry->>'status'='confirmed';
  retry := assistant_resolve_proposal(s,(b->>'id')::uuid,'confirm');
  assert retry->>'status'='confirmed', 'Confirmation is not idempotent';

  -- Atomic batch rejects its second conflicting item without saving the first.
  one := one || jsonb_build_object('lrvId','ZZ-AI2','faultId',fault2,'startAt',tomorrow+interval '1 day','endAt',tomorrow+interval '1 day 2 hours');
  draft := jsonb_build_object('lrvId','ZZ-AI3','workType','preventive','primaryCycle',2000,
    'bundledCycles',jsonb_build_array(2000),'bayId','ZZ-AIB1','startAt',tomorrow+interval '1 day','endAt',tomorrow+interval '1 day 2 hours');
  select count(*) into old_count from maintenance_bookings;
  perform pg_temp.expect_error(format('select assistant_save_proposal(%L,%L,%L)',s,gen_random_uuid(),jsonb_build_array(one,draft)), 'turnaround');
  assert (select count(*) from maintenance_bookings)=old_count, 'Partial proposal escaped a failed transaction';
  assert (select status from maintenance_faults where id=fault2)='open', 'Failed proposal changed fault';

  -- Duration, bay/fleet, past, lunch, budget and cycle-reset checks.
  perform pg_temp.expect_error(format('select assistant_save_proposal(%L,%L,%L)',s,gen_random_uuid(),jsonb_build_array(one||jsonb_build_object('startAt',now()-interval '1 hour'))), 'past');
  perform pg_temp.expect_error(format('select assistant_save_proposal(%L,%L,%L)',s,gen_random_uuid(),jsonb_build_array(one||jsonb_build_object('endAt',tomorrow+interval '1 day 1 hour'))), 'shorter');
  perform pg_temp.expect_error(format('select assistant_save_proposal(%L,%L,%L)',s,gen_random_uuid(),jsonb_build_array(one||jsonb_build_object('startAt',tomorrow+interval '1 day 3 hours','endAt',tomorrow+interval '1 day 5 hours'))), 'lunch');
  perform pg_temp.expect_error(format('select assistant_save_proposal(%L,%L,%L)',s,gen_random_uuid(),jsonb_build_array(one||'{"lrvId":"D12"}')), 'outside the session fleet');
  update planning_settings set minimum_service_vehicles=4 where fleet='__assistant_test';
  perform pg_temp.expect_error(format('select assistant_save_proposal(%L,%L,%L)',s,gen_random_uuid(),jsonb_build_array(one)), 'service minimum');
  update planning_settings set minimum_service_vehicles=2 where fleet='__assistant_test';
  b := assistant_save_proposal(s,gen_random_uuid(),jsonb_build_array(draft));
  update cycle_state set km_since=0,km_to_next=2000 where lrv_id='ZZ-AI3';
  perform pg_temp.expect_error(format('select assistant_resolve_proposal(%L,%L,''confirm'')',s,b->>'id'), 'cycles changed');
  retry := assistant_resolve_proposal(s,(b->>'id')::uuid,'discard');
  assert retry->>'status'='discarded';
  retry := assistant_resolve_proposal(s,(b->>'id')::uuid,'discard');
  assert retry->>'status'='discarded';
  assert (select status from maintenance_bookings where id=(b->'booking_ids'->>0)::uuid)='cancelled';

  b := assistant_save_proposal(s,gen_random_uuid(),jsonb_build_array(one));
  update assistant_batches set expires_at=now()-interval '1 minute' where id=(b->>'id')::uuid;
  perform pg_temp.expect_error(format('select assistant_resolve_proposal(%L,%L,''confirm'')',s,b->>'id'), 'expired');
  perform assistant_expire_proposals();
  assert (select status from assistant_batches where id=(b->>'id')::uuid)='discarded';
  assert (select status from maintenance_faults where id=fault2)='open';

  -- A changed booking cannot silently replace the proposal that was reviewed.
  b := assistant_save_proposal(s,gen_random_uuid(),jsonb_build_array(one));
  update maintenance_bookings set notes='Changed elsewhere' where id=(b->'booking_ids'->>0)::uuid;
  perform pg_temp.expect_error(format('select assistant_resolve_proposal(%L,%L,''confirm'')',s,b->>'id'), 'booking changed');
  perform assistant_resolve_proposal(s,(b->>'id')::uuid,'discard');

  -- Confirmation is one transaction: a late duty on the second vehicle rolls
  -- back the first confirmation instead of leaving a partly green batch.
  update cycle_state set km_since=2000,km_to_next=0 where lrv_id='ZZ-AI3';
  draft := draft || '{"bayId":"ZZ-AIB2"}'::jsonb;
  b := assistant_save_proposal(s,gen_random_uuid(),jsonb_build_array(one,draft));
  insert into duty_assignments(lrv_id,loop_id,slot_label,duty_start,duty_end,status)
    values ('ZZ-AI3','TEST','TEST',tomorrow+interval '1 day',tomorrow+interval '1 day 2 hours','planned');
  perform pg_temp.expect_error(format('select assistant_resolve_proposal(%L,%L,''confirm'')',s,b->>'id'), 'operating duty');
  assert (select count(*) from maintenance_bookings where id in
    (select value::uuid from jsonb_array_elements_text(b->'booking_ids')) and status='proposed')=2, 'Partial confirmation escaped rollback';
  perform assistant_resolve_proposal(s,(b->>'id')::uuid,'discard');

  perform assistant_reserve_turn(s, repeat('c',64));
  perform pg_temp.expect_error(format('select assistant_reserve_turn(%L,%L)',s,repeat('c',64)), 'still running');
  update assistant_sessions set busy_until=null where id=s;
  insert into assistant_audit(session_id,event,details)
    select s,'turn_reserved',jsonb_build_object('actorHash',repeat('c',64)) from generate_series(1,99);
  perform pg_temp.expect_error(format('select assistant_reserve_turn(%L,%L)',s,repeat('c',64)), 'usage limit');
  insert into assistant_audit(session_id,event,details)
    select s,'turn_reserved',jsonb_build_object('actorHash',repeat('d',64)) from generate_series(1,500);
  perform pg_temp.expect_error(format('select assistant_reserve_turn(%L,%L)',s2,repeat('d',64)), 'usage limit');
  insert into assistant_audit(session_id,event,details)
    select s,'turn_reserved',jsonb_build_object('actorHash',repeat('e',64)) from generate_series(1,2000);
  perform pg_temp.expect_error(format('select assistant_reserve_turn(%L,%L)',s2,repeat('f',64)), 'usage limit');
  update assistant_sessions set expires_at=now()-interval '1 second' where id=s2;
  perform pg_temp.expect_error(format('select assistant_reserve_turn(%L,%L)',s2,repeat('d',64)), 'session expired');
  raise notice 'Maintenance assistant database tests passed';
end $$;
rollback;
