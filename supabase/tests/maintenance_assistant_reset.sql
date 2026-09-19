-- Full reset is exercised transactionally; the live demo is restored by rollback.
begin;
do $$
declare demo uuid:=gen_random_uuid(); real_session uuid:=gen_random_uuid(); old_demo_id bigint;
begin
  insert into assistant_sessions(id,token_hash,is_demo,fleet) values(demo,repeat('a',64),true,'splrt'),(real_session,repeat('b',64),false,'splrt');
  insert into assistant_audit(session_id,event,details,created_at) values(demo,'turn_reserved','{}',now()-interval '23 hours') returning id into old_demo_id;
  insert into assistant_audit(session_id,event,details) values(demo,'session_created','{}'),(real_session,'turn_reserved','{}'),(real_session,'session_created','{}');
  perform reset_dashboard_demo();
  assert not exists(select 1 from assistant_sessions where id=demo),'Demo session survived reset';
  assert exists(select 1 from assistant_sessions where id=real_session),'Non-demo session was removed';
  assert exists(select 1 from assistant_audit where id=old_demo_id and event='turn_reserved_reset'),'Rolling demo allowance was not cleared';
  assert (select count(*) from assistant_audit where session_id=real_session and event in ('turn_reserved','session_created'))=2,'Non-demo usage changed';
end $$;
rollback;
