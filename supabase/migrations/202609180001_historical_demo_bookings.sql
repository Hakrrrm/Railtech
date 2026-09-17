begin;

-- Populate the days immediately before the demo date so the weekly schedule
-- reads like a working depot rather than a plan that begins today. These rows
-- are completed history, and their dates are rebased every time the demo is
-- reset alongside the active seeded bookings.
create or replace function restore_demo_historical_bookings()
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Singapore')::date;
begin
  -- On a clean local reset migrations run before seed data is loaded. The seed
  -- inserts the same rows after the vehicles exist, while linked demo projects
  -- can be updated immediately by this migration.
  if not exists (select 1 from vehicles where lrv_id = 'D03') then
    return;
  end if;

  insert into maintenance_bookings (
    demo_key, lrv_id, work_type, primary_cycle, bundled_cycles, bay_id,
    start_at, end_at, status, notes
  ) values
    ('demo:booking:history:D03', 'D03', 'preventive', 2000, array[2000], 'SPLRT-BAY-1',
      ((v_today - 4 + time '07:00') at time zone 'Asia/Singapore'),
      ((v_today - 4 + time '09:00') at time zone 'Asia/Singapore'), 'completed',
      'Completed routine 2K inspection'),
    ('demo:booking:history:D14', 'D14', 'preventive', 40000, array[2000,13000,40000], 'SPLRT-BAY-2',
      ((v_today - 4 + time '08:00') at time zone 'Asia/Singapore'),
      ((v_today - 4 + time '14:00') at time zone 'Asia/Singapore'), 'completed',
      'Completed 40K package and nested-cycle checks'),
    ('demo:booking:history:D08', 'D08', 'preventive', 13000, array[2000,13000], 'SPLRT-BAY-1',
      ((v_today - 3 + time '09:00') at time zone 'Asia/Singapore'),
      ((v_today - 3 + time '13:00') at time zone 'Asia/Singapore'), 'completed',
      'Completed bundled 2K and 13K maintenance'),
    ('demo:booking:history:D16', 'D16', 'preventive', 40000, array[2000,13000,40000], 'SPLRT-BAY-2',
      ((v_today - 2 + time '08:00') at time zone 'Asia/Singapore'),
      ((v_today - 2 + time '14:00') at time zone 'Asia/Singapore'), 'completed',
      'Completed 40K inspection package'),
    ('demo:booking:history:D20', 'D20', 'preventive', 2000, array[2000], 'SPLRT-BAY-1',
      ((v_today - 1 + time '14:00') at time zone 'Asia/Singapore'),
      ((v_today - 1 + time '16:00') at time zone 'Asia/Singapore'), 'completed',
      'Completed routine 2K inspection')
  on conflict (demo_key) do update set
    lrv_id = excluded.lrv_id,
    work_type = excluded.work_type,
    primary_cycle = excluded.primary_cycle,
    bundled_cycles = excluded.bundled_cycles,
    fault_id = null,
    bay_id = excluded.bay_id,
    start_at = excluded.start_at,
    end_at = excluded.end_at,
    status = excluded.status,
    notes = excluded.notes,
    updated_at = now();
end;
$$;

revoke execute on function restore_demo_historical_bookings() from public, anon, authenticated;

select restore_demo_historical_bookings();

create or replace function reset_dashboard_demo()
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_latest_demo_telemetry timestamptz;
  v_telemetry_shift interval;
begin
  delete from technician_observations
  where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

  delete from mileage_anchors
  where source = 'technician_ocr'
    and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

  perform reset_dashboard_demo_core();

  update maintenance_bookings
  set status = 'confirmed', updated_at = now()
  where demo_key in ('demo:booking:D07', 'demo:booking:D26', 'demo:booking:D22')
    and status = 'proposed';

  perform restore_demo_historical_bookings();

  select max(ts)
  into v_latest_demo_telemetry
  from segment_traversals
  where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
    and seq >= 900000000
    and seq < 950000000
    and seg_id like 'SIM\_%' escape '\';

  if v_latest_demo_telemetry is not null then
    v_telemetry_shift := now() - interval '5 minutes' - v_latest_demo_telemetry;

    update segment_traversals
    set ts = ts + v_telemetry_shift
    where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
      and seq >= 900000000
      and seq < 950000000
      and seg_id like 'SIM\_%' escape '\';
  end if;
end;
$$;

revoke execute on function reset_dashboard_demo() from public;
grant execute on function reset_dashboard_demo() to anon, authenticated;

commit;
