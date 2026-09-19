begin;

create or replace function assistant_reserve_turn(p_session_id uuid, p_actor_hash text)
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
      and session_id = p_session_id and created_at > now() - interval '1 hour') >= 100
     or (select count(*) from assistant_audit where event = 'turn_reserved'
      and details->>'actorHash' = p_actor_hash and created_at > now() - interval '24 hours') >= 500
     or (select count(*) from assistant_audit where event = 'turn_reserved'
      and created_at > now() - interval '24 hours') >= 2000 then
    raise exception 'Assistant usage limit reached. Please try again later';
  end if;
  update assistant_sessions set busy_until = now() + interval '90 seconds' where id = p_session_id;
  insert into assistant_audit(session_id, event, details)
    values (p_session_id, 'turn_reserved', jsonb_build_object('actorHash', p_actor_hash));
  return true;
end;
$$;

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
  -- Clear the entire rolling allowance, including yesterday's still-counted
  -- requests. Preserve the audit history under non-counting event names.
  perform pg_advisory_xact_lock(hashtextextended('maintenance-assistant:budget',0));
  update assistant_audit a set event=a.event || '_reset',
    details=a.details || jsonb_build_object('resetAt',now())
    from assistant_sessions s where a.session_id=s.id and s.is_demo and s.fleet='splrt'
      and a.event in ('turn_reserved','session_created');
  delete from assistant_sessions where is_demo and fleet='splrt';
  perform reset_dashboard_demo_before_assistant();
end $$;

notify pgrst,'reload schema';
commit;
