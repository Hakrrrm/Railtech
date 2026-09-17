begin;

create or replace function reset_dashboard_demo()
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Singapore')::date;
begin
  perform pg_advisory_xact_lock(hashtextextended('dashboard-demo-reset:splrt', 0));

  -- Remove changes created through the dashboard. Seed-owned evidence and
  -- telemetry remain available, while optional simulator events are cleared.
  delete from maintenance_events
  where source = 'dashboard' and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  delete from mileage_anchors
  where source = 'maintenance_completion' and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  delete from maintenance_bookings
  where (demo_key is null or demo_key not like 'demo:%')
    and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

  update stock_changes
  set replacement_assignment_id = null, replacement_lrv_id = 'D27',
      decision_status = 'proposed', decided_by = null, decided_at = null,
      reason = 'Brake pressure fault reported in service; replace at the next safe handover',
      projected_duty_km = 118
  where demo_key = 'demo:stock:D29:D27';
  delete from stock_changes
  where demo_key is null and withdrawn_lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  delete from duty_assignments
  where demo_key is null and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';
  update duty_assignments
  set duty_start = now() - interval '2 hours'
        + ((substring(lrv_id from 2))::integer % 4) * interval '5 minutes',
      duty_end = now() + interval '5 hours'
        - ((substring(lrv_id from 2))::integer % 3) * interval '10 minutes',
      status = 'active'
  where demo_key like 'demo:duty:%';

  delete from segment_traversals
  where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$' and seq >= 950000000;

  update vehicles
  set status = case
    when lrv_id in ('D18', 'D24', 'D25', 'D26') then 'maintenance'
    when lrv_id in ('D27', 'D28') then 'idle'
    when lrv_id in ('D29', 'D30') then 'faulty'
    else 'in_service'
  end
  where fleet = 'splrt' and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

  update maintenance_faults
  set status = 'open', resolved_at = null, resolution_notes = null, updated_at = now()
  where demo_key like 'demo:fault:%';

  -- Clear active ranges before moving seeded bookings back to their canonical
  -- slots, so even heavily edited calendars reset without transient conflicts.
  update maintenance_bookings set status = 'cancelled', updated_at = now()
  where demo_key like 'demo:booking:%';

  update maintenance_bookings as booking
  set work_type = 'preventive', primary_cycle = seed.primary_cycle,
      bundled_cycles = seed.bundled_cycles, fault_id = null, bay_id = seed.bay_id,
      start_at = ((v_today + seed.start_days + seed.start_time) at time zone 'Asia/Singapore'),
      end_at = ((v_today + seed.end_days + seed.end_time) at time zone 'Asia/Singapore'),
      status = seed.status, notes = seed.notes, updated_at = now()
  from (values
    ('demo:booking:D18', 2000, array[2000], 'SPLRT-BAY-1', 0, time '09:00', 0, time '11:00', 'confirmed', 'Overdue 2K recall; vehicle already in depot'),
    ('demo:booking:D07', 13000, array[2000,13000], 'SPLRT-BAY-1', 1, time '09:00', 1, time '13:00', 'confirmed', 'Bundle the 2K and 13K cycles in one visit'),
    ('demo:booking:D24', 13000, array[2000,13000], 'SPLRT-BAY-1', 2, time '13:00', 2, time '17:00', 'confirmed', 'Routine planned maintenance'),
    ('demo:booking:D25', 40000, array[2000,13000,40000], 'SPLRT-BAY-2', 3, time '08:00', 3, time '14:00', 'confirmed', '40K package with nested-cycle completion'),
    ('demo:booking:D26', 120000, array[2000,13000,40000,120000], 'SPLRT-BAY-2', 4, time '08:00', 5, time '08:00', 'confirmed', '24-hour package with continuous bay occupation'),
    ('demo:booking:D22', 360000, array[2000,13000,40000,120000,360000], 'SPLRT-BAY-2', 6, time '08:00', 27, time '08:00', 'confirmed', 'Three-week package including weekends and waiting time')
  ) as seed(demo_key, primary_cycle, bundled_cycles, bay_id, start_days, start_time, end_days, end_time, status, notes)
  where booking.demo_key = seed.demo_key;

  with vehicle_profile as (
    select
      vehicle_no,
      format('D%s', lpad(vehicle_no::text, 2, '0')) as lrv_id,
      case vehicle_no
        when 7 then 410 when 9 then 92 when 12 then 400 when 18 then 105
        when 21 then 148 when 23 then 402 when 24 then 84 when 25 then 96
        when 26 then 78 when 27 then 86 when 28 then 82 when 29 then 110
        when 30 then 75 else 55 + ((vehicle_no * 17) % 66)
      end::numeric as daily_km
    from generate_series(1, 30) as vehicle_no
  ),
  cycles(cycle_type, cycle_order) as (
    values (2000, 1), (13000, 2), (40000, 3), (120000, 4), (360000, 5)
  ),
  overrides(lrv_id, cycle_type, km_since, km_to_next, due_offset_days) as (
    values
      ('D07',2000,1610::numeric,390::numeric,1), ('D07',13000,12200,800,2),
      ('D12',2000,2000,0,0), ('D18',2000,2060,-60,-3),
      ('D21',2000,520,1480,10), ('D21',13000,12680,320,2),
      ('D22',360000,359500,500,6), ('D23',2000,50,1950,5),
      ('D23',40000,39580,420,1), ('D24',13000,13020,-20,-1),
      ('D25',40000,39950,50,0), ('D26',120000,118900,1100,5),
      ('D27',2000,550,1450,17), ('D28',2000,1020,980,12)
  ),
  calculated as (
    select profile.lrv_id, profile.daily_km, cycle.cycle_type,
      least(cycle.cycle_type - 10,
        greatest(50, round(profile.daily_km * (8 + ((profile.vehicle_no * 11 + cycle.cycle_order * 17) % 113)))))::numeric
        as default_remaining
    from vehicle_profile as profile cross join cycles as cycle
  )
  insert into cycle_state (lrv_id, cycle_type, km_since, km_to_next, due_date)
  select calculated.lrv_id, calculated.cycle_type,
    coalesce(overrides.km_since, calculated.cycle_type - calculated.default_remaining),
    coalesce(overrides.km_to_next, calculated.default_remaining),
    v_today + coalesce(overrides.due_offset_days,
      ceil(calculated.default_remaining / calculated.daily_km)::integer)
  from calculated
  left join overrides using (lrv_id, cycle_type)
  on conflict (lrv_id, cycle_type) do update
  set km_since = excluded.km_since, km_to_next = excluded.km_to_next,
      due_date = excluded.due_date;

  update planning_settings set forecast_horizon_days = 14,
    deployment_safety_margin_km = 250, stale_telemetry_hours = 12,
    minimum_service_vehicles = 18, operating_timezone = 'Asia/Singapore', updated_at = now()
  where fleet = 'splrt';
  update maintenance_cycle_rules as rule set
    tolerance_km = seed.tolerance_km, duration_minutes = seed.duration_minutes,
    compatible_bay_type = seed.bay_type, included_cycles = seed.included_cycles, updated_at = now()
  from (values
    (2000,120,120,'universal',array[2000]),
    (13000,350,240,'universal',array[2000,13000]),
    (40000,600,360,'heavy',array[2000,13000,40000]),
    (120000,900,1440,'heavy',array[2000,13000,40000,120000]),
    (360000,1500,30240,'heavy',array[2000,13000,40000,120000,360000])
  ) as seed(cycle_type, tolerance_km, duration_minutes, bay_type, included_cycles)
  where rule.fleet = 'splrt' and rule.cycle_type = seed.cycle_type;
  update depot_bays set
    name = case bay_id when 'SPLRT-BAY-1' then 'Bay 1 · Routine' else 'Bay 2 · Heavy' end,
    bay_type = case bay_id when 'SPLRT-BAY-1' then 'universal' else 'heavy' end,
    opens_at = time '06:00', closes_at = time '23:00', active = true
  where bay_id in ('SPLRT-BAY-1', 'SPLRT-BAY-2');
end;
$$;

revoke execute on function reset_dashboard_demo() from public;
grant execute on function reset_dashboard_demo() to anon, authenticated;

commit;
