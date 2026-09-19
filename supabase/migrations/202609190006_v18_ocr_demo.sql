begin;

-- V18 is the OCR demonstration vehicle. Re-date its latest synthetic packet
-- only; do not fabricate distance, change physical readings or refresh real
-- device traffic. Other deliberately stale demo vehicles remain stale.
create function refresh_v18_demo_packet()
returns void language sql security definer set search_path = public as $$
  update segment_traversals set ts = now() - interval '5 minutes'
  where id = (
    select id from segment_traversals
    where lrv_id = 'D18' and seq >= 900000000 and seq < 950000000
      and seg_id like 'SIM\_%' escape '\'
    order by ts desc, id desc limit 1
  );
$$;
revoke all on function refresh_v18_demo_packet() from public, anon, authenticated;

alter function reset_dashboard_demo() rename to reset_dashboard_demo_before_v18;
revoke all on function reset_dashboard_demo_before_v18() from public, anon, authenticated;
create function reset_dashboard_demo()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform reset_dashboard_demo_before_v18();
  perform refresh_v18_demo_packet();
end;
$$;
revoke all on function reset_dashboard_demo() from public;
grant execute on function reset_dashboard_demo() to anon, authenticated;

-- Repair the installed fixture without resetting bookings or OCR observations.
select refresh_v18_demo_packet();
notify pgrst, 'reload schema';
commit;
