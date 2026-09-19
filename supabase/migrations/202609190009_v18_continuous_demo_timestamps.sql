begin;

-- Refresh the synthetic timeline together, not just the final packet. No
-- mileage, sequence, distance, anchor or maintenance data is rewritten.
create or replace function refresh_v18_demo_packet()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_times timestamptz[];
  v_ids bigint[];
  v_cadence interval;
  v_shift interval;
  v_target timestamptz := now() - interval '5 minutes';
  v_anchor timestamptz;
begin
  -- Once hardware testing starts, demo refreshes must not outrank real traffic.
  if exists (select 1 from segment_traversals where lrv_id = 'D18'
    and not (seq >= 900000000 and seq < 950000000 and seg_id like 'SIM\_%' escape '\')) then
    return;
  end if;
  select array_agg(ts order by seq desc), array_agg(id order by seq desc)
  into v_times, v_ids from (
    select id, seq, ts from segment_traversals where lrv_id = 'D18'
      and seq >= 900000000 and seq < 950000000 and seg_id like 'SIM\_%' escape '\'
    order by seq desc limit 3
  ) latest;
  if coalesce(array_length(v_times,1),0) < 3 then return; end if;
  v_cadence := v_times[2] - v_times[3];
  if v_cadence <= interval '0' or v_cadence > interval '30 minutes' then
    v_cadence := interval '7 minutes';
  end if;
  v_shift := v_target - (v_times[2] + v_cadence);
  select ts into v_anchor from mileage_anchors
    where lrv_id = 'D18' and superseded_by is null order by ts desc limit 1;
  -- Crossing an accepted odometer anchor changes reconciled mileage. Preserve
  -- that boundary if an operator has added an OCR reading since the demo began.
  if v_anchor is not null and exists (
    select 1 from segment_traversals where lrv_id = 'D18'
      and seq >= 900000000 and seq < 950000000 and seg_id like 'SIM\_%' escape '\'
      and (ts > v_anchor) is distinct from
        ((case when id = v_ids[1] then v_target else ts + v_shift end) > v_anchor)
  ) then return; end if;
  update segment_traversals
    set ts = case when id = v_ids[1] then v_target else ts + v_shift end
    where lrv_id = 'D18' and seq >= 900000000 and seq < 950000000
      and seg_id like 'SIM\_%' escape '\';
end;
$$;
revoke all on function refresh_v18_demo_packet() from public, anon, authenticated;
select refresh_v18_demo_packet();
commit;
