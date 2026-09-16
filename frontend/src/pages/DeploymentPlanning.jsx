import { useEffect, useMemo, useState } from 'react'
import { confirmStockChange, loadDeploymentPlanning, selectStockReplacement } from '../lib/api'
import { formatKm, formatTime, statusLabel } from '../lib/format'
import { useSupabaseData } from '../hooks/useSupabaseData'
import { Badge, Card, DataBoundary, MetricCard, PageHeader, Toast } from '../components/UI'
import { Icon } from '../components/Icons'

const subscriptions = [
  { table: 'vehicles' }, { table: 'duty_assignments' }, { table: 'stock_changes' },
  { table: 'maintenance_bookings' }, { table: 'cycle_state' },
]

export function DeploymentPlanning({ navigate, reportUpdatedAt }) {
  const state = useSupabaseData(loadDeploymentPlanning, [], subscriptions)
  const [toast, setToast] = useState(null)
  const [saving, setSaving] = useState(false)
  const model = useMemo(() => buildDeploymentModel(state.data), [state.data])
  useEffect(() => { if (state.updatedAt) reportUpdatedAt(state.updatedAt) }, [state.updatedAt, reportUpdatedAt])

  const choose = async (change, lrvId) => {
    setSaving(true)
    try { await selectStockReplacement(change.id, lrvId); setToast({ message: `${lrvId} selected as the replacement.`, tone: 'success' }); state.refresh(true) }
    catch (error) { setToast({ message: error.message, tone: 'danger' }) }
    finally { setSaving(false) }
  }
  const confirm = async (change) => {
    setSaving(true)
    try { await confirmStockChange(change.id); setToast({ message: `Stock change confirmed: ${change.withdrawn_lrv_id} → ${change.replacement_lrv_id}.`, tone: 'success' }); state.refresh(true) }
    catch (error) { setToast({ message: error.message, tone: 'danger' }) }
    finally { setSaving(false) }
  }

  return <>
    <PageHeader eyebrow="Service control" title="Fleet Deployment" description="Maintain coverage while mileage forecasts and faults change during the operating day." actions={<button className="button button-secondary" onClick={() => state.refresh()}><Icon name="refresh"/>Refresh duties</button>}/>
    <DataBoundary loading={state.loading} error={state.error} empty={!state.data?.vehicles?.length} onRetry={state.refresh}>
      {model && <>
        <div className="metric-grid">
          <MetricCard label="Assigned" value={model.assigned} detail="Planned or active duties" tone="success" icon="train"/>
          <MetricCard label="Spares on reserve" value={model.reserve} detail="Serviceable at depot" tone="info" icon="shield"/>
          <MetricCard label="In depot" value={model.depot} detail="Maintenance vehicles" tone="warning" icon="wrench"/>
          <MetricCard label="Withdrawn / faulty" value={model.withdrawn} detail="Needs service recovery" tone="danger" icon="alert"/>
        </div>

        <div className="deployment-grid">
          <Card title="Five-hour duty timeline" eyebrow="Current operating window">
            <div className="timeline-head"><span>Vehicle / slot</span>{model.hours.map((hour) => <b key={hour.toISOString()}>{formatTime(hour)}</b>)}</div>
            <div className="timeline-body">{model.assignments.slice(0, 12).map((assignment) => <div className="timeline-row" key={assignment.id}><div><strong>{assignment.lrv_id}</strong><small>{assignment.slot_label} · {assignment.loop_id.replace('Sengkang ', '')}</small></div><div className="timeline-track"><span className={`duty-bar duty-${assignment.vehicleStatus === 'faulty' ? 'withdrawn' : assignment.status}`} style={assignmentStyle(assignment, model.windowStart, model.windowEnd)}>{assignment.vehicleStatus === 'faulty' ? 'Fault · withdraw' : statusLabel(assignment.status)}</span></div></div>)}</div>
          </Card>

          <Card title="Stock-change recommendation" eyebrow="Service-preserving response" className="stock-card">
            {model.proposal ? <><div className="fault-callout"><span><Icon name="alert"/></span><div><strong>{model.proposal.withdrawn_lrv_id} · brake-related withdrawal</strong><p>{model.proposal.reason}</p></div></div>
              <div className="swap-visual"><div><small>Withdraw</small><strong>{model.proposal.withdrawn_lrv_id}</strong></div><span>→</span><div className="replacement"><small>Inject reserve</small><strong>{model.proposal.replacement_lrv_id}</strong></div></div>
              <div className="reason-box"><strong>Projected duty</strong><span>{formatKm(model.proposal.projected_duty_km)} · replacement retains the configured maintenance safety margin.</span></div>
              <button disabled={saving} className="button button-primary button-full" onClick={() => confirm(model.proposal)}>{saving ? 'Validating…' : `Confirm ${model.proposal.withdrawn_lrv_id} → ${model.proposal.replacement_lrv_id}`}</button>
            </> : <div className="nominal"><Icon name="shield" size={34}/><h3>No stock change pending</h3><p>All active duties currently have coverage.</p></div>}
          </Card>
        </div>

        <Card title="Replacement alternatives" eyebrow="Ranked by serviceability, booking conflicts, maintenance margin and wear balance" action={<button className="text-button" onClick={() => navigate('maintenance')}>View depot bookings <Icon name="chevron"/></button>}>
          <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Vehicle</th><th>Availability</th><th>Maintenance margin</th><th>Rolling use</th><th>After projected duty</th><th/></tr></thead><tbody>
            {model.alternatives.slice(0, 8).map((item, index) => <tr key={item.lrv_id}><td><span className={`queue-rank ${index === 0 ? 'recommended' : ''}`}>{index + 1}</span></td><td><strong>{item.lrv_id}</strong><small>{statusLabel(item.status)}</small></td><td><Badge value={availabilityLabel(item)} tone={item.eligible ? 'success' : 'muted'}/></td><td>{formatKm(item.nearest_cycle_margin_km)}</td><td>{formatKm(item.rolling_daily_rate_km)}/day</td><td><strong>{formatKm(Number(item.available_duty_margin_km) - Number(model.proposal?.projected_duty_km || 0))}</strong></td><td>{model.proposal && <button className="button button-small button-secondary" disabled={!item.eligible || saving || item.lrv_id === model.proposal.replacement_lrv_id} onClick={() => choose(model.proposal, item.lrv_id)}>{item.lrv_id === model.proposal.replacement_lrv_id ? 'Selected' : 'Choose'}</button>}</td></tr>)}
          </tbody></table></div>
        </Card>
      </>}
    </DataBoundary>
    <Toast message={toast?.message} tone={toast?.tone} onClose={() => setToast(null)}/>
  </>
}

function buildDeploymentModel(data) {
  if (!data) return null
  const activeAssignments = data.assignments.filter((row) => ['planned', 'active'].includes(row.status))
  const vehicleStatus = new Map(data.vehicles.map((row) => [row.lrv_id, row.status]))
  const now = new Date(); const windowStart = now; const windowEnd = new Date(now.getTime() + 5 * 3600000)
  return {
    assigned: activeAssignments.filter((row) => vehicleStatus.get(row.lrv_id) === 'in_service').length,
    reserve: data.vehicles.filter((row) => row.status === 'idle').length,
    depot: data.vehicles.filter((row) => row.status === 'maintenance').length,
    withdrawn: data.vehicles.filter((row) => row.status === 'faulty').length,
    assignments: activeAssignments.map((row) => ({ ...row, vehicleStatus: vehicleStatus.get(row.lrv_id) })).sort((a, b) => Number(b.vehicleStatus === 'faulty') - Number(a.vehicleStatus === 'faulty') || a.lrv_id.localeCompare(b.lrv_id)),
    alternatives: [...data.eligibility].sort((a, b) => Number(b.eligible) - Number(a.eligible) || Number(b.free_of_booking) - Number(a.free_of_booking) || Number(b.free_of_duty) - Number(a.free_of_duty) || Number(b.available_duty_margin_km) - Number(a.available_duty_margin_km) || Number(a.rolling_daily_rate_km) - Number(b.rolling_daily_rate_km)),
    proposal: data.changes.find((row) => row.decision_status === 'proposed') || null,
    hours: Array.from({ length: 6 }, (_, index) => new Date(windowStart.getTime() + index * 3600000)), windowStart, windowEnd,
  }
}

function availabilityLabel(item) {
  if (item.eligible) return 'Eligible'
  if (!['idle', 'in_service'].includes(item.status)) return statusLabel(item.status)
  if (!item.free_of_booking) return 'Depot booking'
  if (!item.free_of_duty) return 'Already assigned'
  return 'Margin too low'
}

function assignmentStyle(assignment, start, end) {
  const total = end - start
  const left = Math.max(0, (new Date(assignment.duty_start) - start) / total * 100)
  const right = Math.min(100, (new Date(assignment.duty_end) - start) / total * 100)
  return { left: `${left}%`, width: `${Math.max(4, right - left)}%` }
}
