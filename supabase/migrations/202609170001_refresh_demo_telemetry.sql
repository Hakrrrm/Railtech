begin;

-- Keep the deterministic demo scenario usable on any day it is reset. The
-- seed creates SIM_* telemetry relative to the day it is first installed, but
-- the dashboard intentionally suppresses forecasts once telemetry is older
-- than the configured freshness threshold. Rebase only seed-owned packets so
-- the normal vehicles become current again while the deliberately stale
-- vehicles retain their relative age gaps.
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
