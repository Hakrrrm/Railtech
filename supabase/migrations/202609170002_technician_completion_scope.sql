begin;

drop function if exists submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid);
drop function if exists submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid, integer[], text);

create function submit_hubometer_observation(
  p_lrv_id text,
  p_value_km numeric,
  p_technician_id text,
  p_image_uri text,
  p_ocr_value_km numeric,
  p_ocr_confidence numeric,
  p_reviewed_manually boolean,
  p_booking_id uuid default null,
  p_completed_cycles integer[] default null,
  p_completion_notes text default null
)
returns bigint language plpgsql security definer set search_path = public
as $$
declare
  v_booking maintenance_bookings%rowtype;
  v_event_id uuid;
  v_anchor_id bigint;
  v_anchor_floor bigint;
  v_notes text;
begin
  if p_value_km is null or p_value_km < 0 then raise exception 'A valid non-negative hubometer reading is required'; end if;
  if nullif(btrim(p_technician_id), '') is null then raise exception 'Technician ID is required'; end if;
  if nullif(btrim(p_image_uri), '') is null then raise exception 'A hubometer photo is required'; end if;
  if p_ocr_confidence is null or p_ocr_confidence < 0 or p_ocr_confidence > 1 then
    raise exception 'OCR confidence must be between zero and one';
  end if;
  if p_ocr_value_km is null or p_ocr_value_km < 0 then raise exception 'A valid OCR reading is required'; end if;
  if p_ocr_confidence < 0.85 and not p_reviewed_manually then
    raise exception 'Low-confidence OCR readings require manual verification';
  end if;
  if p_booking_id is null then raise exception 'A confirmed maintenance booking is required'; end if;

  perform 1 from vehicles where lrv_id = p_lrv_id for update;
  if not found then raise exception 'Unknown LRV %', p_lrv_id; end if;
  select * into v_booking from maintenance_bookings where id = p_booking_id for update;
  if not found or v_booking.lrv_id <> p_lrv_id then
    raise exception 'The selected maintenance booking does not belong to %', p_lrv_id;
  end if;
  if v_booking.status <> 'confirmed' then raise exception 'Only a confirmed maintenance booking can be completed'; end if;

  if v_booking.work_type = 'preventive' then
    if cardinality(coalesce(p_completed_cycles, '{}'::integer[])) = 0 then
      raise exception 'Select at least one completed maintenance cycle';
    end if;
    if not (p_completed_cycles <@ v_booking.bundled_cycles) then
      raise exception 'Completed cycles are outside the assigned package';
    end if;
    if p_completed_cycles is distinct from v_booking.bundled_cycles
       and nullif(btrim(p_completion_notes), '') is null then
      raise exception 'A reason is required when assigned maintenance was not completed';
    end if;
  elsif cardinality(coalesce(p_completed_cycles, '{}'::integer[])) <> 0 then
    raise exception 'Corrective work cannot complete mileage cycles';
  end if;

  v_notes := concat_ws(' — ', 'Hubometer reading confirmed through technician OCR workflow', nullif(btrim(p_completion_notes), ''));
  select coalesce(max(id), 0) into v_anchor_floor from mileage_anchors;
  v_event_id := complete_maintenance(
    p_lrv_id, v_booking.primary_cycle, p_value_km, btrim(p_technician_id), p_booking_id,
    v_notes, coalesce(p_completed_cycles, '{}'::integer[]), v_booking.work_type, v_booking.fault_id
  );

  select id into v_anchor_id
  from mileage_anchors
  where id > v_anchor_floor and lrv_id = p_lrv_id
    and technician_id = btrim(p_technician_id) and source = 'maintenance_completion'
    and value_km = p_value_km
  order by id desc limit 1;
  if v_anchor_id is null then raise exception 'Maintenance completed without a matching mileage anchor'; end if;

  insert into technician_observations (
    lrv_id, booking_id, maintenance_event_id, anchor_id, technician_id, image_uri,
    ocr_value_km, ocr_confidence, reviewed_manually, submitted_value_km
  ) values (
    p_lrv_id, p_booking_id, v_event_id, v_anchor_id, btrim(p_technician_id), btrim(p_image_uri),
    p_ocr_value_km, p_ocr_confidence, p_reviewed_manually, p_value_km
  );
  return v_anchor_id;
end;
$$;

revoke execute on function submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid, integer[], text) from public;
grant execute on function submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid, integer[], text) to anon, authenticated;

commit;
