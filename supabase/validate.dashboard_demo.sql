-- Validation for supabase/seed.dashboard_demo.sql.
-- Every failed invariant raises an exception with a specific message.

begin;
set local timezone to 'Asia/Singapore';

do $validation$
declare
  actual_count integer;
  before_km numeric;
  before_40_km numeric;
  rejected boolean;
begin
  select count(*)
  into actual_count
  from vehicles
  where fleet = 'splrt'
    and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

  if actual_count <> 30 then
    raise exception 'Expected 30 SPLRT demo vehicles, found %', actual_count;
  end if;

  if exists (
    with expected (status, expected_count) as (
      values
        ('in_service', 22),
        ('maintenance', 4),
        ('idle', 2),
        ('faulty', 2)
    ),
    actual as (
      select status, count(*)::integer as actual_count
      from vehicles
      where fleet = 'splrt'
        and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
      group by status
    )
    select 1
    from expected
    left join actual using (status)
    where coalesce(actual.actual_count, 0) <> expected.expected_count
  ) then
    raise exception 'Vehicle status distribution is not 22/4/2/2';
  end if;

  if exists (
    select 1
    from vehicles as vehicle
    left join cycle_state as cycle on cycle.lrv_id = vehicle.lrv_id
    where vehicle.fleet = 'splrt'
      and vehicle.lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
    group by vehicle.lrv_id
    having count(cycle.cycle_type) <> 5
       or array_agg(cycle.cycle_type order by cycle.cycle_type)
          <> array[2000, 13000, 40000, 120000, 360000]
  ) then
    raise exception 'Every demo vehicle must have exactly the five supported cycles';
  end if;

  if exists (
    select 1
    from segment_traversals
    where seg_id like 'SIM\_%' escape '\'
      and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
      and length_m <= 0
  ) then
    raise exception 'Synthetic traversal lengths must be positive';
  end if;

  if exists (
    select 1
    from segment_traversals
    where seg_id like 'SIM\_%' escape '\'
      and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
      and ts > now()
  ) then
    raise exception 'Synthetic traversals must not be dated in the future';
  end if;

  if exists (
    with progression as (
      select
        lrv_id,
        seq,
        length_m,
        odo_km,
        lag(odo_km) over (partition by lrv_id order by seq) as previous_odo_km
      from segment_traversals
      where seg_id like 'SIM\_%' escape '\'
        and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
    )
    select 1
    from progression
    where previous_odo_km is not null
      and (
        odo_km < previous_odo_km
        or abs((odo_km - previous_odo_km) - length_m / 1000) > 0.002
      )
  ) then
    raise exception 'Synthetic odometers are not monotonic and distance-consistent';
  end if;

  if exists (
    select lrv_id, seq
    from segment_traversals
    where seg_id like 'SIM\_%' escape '\'
      and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
    group by lrv_id, seq
    having count(*) > 1
  ) then
    raise exception 'Synthetic traversal sequences are duplicated';
  end if;

  if exists (
    select 1
    from vehicles as vehicle
    where vehicle.fleet = 'splrt'
      and vehicle.lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
      and not exists (
        select 1
        from mileage_anchors as anchor
        where anchor.lrv_id = vehicle.lrv_id
          and anchor.source like 'demo:%'
          and anchor.superseded_by is null
      )
  ) then
    raise exception 'Every demo vehicle needs a current unsuperseded anchor';
  end if;

  if exists (
    select 1
    from mileage_anchors
    where source like 'demo:%'
      and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
      and abs(divergence_km - (value_km - gnss_odo_km)) > 0.001
  ) then
    raise exception 'Anchor divergence does not match value minus GNSS odometer';
  end if;

  select count(*)
  into actual_count
  from mileage_anchors
  where source like 'demo:%'
    and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

  if actual_count <> 92 then
    raise exception 'Expected 92 deterministic demo anchors, found %', actual_count;
  end if;

  if not exists (
    select 1
    from mileage_anchors as bad_anchor
    join mileage_anchors as correction
      on correction.id = bad_anchor.superseded_by
    where bad_anchor.lrv_id = 'D09'
      and bad_anchor.source = 'demo:manual-error'
      and bad_anchor.override
      and bad_anchor.divergence_km = 120
      and correction.source = 'demo:correction'
  ) then
    raise exception 'D09 append-only correction scenario is missing';
  end if;

  if not exists (
    select 1
    from cycle_state as first_cycle
    join cycle_state as second_cycle using (lrv_id)
    where first_cycle.lrv_id = 'D07'
      and first_cycle.cycle_type = 2000
      and first_cycle.km_to_next = 390
      and first_cycle.due_date = current_date + 1
      and second_cycle.cycle_type = 13000
      and second_cycle.km_to_next = 800
      and second_cycle.due_date = current_date + 2
  ) then
    raise exception 'D07 bundled-cycle showcase scenario is missing';
  end if;

  if not exists (
    select 1
    from cycle_state
    where lrv_id = 'D18'
      and cycle_type = 2000
      and km_to_next = -60
      and due_date = current_date - 3
  ) then
    raise exception 'D18 overdue scenario is missing';
  end if;

  if not exists (
    select 1
    from cycle_state
    where lrv_id = 'D12'
      and cycle_type = 2000
      and km_to_next = 0
      and due_date = current_date
  ) then
    raise exception 'D12 due-today scenario is missing';
  end if;

  if not exists (
    select 1
    from cycle_state
    where lrv_id = 'D21'
      and cycle_type = 13000
      and km_to_next = 320
      and due_date = current_date + 2
  ) then
    raise exception 'D21 slow-approach 13K scenario is missing';
  end if;

  if not exists (
    select 1
    from cycle_state
    where lrv_id = 'D23'
      and cycle_type = 40000
      and km_to_next = 420
      and due_date = current_date + 1
  ) then
    raise exception 'D23 high-rate 40K scenario is missing';
  end if;

  if (
    select count(*)
    from vehicles
    where lrv_id in ('D24', 'D25', 'D26')
      and status = 'maintenance'
  ) <> 3 then
    raise exception 'D24-D26 must be in routine maintenance';
  end if;

  if (
    select count(*)
    from vehicles
    where lrv_id in ('D27', 'D28')
      and status = 'idle'
  ) <> 2 then
    raise exception 'D27 and D28 must be the two idle reserves';
  end if;

  if (
    select count(*)
    from vehicles
    where lrv_id in ('D29', 'D30')
      and status = 'faulty'
  ) <> 2 then
    raise exception 'D29 and D30 must be faulty';
  end if;

  if not exists (
    select 1
    from segment_traversals
    where seg_id like 'SIM\_%' escape '\'
      and hdop < 1
  ) or not exists (
    select 1
    from segment_traversals
    where seg_id like 'SIM\_%' escape '\'
      and hdop >= 1
      and hdop < 2
  ) or not exists (
    select 1
    from segment_traversals
    where seg_id like 'SIM\_%' escape '\'
      and hdop >= 2
  ) then
    raise exception 'Strong, fair, and weak telemetry examples are required';
  end if;

  if (
    select max(ts)
    from segment_traversals
    where lrv_id = 'D09'
      and seg_id like 'SIM\_%' escape '\'
  ) >= date_trunc('day', now()) - interval '2 days'
  or (
    select max(ts)
    from segment_traversals
    where lrv_id = 'D30'
      and seg_id like 'SIM\_%' escape '\'
  ) >= date_trunc('day', now()) - interval '3 days'
  then
    raise exception 'D09 and D30 stale-telemetry scenarios are missing';
  end if;

  if exists (
    select demo_lrv
    from unnest(array['D07', 'D08', 'D09']::text[]) as demo(demo_lrv)
    where (
      select count(*)
      from segment_traversals
      where lrv_id = demo_lrv
        and seg_id like 'SIM\_%' escape '\'
    ) < 5
    or not exists (
      select 1
      from mileage_anchors
      where lrv_id = demo_lrv
        and source like 'demo:%'
        and superseded_by is null
    )
  ) then
    raise exception 'D07-D09 frontend compatibility data is incomplete';
  end if;

  if (select count(*) from maintenance_cycle_rules where fleet = 'splrt') <> 5 then
    raise exception 'Expected five SPLRT maintenance cycle rules';
  end if;

  if exists (
    select 1
    from (values
      (2000, 120, array[2000]),
      (13000, 240, array[2000,13000]),
      (40000, 360, array[2000,13000,40000]),
      (120000, 1440, array[2000,13000,40000,120000]),
      (360000, 30240, array[2000,13000,40000,120000,360000])
    ) as expected(cycle_type, duration_minutes, included_cycles)
    left join maintenance_cycle_rules as rule
      on rule.fleet = 'splrt' and rule.cycle_type = expected.cycle_type
    where rule.duration_minutes is distinct from expected.duration_minutes
       or rule.included_cycles is distinct from expected.included_cycles
  ) then
    raise exception 'LTA-confirmed package duration or included-cycle scope is incorrect';
  end if;

  if (select count(*) from depot_bays where fleet = 'splrt' and active) <> 2 then
    raise exception 'Expected two active SPLRT depot bays';
  end if;

  if (select count(*) from maintenance_bookings where demo_key like 'demo:%') <> 11 then
    raise exception 'Expected eleven demo maintenance bookings';
  end if;

  if (select count(*) from maintenance_faults where demo_key like 'demo:%' and status = 'open') <> 2
     or not exists (
       select 1 from maintenance_faults
       where demo_key = 'demo:fault:D29:brake' and severity = 'critical'
         and estimated_duration_minutes = 360 and required_bay_type = 'heavy'
     ) then
    raise exception 'Expected two actionable demo faults including D29 brake repair';
  end if;

  if not exists (
    select 1 from maintenance_bookings
    where demo_key = 'demo:booking:D22'
      and primary_cycle = 360000
      and bundled_cycles = array[2000,13000,40000,120000,360000]
      and end_at - start_at = interval '21 days'
  ) then
    raise exception 'D22 three-week 360K occupancy scenario is missing';
  end if;

  if (select count(*) from maintenance_events where demo_key like 'demo:%') <> 30 then
    raise exception 'Expected one demo maintenance event per vehicle';
  end if;

  if not exists (
    select 1 from maintenance_bookings
    where lrv_id = 'D07'
      and primary_cycle = 13000
      and bundled_cycles @> array[2000,13000]
      and status = 'confirmed'
  ) then
    raise exception 'D07 bundled booking scenario is missing';
  end if;

  if (select count(*) from maintenance_bookings
      where demo_key like 'demo:booking:history:%'
        and status = 'completed'
        and start_at < date_trunc('day', now() at time zone 'Asia/Singapore') at time zone 'Asia/Singapore') <> 5 then
    raise exception 'Expected five completed historical bookings before the demo date';
  end if;

  if not exists (
    select 1 from stock_changes
    where demo_key = 'demo:stock:D29:D27'
      and withdrawn_lrv_id = 'D29'
      and replacement_lrv_id = 'D27'
      and decision_status = 'proposed'
  ) then
    raise exception 'D29 to D27 stock-change scenario is missing';
  end if;

  if (select count(*) from vehicle_mileage_summary where fleet = 'splrt') <> 30 then
    raise exception 'Mileage summary view must return all 30 demo vehicles';
  end if;

  if (
    select count(*) from cycle_forecasts
    where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
  ) <> 150 then
    raise exception 'Cycle forecast view must return exactly 150 demo cycle rows';
  end if;

  if not exists (
    select 1 from cycle_forecasts
    where lrv_id = 'D12' and cycle_type = 2000 and forecast_days = 0
  ) then
    raise exception 'D12 must forecast as due today from its mileage state';
  end if;

  if exists (
    select 1 from deployment_eligibility
    where lrv_id = 'D08' and (eligible or free_of_duty)
  ) or (
    select count(*) from deployment_eligibility
    where lrv_id in ('D27', 'D28') and eligible and free_of_booking and free_of_duty
  ) <> 2 then
    raise exception 'Deployment eligibility must exclude assigned vehicles and retain both idle reserves';
  end if;

  -- A duplicate sequence must not fire the insert trigger twice.
  select km_since into before_km from cycle_state where lrv_id = 'D08' and cycle_type = 2000;
  insert into segment_traversals (lrv_id, seq, seg_id, ts, length_m, dir, odo_km, confidence, hdop)
  values ('D08', 999999999, 'VALIDATION_SEG', now(), 100, 'E', 102286.5, 0.99, 0.8)
  on conflict (lrv_id, seq) do nothing;
  insert into segment_traversals (lrv_id, seq, seg_id, ts, length_m, dir, odo_km, confidence, hdop)
  values ('D08', 999999999, 'VALIDATION_SEG', now(), 100, 'E', 102286.5, 0.99, 0.8)
  on conflict (lrv_id, seq) do nothing;
  if abs((select km_since from cycle_state where lrv_id = 'D08' and cycle_type = 2000) - before_km - 0.1) > 0.0001 then
    raise exception 'Duplicate SEG_DONE sequence incremented cycle state more than once';
  end if;

  rejected := false;
  begin
    insert into segment_traversals (lrv_id, seq, seg_id, ts, length_m, dir, odo_km, confidence, hdop)
    values ('D08', 999999998, 'VALIDATION_REGRESSION', now(), 100, 'E', 1, 0.99, 0.8);
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'A regressing device odometer was accepted'; end if;

  -- The booking RPC must reject occupied bays, incompatible capability and
  -- a plan that breaches the configured minimum operating fleet.
  rejected := false;
  begin
    perform schedule_maintenance('D08', 2000, array[2000], 'SPLRT-BAY-1',
      current_date + time '09:15', current_date + time '11:15', 'confirmed', 'collision test');
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'Overlapping bay booking was accepted'; end if;

  -- Corrective work has its own fault record, duration and bay requirements. It
  -- must use the same atomic collision guard as preventive work without resetting
  -- any mileage cycle.
  perform schedule_maintenance(
    'D29', null, '{}'::integer[], 'SPLRT-BAY-2',
    current_date + 36 + time '08:00', current_date + 36 + time '14:00',
    'proposed', 'corrective scheduling validation', null, 'corrective',
    (select id from maintenance_faults where demo_key = 'demo:fault:D29:brake')
  );
  if not exists (
    select 1 from maintenance_bookings
    where lrv_id = 'D29' and work_type = 'corrective' and primary_cycle is null
      and bundled_cycles = '{}'::integer[] and status = 'proposed'
  ) or not exists (
    select 1 from maintenance_faults
    where demo_key = 'demo:fault:D29:brake' and status = 'scheduled'
  ) then
    raise exception 'Corrective fault scheduling did not create a valid booking';
  end if;

  rejected := false;
  begin
    perform schedule_maintenance(
      'D30', null, '{}'::integer[], 'SPLRT-BAY-2',
      current_date + 36 + time '09:00', current_date + 36 + time '13:00',
      'proposed', 'corrective overlap validation', null, 'corrective',
      (select id from maintenance_faults where demo_key = 'demo:fault:D30:tracking')
    );
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'Overlapping corrective booking was accepted'; end if;

  rejected := false;
  begin
    perform schedule_maintenance('D07', 13000, array[2000,13000], 'SPLRT-BAY-2',
      current_date + 1 + time '09:30', current_date + 1 + time '13:30', 'proposed', 'vehicle overlap test');
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'The same vehicle was booked into two bays at once'; end if;

  rejected := false;
  begin
    perform schedule_maintenance('D08', 13000, array[13000], 'SPLRT-BAY-1',
      current_date + 6 + time '13:00', current_date + 6 + time '15:30', 'proposed', 'nested set test');
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'An incomplete nested-cycle booking was accepted'; end if;

  rejected := false;
  begin
    perform schedule_maintenance('D08', 2000, array[2000], 'SPLRT-BAY-1',
      current_date + 6 + time '13:00', current_date + 6 + time '13:30', 'proposed', 'duration test');
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'A booking shorter than the configured task duration was accepted'; end if;

  insert into depot_bays (bay_id, fleet, name, bay_type, opens_at, closes_at, active)
  values ('VALIDATION-BAY', 'splrt', 'Validation bay', 'routine', '06:00', '23:00', true);
  rejected := false;
  begin
    perform schedule_maintenance('D25', 40000, array[2000,13000,40000], 'VALIDATION-BAY',
      current_date + 35 + time '08:00', current_date + 35 + time '14:00', 'proposed', 'capability test');
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'Incompatible maintenance bay was accepted'; end if;

  insert into duty_assignments (demo_key, lrv_id, loop_id, slot_label, duty_start, duty_end, status)
  values ('validation:duty-conflict', 'D08', 'Validation Loop', 'Validation run',
    current_date + 80 + time '10:00', current_date + 80 + time '12:00', 'planned');
  rejected := false;
  begin
    perform schedule_maintenance('D08', 2000, array[2000], 'VALIDATION-BAY',
      current_date + 80 + time '10:00', current_date + 80 + time '12:00', 'confirmed', 'duty conflict test');
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'A confirmed depot stay overlapping an operating duty was accepted'; end if;

  update planning_settings set minimum_service_vehicles = 22 where fleet = 'splrt';
  rejected := false;
  begin
    perform schedule_maintenance('D08', 2000, array[2000], 'SPLRT-BAY-1',
      current_date + 35 + time '16:00', current_date + 35 + time '18:00', 'confirmed', 'coverage test');
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'Service-coverage floor was not enforced'; end if;

  -- Multi-day visits are continuous bay occupancy; only their start and finish
  -- need to fall inside the bay's staffed operating window.
  perform schedule_maintenance('D08', 120000, array[2000,13000,40000,120000], 'SPLRT-BAY-2',
    current_date + 40 + time '08:00', current_date + 41 + time '08:00', 'proposed', '24-hour validation');
  perform schedule_maintenance('D09', 360000, array[2000,13000,40000,120000,360000], 'SPLRT-BAY-2',
    current_date + 50 + time '08:00', current_date + 71 + time '08:00', 'proposed', 'three-week validation');

  perform complete_maintenance(
    'D18', 2000,
    (select lifetime_planning_mileage_km from vehicle_mileage_summary where lrv_id = 'D18'),
    'VALIDATION',
    (select id from maintenance_bookings where demo_key = 'demo:booking:D18')
  );
  rejected := false;
  begin
    perform complete_maintenance(
      'D18', 2000,
      (select lifetime_planning_mileage_km from vehicle_mileage_summary where lrv_id = 'D18'),
      'VALIDATION',
      (select id from maintenance_bookings where demo_key = 'demo:booking:D18')
    );
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'A completed booking reset maintenance twice'; end if;

  -- Exercise the atomic nested reset inside this validation transaction.
  -- The script rolls back below, leaving the seeded state untouched.
  perform complete_maintenance(
    'D25', 40000,
    (select lifetime_planning_mileage_km from vehicle_mileage_summary where lrv_id = 'D25'),
    'VALIDATION'
  );

  if exists (
    select 1 from cycle_state
    where lrv_id = 'D25'
      and cycle_type in (2000, 13000, 40000)
      and (km_since <> 0 or km_to_next <> cycle_type)
  ) or (
    select count(*) from cycle_state
    where lrv_id = 'D25'
      and cycle_type in (2000, 13000, 40000)
      and km_since = 0
      and km_to_next = cycle_type
  ) <> 3 then
    raise exception '40K completion did not reset 2K, 13K, and 40K';
  end if;

  -- Technicians can close a visit with a smaller actual scope, but the omitted
  -- cycle must remain untouched and an explanatory note is mandatory.
  insert into maintenance_bookings (
    demo_key, lrv_id, primary_cycle, bundled_cycles, bay_id, start_at, end_at, status, notes
  ) values (
    'validation:partial-completion', 'D08', 40000, array[2000,13000,40000], 'SPLRT-BAY-2',
    current_date - 1 + time '08:00', current_date - 1 + time '14:00', 'confirmed', 'validation visit'
  );
  select km_since into before_40_km from cycle_state where lrv_id = 'D08' and cycle_type = 40000;
  perform complete_maintenance(
    'D08', 40000,
    (select lifetime_planning_mileage_km from vehicle_mileage_summary where lrv_id = 'D08'),
    'VALIDATION',
    (select id from maintenance_bookings where demo_key = 'validation:partial-completion'),
    '40K work deferred after inspection', array[2000,13000]
  );
  if (select km_since from cycle_state where lrv_id = 'D08' and cycle_type = 40000) <> before_40_km
     or exists (
       select 1 from cycle_state where lrv_id = 'D08' and cycle_type in (2000,13000) and km_since <> 0
     ) or not exists (
       select 1 from maintenance_bookings
       where demo_key = 'validation:partial-completion' and status = 'partially_completed'
     ) then
    raise exception 'Technician-recorded partial scope reset the wrong maintenance cycles';
  end if;

  rejected := false;
  begin
    perform complete_maintenance(
      'D09', 40000,
      (select lifetime_planning_mileage_km from vehicle_mileage_summary where lrv_id = 'D09'),
      'VALIDATION', null, null, array[2000,13000]
    );
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'A partial completion without a reason was accepted'; end if;

  -- Technician confirmation must create one linked audit record and complete
  -- the confirmed package through the same nested-cycle rules.
  insert into maintenance_bookings (
    demo_key, lrv_id, primary_cycle, bundled_cycles, bay_id,
    start_at, end_at, status, notes
  ) values (
    'validation:technician-completion', 'D06', 13000, array[2000,13000], 'SPLRT-BAY-1',
    now() - interval '6 hours', now() - interval '2 hours', 'confirmed',
    'validation technician visit'
  );
  perform submit_hubometer_observation(
    'D06',
    (select lifetime_planning_mileage_km from vehicle_mileage_summary where lrv_id = 'D06'),
    'VALIDATION', 'hubometer-evidence/D06/validation.jpg',
    (select lifetime_planning_mileage_km from vehicle_mileage_summary where lrv_id = 'D06'),
    0.94, false,
    (select id from maintenance_bookings where demo_key = 'validation:technician-completion'),
    array[2000,13000], null
  );
  if not exists (
    select 1
    from technician_observations as observation
    join maintenance_events as event on event.id = observation.maintenance_event_id
    join maintenance_bookings as booking on booking.id = observation.booking_id
    where observation.lrv_id = 'D06'
      and observation.anchor_id is not null
      and event.reset_cycles = array[2000,13000]
      and booking.status = 'completed'
  ) or exists (
    select 1 from cycle_state
    where lrv_id = 'D06' and cycle_type in (2000,13000)
      and (km_since <> 0 or km_to_next <> cycle_type)
  ) then
    raise exception 'Technician confirmation did not complete and reset its confirmed package';
  end if;

  perform confirm_stock_change(
    (select id from stock_changes where demo_key = 'demo:stock:D29:D27'),
    'VALIDATION'
  );
  if not exists (
    select 1 from stock_changes
    where demo_key = 'demo:stock:D29:D27' and decision_status = 'confirmed'
      and replacement_assignment_id is not null
  ) then
    raise exception 'Atomic stock change did not record the replacement assignment';
  end if;

  -- The browser reset must restore the seeded planning state after bookings,
  -- completions, simulator mileage and a stock change have all mutated it.
  perform reset_dashboard_demo();
  if exists (
    select 1 from maintenance_bookings
    where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
      and (demo_key is null or demo_key not like 'demo:%')
  ) or (select count(*) from maintenance_bookings where demo_key like 'demo:booking:%') <> 11 then
    raise exception 'Demo reset did not restore the eleven seeded bookings';
  end if;
  if (select count(*) from maintenance_faults where demo_key like 'demo:fault:%' and status = 'open') <> 2 then
    raise exception 'Demo reset did not reopen the two seeded faults';
  end if;
  if not exists (
    select 1 from stock_changes
    where demo_key = 'demo:stock:D29:D27' and decision_status = 'proposed'
      and replacement_assignment_id is null and decided_at is null
  ) then
    raise exception 'Demo reset did not restore the proposed stock change';
  end if;
  if exists (
    select 1 from segment_traversals
    where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$' and seq >= 950000000
  ) then
    raise exception 'Demo reset did not clear simulator events';
  end if;
  if exists (
    select 1 from technician_observations
    where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
  ) then
    raise exception 'Demo reset did not clear technician observations';
  end if;
  if not exists (
    select 1 from cycle_state where lrv_id = 'D12' and cycle_type = 2000 and km_to_next = 0
  ) or not exists (
    select 1 from cycle_state where lrv_id = 'D18' and cycle_type = 2000 and km_to_next = -60
  ) then
    raise exception 'Demo reset did not restore the seeded cycle state';
  end if;

  if (
    with ranked as (
      select forecast.*, vehicle.status,
        row_number() over (
          partition by forecast.lrv_id
          order by forecast.priority_score desc, forecast.cycle_type
        ) as forecast_rank
      from cycle_forecasts as forecast
      join vehicles as vehicle using (lrv_id)
      where vehicle.fleet = 'splrt'
        and vehicle.lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
    )
    select count(*)
    from ranked
    where forecast_rank = 1
      and status <> 'maintenance'
      and (status = 'faulty' or forecast_days between 0 and 7)
  ) <> 7 then
    raise exception 'Demo reset must restore seven vehicles requiring maintenance attention';
  end if;

  if (
    with ranked as (
      select forecast.*, vehicle.status,
        row_number() over (
          partition by forecast.lrv_id
          order by forecast.priority_score desc, forecast.cycle_type
        ) as forecast_rank
      from cycle_forecasts as forecast
      join vehicles as vehicle using (lrv_id)
      where vehicle.fleet = 'splrt'
        and vehicle.lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
    )
    select count(*)
    from ranked
    where forecast_rank = 1
      and status <> 'maintenance'
      and status <> 'faulty'
      and forecast_days between 0 and 7
  ) <> 5 then
    raise exception 'Demo reset must restore five vehicles due within seven days';
  end if;
end
$validation$;

rollback;

-- Human-readable verification summary.
select status, count(*) as vehicles
from vehicles
where fleet = 'splrt'
  and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
group by status
order by status;

select
  count(*) as cycle_rows,
  count(distinct lrv_id) as vehicles_with_cycles
from cycle_state
where lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

select
  count(*) as traversal_rows,
  count(distinct lrv_id) as vehicles_with_telemetry,
  min(ts) as first_event,
  max(ts) as latest_event
from segment_traversals
where seg_id like 'SIM\_%' escape '\'
  and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

select
  count(*) as anchor_rows,
  count(*) filter (where override) as override_rows,
  count(*) filter (where superseded_by is not null) as superseded_rows
from mileage_anchors
where source like 'demo:%'
  and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

