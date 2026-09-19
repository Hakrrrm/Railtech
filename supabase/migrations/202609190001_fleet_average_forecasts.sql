begin;

-- Forecast every SPLRT vehicle against the same expected fleet utilisation.
-- Individual recent mileage remains available as history, but a single busy or
-- quiet week no longer permanently accelerates or delays one vehicle's plan.
create or replace view cycle_forecasts
with (security_invoker = true)
as
with fleet_daily_rate as (
  select
    vehicle.fleet,
    round(avg(rate.rolling_daily_rate_km), 2) as rolling_daily_rate_km
  from vehicles as vehicle
  join rolling_vehicle_daily_rate as rate on rate.lrv_id = vehicle.lrv_id
  where vehicle.status = 'in_service'
    and rate.rolling_daily_rate_km > 0
  group by vehicle.fleet
)
select
  cycle.lrv_id, cycle.cycle_type, cycle.km_since, cycle.km_to_next,
  cycle.due_date as seeded_due_date, fleet_rate.rolling_daily_rate_km,
  case
    when cycle.km_to_next <= 0 then
      coalesce(least(cycle.due_date, (now() at time zone 'Asia/Singapore')::date),
               (now() at time zone 'Asia/Singapore')::date)
      - (now() at time zone 'Asia/Singapore')::date
    when mileage.latest_telemetry_at is null then null
    when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then null
    when coalesce(fleet_rate.rolling_daily_rate_km, 0) <= 0 then null
    else ceil(cycle.km_to_next / fleet_rate.rolling_daily_rate_km)::integer
  end as forecast_days,
  case
    when cycle.km_to_next <= 0 then
      coalesce(least(cycle.due_date, (now() at time zone 'Asia/Singapore')::date),
               (now() at time zone 'Asia/Singapore')::date)
    when mileage.latest_telemetry_at is null then null
    when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then null
    when coalesce(fleet_rate.rolling_daily_rate_km, 0) <= 0 then null
    else (now() at time zone 'Asia/Singapore')::date
         + ceil(cycle.km_to_next / fleet_rate.rolling_daily_rate_km)::integer
  end as forecast_date,
  (
    case when cycle.km_to_next <= 0 then 1000 else 0 end
    + case when mileage.status = 'faulty' then 700 when mileage.status = 'maintenance' then 350 else 0 end
    + case when mileage.latest_telemetry_at is null then 250
           when mileage.telemetry_age_hours > coalesce(settings.stale_telemetry_hours, 12) then 200 else 0 end
    + greatest(0, 200 - coalesce(ceil(cycle.km_to_next / nullif(fleet_rate.rolling_daily_rate_km, 0)), 200))
    + case when abs(coalesce(mileage.divergence_km, 0)) >= 50 then 300 else 0 end
  )::numeric as priority_score
from cycle_state as cycle
join vehicle_mileage_summary as mileage on mileage.lrv_id = cycle.lrv_id
left join fleet_daily_rate as fleet_rate on fleet_rate.fleet = mileage.fleet
left join planning_settings as settings on settings.fleet = mileage.fleet;

commit;
