begin;

-- Commit booking reservations and the exact operator-visible plan together.
-- A provider/HTTP failure after this transaction can replay the saved result.
create function assistant_store_proposal(p_session_id uuid, p_request_id uuid, p_bookings jsonb, p_metadata jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_saved jsonb; v_batch assistant_batches%rowtype;
begin
  if jsonb_typeof(p_metadata) is distinct from 'object' or octet_length(p_metadata::text) > 128000
     or jsonb_typeof(p_metadata->'plan') is distinct from 'object'
     or p_metadata->'plan'->'bookings' is distinct from p_bookings then
    raise exception 'Proposal metadata must contain the exact reviewed booking plan';
  end if;
  v_saved := assistant_save_proposal(p_session_id, p_request_id, p_bookings);
  select * into v_batch from assistant_batches where id = (v_saved->>'id')::uuid for update;
  if v_batch.metadata <> '{}'::jsonb and v_batch.metadata <> p_metadata then
    raise exception 'Request ID already used for different proposal metadata';
  end if;
  if v_batch.metadata = '{}'::jsonb then
    update assistant_batches set metadata = p_metadata where id = v_batch.id returning * into v_batch;
  end if;
  return to_jsonb(v_batch) - 'request_hash' - 'cycle_snapshot' - 'booking_snapshot';
end;
$$;

-- Session limits share the same transaction lock as paid-turn limits. This
-- prevents concurrent anonymous requests from racing a count-then-insert cap.
create function assistant_create_session(p_session_id uuid, p_token_hash text, p_owner_id uuid, p_is_demo boolean, p_actor_hash text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_session assistant_sessions%rowtype;
begin
  if p_session_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
      or p_is_demo is null or length(coalesce(p_actor_hash, '')) < 16 then
    raise exception 'Invalid assistant session identity';
  end if;
  if not p_is_demo and p_owner_id is null then raise exception 'Authenticated session owner is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maintenance-assistant:budget', 0));
  select * into v_session from assistant_sessions where id = p_session_id for update;
  -- The Edge Function compares capability hash and owner before returning any
  -- state. Return the immutable existing row; never reset or take it over.
  if found then return to_jsonb(v_session); end if;
  if (select count(*) from assistant_audit where event = 'session_created'
      and created_at > now() - interval '24 hours') >= 300
      or (select count(*) from assistant_audit where event = 'session_created'
        and details->>'actorHash' = p_actor_hash and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'Assistant session creation limit reached. Please try again later';
  end if;
  insert into assistant_sessions(id,token_hash,owner_id,fleet,is_demo)
    values (p_session_id,p_token_hash,p_owner_id,'splrt',p_is_demo) returning * into v_session;
  insert into assistant_audit(session_id,event,details)
    values (p_session_id,'session_created',jsonb_build_object('actorHash',p_actor_hash));
  return to_jsonb(v_session);
end;
$$;

-- Only the explicit operator endpoint calls this wrapper. Hold the session
-- lock across both the busy check and confirmation/discard to avoid a race
-- with a chat request acquiring its lease.
create function assistant_apply_proposal(p_session_id uuid, p_batch_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_session assistant_sessions%rowtype;
begin
  select * into v_session from assistant_sessions where id = p_session_id for update;
  if not found or v_session.expires_at <= now() then raise exception 'Assistant session expired'; end if;
  if v_session.busy_until > now() then raise exception 'Another assistant turn is still running'; end if;
  return assistant_resolve_proposal(p_session_id,p_batch_id,p_action);
end;
$$;

revoke all on function assistant_store_proposal(uuid,uuid,jsonb,jsonb),
  assistant_create_session(uuid,text,uuid,boolean,text), assistant_apply_proposal(uuid,uuid,text) from public, anon, authenticated;
grant execute on function assistant_store_proposal(uuid,uuid,jsonb,jsonb),
  assistant_create_session(uuid,text,uuid,boolean,text), assistant_apply_proposal(uuid,uuid,text) to service_role;

notify pgrst, 'reload schema';
commit;
