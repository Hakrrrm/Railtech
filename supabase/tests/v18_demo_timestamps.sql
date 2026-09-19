begin;
create temp table v18_before as select
  (select jsonb_agg(to_jsonb(t) - 'ts' order by id) from segment_traversals t where lrv_id='D18') as evidence,
  (select jsonb_agg(to_jsonb(t) order by id) from mileage_anchors t where lrv_id='D18') as anchors,
  (select jsonb_agg(to_jsonb(t) order by cycle_type) from cycle_state t where lrv_id='D18') as cycles;
select refresh_v18_demo_packet();
do $$
declare v_before record; v_gap interval;
begin
  select * into v_before from v18_before;
  if v_before.evidence is distinct from (select jsonb_agg(to_jsonb(t) - 'ts' order by id) from segment_traversals t where lrv_id='D18')
    or v_before.anchors is distinct from (select jsonb_agg(to_jsonb(t) order by id) from mileage_anchors t where lrv_id='D18')
    or v_before.cycles is distinct from (select jsonb_agg(to_jsonb(t) order by cycle_type) from cycle_state t where lrv_id='D18') then
    raise exception 'Refresh changed protected V18 evidence';
  end if;
  select max(gap) into v_gap from (
    select ts - lead(ts) over (order by seq desc) gap from (
      select seq, ts from segment_traversals where lrv_id='D18'
        and seq >= 900000000 and seq < 950000000 order by seq desc limit 12
    ) recent
  ) differences;
  if v_gap is null or v_gap <= interval '0' or v_gap > interval '30 minutes' then
    raise exception 'Recent V18 synthetic traversal timeline still has a gap: %', v_gap;
  end if;
end;
$$;
rollback;
