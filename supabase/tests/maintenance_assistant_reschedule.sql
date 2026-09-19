-- Apply migration 004 first. Isolated synthetic fleet; every write rolls back.
begin;
create function pg_temp.reschedule_expect_error(sql text, expected text) returns void language plpgsql as $$
declare failed boolean:=false;
begin
  begin execute sql; exception when others then
    if position(expected in sqlerrm)=0 then raise exception 'Unexpected: % (expected %)',sqlerrm,expected; end if;
    failed:=true;
  end;
  assert failed,'Expected rejection';
end $$;
create function pg_temp.reschedule_input(ids uuid[], destination text) returns jsonb language sql as $$
select jsonb_agg(jsonb_build_object('bookingId',id,'lrvId',lrv_id,'workType',work_type,'primaryCycle',primary_cycle,
  'bundledCycles',coalesce(bundled_cycles,'{}'),'faultId',fault_id,'notes',notes,'bayId',coalesce(destination,case when bay_id='ZZ-RB1' then 'ZZ-RB2' else 'ZZ-RB1' end),
  'startAt',start_at,'endAt',end_at,'original',jsonb_build_object('id',id,'bayId',bay_id,'startAt',start_at,'endAt',end_at,'updatedAt',updated_at)) order by id)
from maintenance_bookings where id=any(ids)
$$;
create function pg_temp.reschedule_metadata(input jsonb) returns jsonb language sql as $$
select jsonb_build_object('kind','reschedule','plan',jsonb_build_object('kind','reschedule','bookings',input))
$$;
do $$
declare s uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); b1 uuid; b2 uuid; batch jsonb; input jsonb; before_rows jsonb; after_rows jsonb;
  day timestamptz:=(((now() at time zone 'Asia/Singapore')::date+2+time '06:00') at time zone 'Asia/Singapore');
begin
  assert not has_function_privilege('anon','assistant_store_reschedule(uuid,uuid,jsonb,jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','assistant_write_reschedule(text,jsonb,jsonb)','EXECUTE');
  insert into vehicles(lrv_id,fleet,type,status) values('ZZ-R1','__reschedule','test','in_service'),('ZZ-R2','__reschedule','test','in_service');
  insert into planning_settings(fleet,minimum_service_vehicles) values('__reschedule',0);
  insert into depot_bays(bay_id,fleet,name,bay_type,opens_at,closes_at) values('ZZ-RB1','__reschedule','First','universal','06:00','23:00'),('ZZ-RB2','__reschedule','Second','universal','06:00','23:00');
  insert into maintenance_cycle_rules(fleet,cycle_type,threshold_km,duration_minutes,compatible_bay_type,included_cycles)
    values('__reschedule',2000,2000,120,'routine',array[2000]);
  insert into assistant_sessions(id,token_hash,fleet) values(s,repeat('a',64),'__reschedule');
  b1:=schedule_maintenance('ZZ-R1',2000,array[2000],'ZZ-RB1',day,day+interval '2 hours','confirmed','Keep first note');
  b2:=schedule_maintenance('ZZ-R2',2000,array[2000],'ZZ-RB1',day+interval '3 hours',day+interval '5 hours','confirmed','Keep second note');
  select jsonb_agg(to_jsonb(b) order by id) into before_rows from maintenance_bookings b where id in(b1,b2);
  input:=pg_temp.reschedule_input(array[b1,b2],'ZZ-RB2');
  batch:=assistant_store_reschedule(s,r,input,pg_temp.reschedule_metadata(input));
  assert (assistant_store_reschedule(s,r,input,pg_temp.reschedule_metadata(input))->>'id')=batch->>'id','Retry changed batch';
  select jsonb_agg(to_jsonb(b) order by id) into after_rows from maintenance_bookings b where id in(b1,b2);
  assert before_rows=after_rows,'Preview mutated confirmed booking';
  perform assistant_apply_proposal(s,(batch->>'id')::uuid,'discard');
  select jsonb_agg(to_jsonb(b) order by id) into after_rows from maintenance_bookings b where id in(b1,b2);
  assert before_rows=after_rows,'Discard mutated confirmed booking';
  batch:=assistant_store_reschedule(s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input));
  perform assistant_apply_proposal(s,(batch->>'id')::uuid,'confirm');
  perform assistant_apply_proposal(s,(batch->>'id')::uuid,'confirm');
  assert (select count(*) from maintenance_bookings where id in(b1,b2) and status='confirmed' and bay_id='ZZ-RB2')=2,'Move failed';
  assert (select notes from maintenance_bookings where id=b1)='Keep first note';
  -- Destination conflict, no partial update and stale notes rejection.
  input:=pg_temp.reschedule_input(array[b1,b2],'ZZ-RB1');
  batch:=assistant_store_reschedule(s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input));
  update maintenance_bookings set notes='Operator edit' where id=b2;
  perform pg_temp.reschedule_expect_error(format('select assistant_apply_proposal(%L,%L,''confirm'')',s,batch->>'id'),'source booking changed');
  assert (select count(*) from maintenance_bookings where id in(b1,b2) and bay_id='ZZ-RB2' and status='confirmed')=2;
  perform assistant_apply_proposal(s,(batch->>'id')::uuid,'discard');
  -- Expiry never cancels the originals, even if another writer changes status.
  input:=pg_temp.reschedule_input(array[b1,b2],'ZZ-RB1');
  batch:=assistant_store_reschedule(s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input));
  update assistant_batches set expires_at=now()-interval '1 minute' where id=(batch->>'id')::uuid;
  update maintenance_bookings set status='proposed' where id=b2;
  perform assistant_expire_proposals();
  assert (select status from maintenance_bookings where id=b2)='proposed','Expiry cancelled source';
  update maintenance_bookings set status='confirmed' where id=b2;
  -- Swap destinations at identical times requires freeing both old slots.
  update maintenance_bookings set bay_id='ZZ-RB1',start_at=day,end_at=day+interval '2 hours' where id=b2;
  input:=pg_temp.reschedule_input(array[b1,b2],null);
  batch:=assistant_store_reschedule(s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input));
  perform assistant_apply_proposal(s,(batch->>'id')::uuid,'confirm');
  assert (select bay_id from maintenance_bookings where id=b1)='ZZ-RB1';
  assert (select bay_id from maintenance_bookings where id=b2)='ZZ-RB2';
  -- A target that collides is rejected and preserves both originals.
  input:=pg_temp.reschedule_input(array[b1],'ZZ-RB2');
  perform pg_temp.reschedule_expect_error(format('select assistant_store_reschedule(%L,%L,%L,%L)',s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input)),'exclusion constraint');
  assert (select bay_id from maintenance_bookings where id=b1)='ZZ-RB1';
  -- Scope, duration, crew lunch, turnaround and service-floor guards.
  input:=pg_temp.reschedule_input(array[b1],'ZZ-RB1');
  input:=jsonb_set(input,'{0,startAt}',to_jsonb(day+interval '5 hours'));
  input:=jsonb_set(input,'{0,endAt}',to_jsonb(day+interval '7 hours'));
  perform pg_temp.reschedule_expect_error(format('select assistant_store_reschedule(%L,%L,%L,%L)',s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input)),'lunch break');
  input:=pg_temp.reschedule_input(array[b1],'ZZ-RB2');
  input:=jsonb_set(input,'{0,startAt}',to_jsonb(day+interval '2 hours 15 minutes'));
  input:=jsonb_set(input,'{0,endAt}',to_jsonb(day+interval '4 hours 15 minutes'));
  perform pg_temp.reschedule_expect_error(format('select assistant_store_reschedule(%L,%L,%L,%L)',s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input)),'turnaround buffer');
  input:=pg_temp.reschedule_input(array[b1],'ZZ-RB1');
  input:=jsonb_set(input,'{0,notes}','"Unapproved scope edit"');
  perform pg_temp.reschedule_expect_error(format('select assistant_store_reschedule(%L,%L,%L,%L)',s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input)),'preserve vehicle');
  input:=pg_temp.reschedule_input(array[b1],'ZZ-RB1');
  input:=jsonb_set(input,'{0,endAt}',to_jsonb(day+interval '1 hour'));
  perform pg_temp.reschedule_expect_error(format('select assistant_store_reschedule(%L,%L,%L,%L)',s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input)),'preserve duration');
  input:=pg_temp.reschedule_input(array[b1],'ZZ-RB1');
  batch:=assistant_store_reschedule(s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input));
  update planning_settings set minimum_service_vehicles=1 where fleet='__reschedule';
  perform pg_temp.reschedule_expect_error(format('select assistant_apply_proposal(%L,%L,''confirm'')',s,batch->>'id'),'service minimum');
  assert (select status from maintenance_bookings where id=b1)='confirmed','Failed confirmation changed source';
  update planning_settings set minimum_service_vehicles=0 where fleet='__reschedule';
  insert into duty_assignments(lrv_id,loop_id,slot_label,duty_start,duty_end) values('ZZ-R1','test','test',day,day+interval '2 hours');
  perform pg_temp.reschedule_expect_error(format('select assistant_apply_proposal(%L,%L,''confirm'')',s,batch->>'id'),'operating duty');
  delete from duty_assignments where lrv_id='ZZ-R1';
  perform assistant_apply_proposal(s,(batch->>'id')::uuid,'discard');
  -- Already-started bookings cannot move.
  update maintenance_bookings set start_at=day-interval '3 days',end_at=day-interval '3 days'+interval '2 hours' where id=b1;
  input:=pg_temp.reschedule_input(array[b1],'ZZ-RB2');
  perform pg_temp.reschedule_expect_error(format('select assistant_store_reschedule(%L,%L,%L,%L)',s,gen_random_uuid(),input,pg_temp.reschedule_metadata(input)),'have not started');
  raise notice 'Reschedule rollback tests passed: preview, discard, expiry, atomic moves, swap, conflict, stale, past, replay, grants';
end $$;
rollback;
