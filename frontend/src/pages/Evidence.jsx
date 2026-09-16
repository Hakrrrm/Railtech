import { useEffect, useMemo, useState } from 'react'
import { loadEvidence } from '../lib/api'
import { cycleLabel, formatDateTime, formatKm, vehicleLabel } from '../lib/format'
import { useSupabaseData } from '../hooks/useSupabaseData'
import { Badge, Card, DataBoundary, MetricCard, PageHeader } from '../components/UI'
import { Icon } from '../components/Icons'

const subscriptions = [{ table: 'mileage_anchors', event: 'INSERT' }, { table: 'maintenance_events', event: 'INSERT' }, { table: 'stock_changes' }]

export function Evidence({ navigate, reportUpdatedAt }) {
  const state = useSupabaseData(loadEvidence, [], subscriptions)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const model = useMemo(() => buildEvidence(state.data, filter, search), [state.data, filter, search])
  useEffect(() => { if (state.updatedAt) reportUpdatedAt(state.updatedAt) }, [state.updatedAt, reportUpdatedAt])
  return <>
    <PageHeader eyebrow="Traceability" title="Evidence & Audit" description="Physical readings, corrections, completed maintenance and deployment decisions in one chronology." actions={<button className="button button-secondary" onClick={() => state.refresh()}><Icon name="refresh"/>Refresh</button>}/>
    <DataBoundary loading={state.loading} error={state.error} empty={!state.data || model.total === 0} onRetry={state.refresh}>
      {model && <>
        <div className="metric-grid">
          <MetricCard label="Mileage anchors" value={state.data.anchors.length} detail="Physical and corrected records" tone="info" icon="evidence"/>
          <MetricCard label="Superseded entries" value={model.superseded} detail="Retained for audit" tone="warning" icon="refresh"/>
          <MetricCard label="Maintenance completions" value={state.data.events.length} detail="Definite mileage captured" tone="success" icon="wrench"/>
          <MetricCard label="Stock decisions" value={state.data.changes.length} detail="Proposed and confirmed" tone="neutral" icon="train"/>
        </div>
        <Card title="Chronological audit trail" eyebrow="Append-only operational evidence" action={<div className="filter-bar"><input aria-label="Search vehicle" placeholder="Search LRV…" value={search} onChange={(event) => setSearch(event.target.value.toUpperCase())}/><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All evidence</option><option value="mileage">Mileage</option><option value="maintenance">Maintenance</option><option value="deployment">Deployment</option></select></div>}>
          <div className="audit-timeline">{model.items.map((item) => <article key={item.key}><span className={`audit-icon audit-${item.type}`}><Icon name={item.type === 'mileage' ? 'evidence' : item.type === 'maintenance' ? 'wrench' : 'train'}/></span><div className="audit-main"><div><Badge value={item.type} tone={item.type === 'maintenance' ? 'success' : item.type === 'deployment' ? 'info' : 'neutral'}/><strong>{item.title}</strong>{item.badge && <Badge value={item.badge} tone={['Superseded', 'Partial scope'].includes(item.badge) ? 'warning' : undefined}/>}</div><p>{item.description}</p><small>{formatDateTime(item.time)} · {item.actor}</small></div><button className="icon-button" onClick={() => item.lrvId && navigate(`vehicle/${item.lrvId}`)} disabled={!item.lrvId}><Icon name="chevron"/></button></article>)}</div>
        </Card>
      </>}
    </DataBoundary>
  </>
}

function buildEvidence(data, filter, search) {
  if (!data) return null
  const observations = new Map((data.observations || []).map((row) => [Number(row.anchor_id), row]))
  const anchors = data.anchors.map((row) => { const observation = observations.get(Number(row.id)); const ocrNote = observation ? ` OCR confidence ${Math.round(Number(observation.ocr_confidence) * 100)}%; ${observation.reviewed_manually ? 'manually verified' : 'accepted without edit'}.` : ''; return { key: `a-${row.id}`, type: 'mileage', lrvId: row.lrv_id, time: row.ts, actor: row.technician_id || row.source, title: `${vehicleLabel(row.lrv_id)} physical reading · ${formatKm(row.value_km, 1)}`, description: `Compared with ${formatKm(row.gnss_odo_km, 1)} device mileage; divergence ${formatKm(row.divergence_km, 1)}.${ocrNote}${row.override_reason ? ` ${row.override_reason}.` : ''}`, badge: row.superseded_by ? 'Superseded' : row.override ? 'Override' : 'Accepted' } })
  const events = data.events.map((row) => { const corrective = row.work_type === 'corrective'; const completed = row.reset_cycles || []; const planned = corrective ? [] : data.rules.find((rule) => Number(rule.cycle_type) === Number(row.primary_cycle))?.included_cycles || [row.primary_cycle]; const partial = !corrective && planned.some((cycle) => !completed.map(Number).includes(Number(cycle))); return { key: `m-${row.id}`, type: 'maintenance', lrvId: row.lrv_id, time: row.completed_at, actor: row.technician_id, title: `${vehicleLabel(row.lrv_id)} closed ${corrective ? 'corrective repair' : `${cycleLabel(row.primary_cycle)} visit`}`, description: corrective ? `${formatKm(row.completion_mileage_km, 1)} definite reading; fault repair closed. ${row.notes || ''}` : `${formatKm(row.completion_mileage_km, 1)} definite reading; technician confirmed ${completed.map(cycleLabel).join(', ')}. ${row.notes || ''}`, badge: partial ? 'Partial scope' : 'Completed' } })
  const changes = data.changes.map((row) => ({ key: `s-${row.id}`, type: 'deployment', lrvId: row.withdrawn_lrv_id, time: row.decided_at || row.created_at, actor: row.decided_by || 'OCC planner', title: `${vehicleLabel(row.withdrawn_lrv_id)} → ${vehicleLabel(row.replacement_lrv_id)} stock change`, description: `${row.reason} Projected duty ${formatKm(row.projected_duty_km)}.`, badge: row.decision_status }))
  const all = [...anchors, ...events, ...changes].sort((a, b) => new Date(b.time) - new Date(a.time))
  return { total: all.length, superseded: data.anchors.filter((row) => row.superseded_by).length, items: all.filter((item) => (filter === 'all' || item.type === filter) && (!search || item.title.includes(search))).slice(0, 80) }
}
