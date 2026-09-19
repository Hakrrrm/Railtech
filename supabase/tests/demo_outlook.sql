-- Run after installing the synthetic fixture. All changes roll back.
begin;
select restore_demo_outlook_bookings();
select restore_demo_outlook_bookings();
do $$
declare v_counts integer[];
begin
  if (select count(*) from maintenance_bookings where demo_key like 'demo:booking:outlook:%' and status = 'confirmed') <> 6 then
    raise exception 'Expected six idempotently restored routine visits';
  end if;
  if exists (select 1 from maintenance_bookings where demo_key like 'demo:booking:outlook:%' and (lrv_id = 'D18' or end_at - start_at <> case primary_cycle when 13000 then interval '4 hours' else interval '2 hours' end)) then
    raise exception 'Incorrect fixture vehicle or maintenance duration';
  end if;
  select array_agg(n order by day) into v_counts from (
    select day, count(b.id)::integer as n
    from generate_series(0,13) day
    left join maintenance_bookings b on b.status in ('confirmed','proposed')
      and b.start_at < (((now() at time zone 'Asia/Singapore')::date + day + 1)::timestamp at time zone 'Asia/Singapore')
      and b.end_at > (((now() at time zone 'Asia/Singapore')::date + day)::timestamp at time zone 'Asia/Singapore')
    group by day
  ) occupancy;
  if (select count(distinct n) from unnest(v_counts) n) < 3 then
    raise exception 'Expected varied daily occupancy: %', v_counts;
  end if;
  raise notice 'Daily occupancy: %', v_counts;
end;
$$;
rollback;
