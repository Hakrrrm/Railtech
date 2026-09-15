-- Railtech dashboard showcase dataset.
--
-- Run after supabase/schema.sql in a development or demonstration project.
-- The seed is deterministic apart from dates, which are anchored to the
-- transaction date in Asia/Singapore so urgency cards remain current.
--
-- Rerun safety:
--   * vehicles and cycle_state are upserted through their existing keys;
--   * only SIM_* traversals and demo:* anchors for D01-D30 are replaced;
--   * unrelated device telemetry and technician-entered anchors are retained.

begin;
set local timezone to 'Asia/Singapore';

create temporary table _demo_vehicle_profile (
  vehicle_no integer primary key,
  lrv_id text unique not null,
  status text not null,
  daily_km numeric not null,
  latest_odo_km numeric not null,
  telemetry_stop_days integer not null
) on commit drop;

insert into _demo_vehicle_profile (
  vehicle_no,
  lrv_id,
  status,
  daily_km,
  latest_odo_km,
  telemetry_stop_days
)
select
  vehicle_no,
  format('D%s', lpad(vehicle_no::text, 2, '0')),
  case
    when vehicle_no in (18, 24, 25, 26) then 'maintenance'
    when vehicle_no in (27, 28) then 'idle'
    when vehicle_no in (29, 30) then 'faulty'
    else 'in_service'
  end,
  case vehicle_no
    when 7 then 410
    when 9 then 92
    when 12 then 400
    when 18 then 105
    when 21 then 148
    when 23 then 402
    when 24 then 84
    when 25 then 96
    when 26 then 78
    when 27 then 86
    when 28 then 82
    when 29 then 110
    when 30 then 75
    else 55 + ((vehicle_no * 17) % 66)
  end::numeric,
  case vehicle_no
    when 7 then 128473.9
    when 9 then 142880.3
    when 12 then 167220.4
    when 18 then 212480.0
    when 21 then 156680.0
    when 23 then 186300.0
    else round((52000 + vehicle_no * 5321.7 + (vehicle_no % 4) * 8100)::numeric, 1)
  end,
  case
    when vehicle_no = 9 then 3
    when vehicle_no = 18 then 3
    when vehicle_no in (24, 25, 27, 28) then 1
    when vehicle_no in (26, 29) then 2
    when vehicle_no = 30 then 4
    else 0
  end
from generate_series(1, 30) as vehicle_no;

insert into vehicles (lrv_id, fleet, type, status)
select lrv_id, 'splrt', 'LRV', status
from _demo_vehicle_profile
on conflict (lrv_id) do update
set fleet = excluded.fleet,
    type = excluded.type,
    status = excluded.status;

-- Remove only rows owned by this demo seed. Real ingest rows and manual
-- anchors for the same vehicles are intentionally left untouched.
delete from segment_traversals as traversal
using _demo_vehicle_profile as vehicle
where traversal.lrv_id = vehicle.lrv_id
  and traversal.seg_id like 'SIM\_%' escape '\';

delete from mileage_anchors as anchor
using _demo_vehicle_profile as vehicle
where anchor.lrv_id = vehicle.lrv_id
  and anchor.source like 'demo:%';

-- Seven days of segment-level telemetry. The six synthetic sections form a
-- 4.5 km loop; daily loop counts are derived from each vehicle's profile.
-- Vehicles in maintenance, idle, fault, or data-review scenarios stop
-- reporting one or more days before now.
with route_segments (segment_order, seg_id, length_m) as (
  values
    (1, 'SIM_SK_A_B', 720::numeric),
    (2, 'SIM_SK_B_C', 690::numeric),
    (3, 'SIM_SK_C_D', 810::numeric),
    (4, 'SIM_SK_D_E', 760::numeric),
    (5, 'SIM_SK_E_F', 780::numeric),
    (6, 'SIM_SK_F_A', 740::numeric)
),
event_grid as (
  select
    vehicle.lrv_id,
    vehicle.vehicle_no,
    vehicle.latest_odo_km,
    vehicle.telemetry_stop_days,
    day_offset,
    loop_number,
    segment.segment_order,
    segment.seg_id,
    segment.length_m,
    ((loop_number - 1) * 6 + segment.segment_order) as event_in_day,
    (round(vehicle.daily_km / 4.5))::integer * 6 as events_in_day
  from _demo_vehicle_profile as vehicle
  cross join lateral generate_series(
    -6,
    -vehicle.telemetry_stop_days
  ) as day_offset
  cross join lateral generate_series(
    1,
    greatest(1, round(vehicle.daily_km / 4.5)::integer)
  ) as loop_number
  cross join route_segments as segment
),
timestamped_events as (
  select
    event_grid.*,
    date_trunc('day', now())
      + day_offset * interval '1 day'
      + interval '5 hours 30 minutes'
      + interval '16 hours'
        * ((event_in_day - 1)::double precision
           / greatest(events_in_day - 1, 1)::double precision) as event_ts
  from event_grid
),
ordered_events as (
  select
    timestamped_events.*,
    row_number() over (
      partition by lrv_id
      order by day_offset, loop_number, segment_order
    ) as synthetic_sequence,
    sum(length_m) over (
      partition by lrv_id
      order by day_offset, loop_number, segment_order
      rows between unbounded preceding and current row
    ) as cumulative_m,
    sum(length_m) over (partition by lrv_id) as total_m
  from timestamped_events
  where event_ts <= now()
)
insert into segment_traversals (
  lrv_id,
  seq,
  seg_id,
  ts,
  length_m,
  dir,
  odo_km,
  confidence,
  hdop
)
select
  lrv_id,
  900000000 + synthetic_sequence,
  seg_id,
  event_ts,
  length_m,
  case when loop_number % 2 = 0 then 'W' else 'E' end,
  round((
    latest_odo_km
    - total_m / 1000
    + cumulative_m / 1000
  )::numeric, 3),
  case
    when lrv_id = 'D09' then 0.62
    when lrv_id = 'D30' then 0.48
    when synthetic_sequence % 17 = 0 then 0.78
    else 0.96
  end,
  case
    when lrv_id = 'D09' then 2.60
    when lrv_id = 'D30' then 3.20
    when lrv_id = 'D07' and synthetic_sequence % 5 = 0 then 2.40
    when lrv_id = 'D07' and synthetic_sequence % 3 = 0 then 1.45
    else round((0.68 + (synthetic_sequence % 6) * 0.14)::numeric, 2)
  end
from ordered_events
order by lrv_id, synthetic_sequence
on conflict (lrv_id, seq) do update
set seg_id = excluded.seg_id,
    ts = excluded.ts,
    length_m = excluded.length_m,
    dir = excluded.dir,
    odo_km = excluded.odo_km,
    confidence = excluded.confidence,
    hdop = excluded.hdop;

-- Three normal historical anchors per vehicle.
with anchor_profiles (anchor_number, age_days) as (
  values (1, 35), (2, 20), (3, 5)
),
anchor_values as (
  select
    vehicle.lrv_id,
    anchor.anchor_number,
    anchor.age_days,
    vehicle.latest_odo_km - vehicle.daily_km * anchor.age_days as gnss_odo_km,
    round((((vehicle.vehicle_no + anchor.anchor_number) % 9) - 4) * 0.7, 1) as divergence_km
  from _demo_vehicle_profile as vehicle
  cross join anchor_profiles as anchor
)
insert into mileage_anchors (
  lrv_id,
  ts,
  technician_id,
  source,
  value_km,
  override,
  override_reason,
  image_uri,
  gnss_odo_km,
  divergence_km,
  superseded_by
)
select
  lrv_id,
  date_trunc('day', now()) - age_days * interval '1 day' + interval '8 hours',
  format('TECH_%s', lpad((((anchor_number + substring(lrv_id from 2)::integer) % 6) + 1)::text, 2, '0')),
  case when anchor_number = 3 then 'demo:ocr' else 'demo:manual' end,
  round((gnss_odo_km + divergence_km)::numeric, 1),
  false,
  null,
  format('demo://anchors/%s/%s.jpg', lrv_id, anchor_number),
  round(gnss_odo_km::numeric, 1),
  divergence_km,
  null
from anchor_values;

-- D09 demonstrates an append-only correction. The erroneous anchor points
-- to the later correction; neither record is overwritten.
with d09 as (
  select *
  from _demo_vehicle_profile
  where lrv_id = 'D09'
),
correction as (
  insert into mileage_anchors (
    lrv_id,
    ts,
    technician_id,
    source,
    value_km,
    override,
    override_reason,
    image_uri,
    gnss_odo_km,
    divergence_km,
    superseded_by
  )
  select
    lrv_id,
    date_trunc('day', now()) - interval '2 days' + interval '8 hours 15 minutes',
    'TECH_03',
    'demo:correction',
    round((latest_odo_km + 3.2)::numeric, 1),
    true,
    'Corrected synthetic digit transposition after photo review',
    'demo://anchors/D09/correction.jpg',
    latest_odo_km,
    3.2,
    null
  from d09
  returning id
)
insert into mileage_anchors (
  lrv_id,
  ts,
  technician_id,
  source,
  value_km,
  override,
  override_reason,
  image_uri,
  gnss_odo_km,
  divergence_km,
  superseded_by
)
select
  d09.lrv_id,
  date_trunc('day', now()) - interval '2 days' + interval '8 hours',
  'TECH_03',
  'demo:manual-error',
  round((d09.latest_odo_km + 120)::numeric, 1),
  true,
  'Synthetic digit transposition; superseded after photo review',
  'demo://anchors/D09/superseded.jpg',
  d09.latest_odo_km,
  120,
  correction.id
from d09
cross join correction;

create temporary table _demo_cycle_override (
  lrv_id text not null,
  cycle_type integer not null,
  km_since numeric not null,
  km_to_next numeric not null,
  due_offset_days integer not null,
  primary key (lrv_id, cycle_type)
) on commit drop;

insert into _demo_cycle_override (
  lrv_id,
  cycle_type,
  km_since,
  km_to_next,
  due_offset_days
) values
  ('D07',   2000,   1610,  390,  1),
  ('D07',  13000,  12200,  800,  2),
  ('D12',   2000,   1600,  400,  0),
  ('D18',   2000,   2060,  -60, -3),
  ('D21',   2000,    520, 1480, 10),
  ('D21',  13000,  12680,  320,  2),
  ('D23',   2000,     50, 1950,  5),
  ('D23',  40000,  39580,  420,  1),
  ('D24',  13000,  13020,  -20, -1),
  ('D25',  40000,  39950,   50,  0),
  ('D26', 120000, 118900, 1100,  5),
  ('D27',   2000,    550, 1450, 17),
  ('D28',   2000,   1020,  980, 12);

with cycles (cycle_type, cycle_order) as (
  values
    (2000, 1),
    (13000, 2),
    (40000, 3),
    (120000, 4),
    (360000, 5)
),
defaults as (
  select
    vehicle.lrv_id,
    vehicle.vehicle_no,
    vehicle.daily_km,
    cycles.cycle_type,
    cycles.cycle_order,
    8 + ((vehicle.vehicle_no * 11 + cycles.cycle_order * 17) % 113) as target_days
  from _demo_vehicle_profile as vehicle
  cross join cycles
),
calculated as (
  select
    defaults.*,
    least(
      cycle_type - 10,
      greatest(50, round(daily_km * target_days))
    )::numeric as default_remaining
  from defaults
)
insert into cycle_state (
  lrv_id,
  cycle_type,
  km_since,
  km_to_next,
  due_date
)
select
  calculated.lrv_id,
  calculated.cycle_type,
  coalesce(
    override.km_since,
    calculated.cycle_type - calculated.default_remaining
  ),
  coalesce(
    override.km_to_next,
    calculated.default_remaining
  ),
  current_date + coalesce(
    override.due_offset_days,
    ceil(calculated.default_remaining / calculated.daily_km)::integer
  )
from calculated
left join _demo_cycle_override as override
  on override.lrv_id = calculated.lrv_id
 and override.cycle_type = calculated.cycle_type
on conflict (lrv_id, cycle_type) do update
set km_since = excluded.km_since,
    km_to_next = excluded.km_to_next,
    due_date = excluded.due_date;

commit;

-- Compact load summary for the Supabase SQL editor.
select status, count(*) as vehicles
from vehicles
where fleet = 'splrt'
  and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$'
group by status
order by status;

select
  count(*) as synthetic_traversals,
  min(ts) as first_event,
  max(ts) as latest_event
from segment_traversals
where seg_id like 'SIM\_%' escape '\'
  and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

select count(*) as synthetic_anchors
from mileage_anchors
where source like 'demo:%'
  and lrv_id ~ '^D(0[1-9]|[12][0-9]|30)$';

