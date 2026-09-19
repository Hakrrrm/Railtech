begin;

-- Extra routine visits create varied occupancy without altering telemetry,
-- cycle mileage, existing bookings or the V18 OCR demonstration fixture.
create function restore_demo_outlook_bookings()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Singapore')::date;
  v_row record;
begin
  for v_row in select * from (values
    ('D01', 1, time '14:00', time '16:00', 2000),
    ('D02', 3, time '15:00', time '17:00', 2000),
    ('D04', 7, time '07:00', time '09:00', 2000),
    ('D06', 7, time '13:00', time '17:00', 13000),
    ('D09', 9, time '08:00', time '10:00', 2000),
    ('D11', 12, time '07:00', time '09:00', 2000)
  ) as fixture(lrv_id, day_offset, starts, ends, cycle)
  loop
    if not exists (select 1 from vehicles where lrv_id = v_row.lrv_id) then continue; end if;
    begin
      insert into maintenance_bookings (
        demo_key, lrv_id, work_type, primary_cycle, bundled_cycles, bay_id,
        start_at, end_at, status, notes
      ) values (
        'demo:booking:outlook:' || v_row.lrv_id, v_row.lrv_id, 'preventive', v_row.cycle,
        case when v_row.cycle = 13000 then array[2000,13000] else array[2000] end,
        'SPLRT-BAY-1',
        (v_today + v_row.day_offset + v_row.starts) at time zone 'Asia/Singapore',
        (v_today + v_row.day_offset + v_row.ends) at time zone 'Asia/Singapore',
        'confirmed', 'Planned routine inspection'
      ) on conflict (demo_key) do update set
        start_at = excluded.start_at, end_at = excluded.end_at,
        bay_id = excluded.bay_id, status = excluded.status,
        primary_cycle = excluded.primary_cycle, bundled_cycles = excluded.bundled_cycles;
    exception when exclusion_violation then
      -- An operator may already have filled this slot. Never move their work
      -- to install demo scenery. A clean demo reset restores the full fixture.
      null;
    end;
  end loop;
end;
$$;
revoke all on function restore_demo_outlook_bookings() from public, anon, authenticated;

alter function reset_dashboard_demo() rename to reset_dashboard_demo_before_outlook;
revoke all on function reset_dashboard_demo_before_outlook() from public, anon, authenticated;
create function reset_dashboard_demo()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform reset_dashboard_demo_before_outlook();
  perform restore_demo_outlook_bookings();
end;
$$;
revoke all on function reset_dashboard_demo() from public;
grant execute on function reset_dashboard_demo() to anon, authenticated;

select restore_demo_outlook_bookings();
notify pgrst, 'reload schema';
commit;
