begin;

create table if not exists technician_observations (
  id uuid primary key default gen_random_uuid(),
  lrv_id text not null references vehicles(lrv_id),
  booking_id uuid references maintenance_bookings(id) on delete set null,
  maintenance_event_id uuid references maintenance_events(id) on delete set null,
  anchor_id bigint not null unique references mileage_anchors(id) on delete cascade,
  technician_id text not null,
  image_uri text not null,
  ocr_value_km numeric not null check (ocr_value_km >= 0),
  ocr_confidence numeric(5,4) not null check (ocr_confidence between 0 and 1),
  reviewed_manually boolean not null default false,
  submitted_value_km numeric not null check (submitted_value_km >= 0),
  captured_at timestamptz not null default now()
);

alter table technician_observations
  add column if not exists maintenance_event_id uuid references maintenance_events(id) on delete set null;

create index if not exists technician_observations_vehicle_time_idx
  on technician_observations (lrv_id, captured_at desc);

alter table technician_observations enable row level security;
drop policy if exists "demo read technician observations" on technician_observations;
create policy "demo read technician observations"
  on technician_observations for select to anon, authenticated using (true);
grant select on technician_observations to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'hubometer-evidence', 'hubometer-evidence', false, 8388608,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "demo upload hubometer evidence" on storage.objects;
create policy "demo upload hubometer evidence"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'hubometer-evidence');

drop policy if exists "demo read hubometer evidence" on storage.objects;
create policy "demo read hubometer evidence"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'hubometer-evidence');

drop policy if exists "demo remove failed hubometer evidence" on storage.objects;
create policy "demo remove failed hubometer evidence"
  on storage.objects for delete to anon, authenticated
  using (bucket_id = 'hubometer-evidence');

drop function if exists submit_hubometer_observation(text, numeric, text, text, numeric, boolean, uuid);
drop function if exists submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid);

create or replace function submit_hubometer_observation(
  p_lrv_id text,
  p_value_km numeric,
  p_technician_id text,
  p_image_uri text,
  p_ocr_value_km numeric,
  p_ocr_confidence numeric,
  p_reviewed_manually boolean,
  p_booking_id uuid default null
)
returns bigint language plpgsql security definer set search_path = public
as $$
declare
  v_booking maintenance_bookings%rowtype;
  v_event_id uuid;
  v_anchor_id bigint;
  v_anchor_floor bigint;
begin
  if p_value_km is null or p_value_km < 0 then
    raise exception 'A valid non-negative hubometer reading is required';
  end if;
  if nullif(btrim(p_technician_id), '') is null then
    raise exception 'Technician ID is required';
  end if;
  if nullif(btrim(p_image_uri), '') is null then
    raise exception 'A hubometer photo is required';
  end if;
  if p_ocr_confidence is null or p_ocr_confidence < 0 or p_ocr_confidence > 1 then
    raise exception 'OCR confidence must be between zero and one';
  end if;
  if p_ocr_value_km is null or p_ocr_value_km < 0 then
    raise exception 'A valid OCR reading is required';
  end if;
  if p_ocr_confidence < 0.85 and not p_reviewed_manually then
    raise exception 'Low-confidence OCR readings require manual verification';
  end if;
  if p_booking_id is null then
    raise exception 'A confirmed maintenance booking is required';
  end if;

  perform 1 from vehicles where lrv_id = p_lrv_id for update;
  if not found then
    raise exception 'Unknown LRV %', p_lrv_id;
  end if;
  select * into v_booking
  from maintenance_bookings
  where id = p_booking_id
  for update;
  if not found or v_booking.lrv_id <> p_lrv_id then
    raise exception 'The selected maintenance booking does not belong to %', p_lrv_id;
  end if;
  if v_booking.status <> 'confirmed' then
    raise exception 'Only a confirmed maintenance booking can be completed';
  end if;

  select coalesce(max(id), 0) into v_anchor_floor from mileage_anchors;

  v_event_id := complete_maintenance(
    p_lrv_id,
    v_booking.primary_cycle,
    p_value_km,
    btrim(p_technician_id),
    p_booking_id,
    'Hubometer reading confirmed through technician OCR workflow',
    case when v_booking.work_type = 'preventive'
      then v_booking.bundled_cycles
      else '{}'::integer[]
    end,
    v_booking.work_type,
    v_booking.fault_id
  );

  select id into v_anchor_id
  from mileage_anchors
  where id > v_anchor_floor
    and lrv_id = p_lrv_id
    and technician_id = btrim(p_technician_id)
    and source = 'maintenance_completion'
    and value_km = p_value_km
  order by id desc
  limit 1;
  if v_anchor_id is null then
    raise exception 'Maintenance completed without a matching mileage anchor';
  end if;

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

revoke execute on function submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid) from public;
grant execute on function submit_hubometer_observation(text, numeric, text, text, numeric, numeric, boolean, uuid) to anon, authenticated;

do $$
begin
  if to_regprocedure('public.reset_dashboard_demo_core()') is null then
    execute 'alter function public.reset_dashboard_demo() rename to reset_dashboard_demo_core';
  end if;
end;
$$;

create or replace function reset_dashboard_demo()
returns void language plpgsql security definer set search_path = public
as $$
begin
  delete from technician_observations
  where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  delete from mileage_anchors
  where source = 'technician_ocr'
    and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  perform reset_dashboard_demo_core();
end;
$$;

revoke execute on function reset_dashboard_demo_core() from public, anon, authenticated;
revoke execute on function reset_dashboard_demo() from public;
grant execute on function reset_dashboard_demo() to anon, authenticated;

commit;
