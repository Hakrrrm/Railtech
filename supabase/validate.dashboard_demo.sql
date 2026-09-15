-- Validation for supabase/seed.dashboard_demo.sql.
-- Every failed invariant raises an exception with a specific message.

begin;
set local timezone to 'Asia/Singapore';

do $validation$
declare
  actual_count integer;
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
      and km_to_next = 400
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
    from unnest(array['D07', 'D08', 'D09']) as demo_lrv
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
end
$validation$;

commit;

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

