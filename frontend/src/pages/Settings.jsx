import { useEffect, useState } from 'react'
import { loadSettings, saveBay, saveCycleRule, savePlanningSettings } from '../lib/api'
import { cycleLabel, formatDuration } from '../lib/format'
import { useSupabaseData } from '../hooks/useSupabaseData'
import { Card, DataBoundary, PageHeader, Toast } from '../components/UI'
import { Icon } from '../components/Icons'

const subscriptions = [{ table: 'planning_settings' }, { table: 'maintenance_cycle_rules' }, { table: 'depot_bays' }]

export function Settings({ reportUpdatedAt }) {
  const state = useSupabaseData(loadSettings, [], subscriptions)
  useEffect(() => { if (state.updatedAt) reportUpdatedAt(state.updatedAt) }, [state.updatedAt, reportUpdatedAt])

  return <>
    <DataBoundary loading={state.loading} error={state.error} empty={!state.data?.settings} onRetry={state.refresh}>
      {state.data && <SettingsForm key={state.updatedAt?.getTime()} initial={state.data} refresh={state.refresh}/>}
    </DataBoundary>
  </>
}

function SettingsForm({ initial, refresh }) {
  const [draft, setDraft] = useState(() => structuredClone(initial))
  const [toast, setToast] = useState(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await savePlanningSettings(draft.settings)
      await Promise.all(draft.rules.map(saveCycleRule))
      await Promise.all(draft.bays.map(saveBay))
      setToast({ message: 'Planning controls saved.', tone: 'success' }); refresh(true)
    } catch (error) { setToast({ message: error.message, tone: 'danger' }) }
    finally { setSaving(false) }
  }

  return <>
    <PageHeader eyebrow="Admin" title="Planning Settings" description="Control the assumptions used by forecasts, recall planning and deployment decisions." actions={<button className="button button-primary" disabled={!draft || saving} onClick={save}><Icon name="check"/>{saving ? 'Saving…' : 'Save changes'}</button>}/>
    <div className="settings-grid">
        <Card title="Forecast & service controls" eyebrow="Fleet-level assumptions">
          <div className="form-grid settings-form">
            <label>Forecast window (days)<input type="number" min="1" max="90" value={draft.settings.forecast_horizon_days} onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, forecast_horizon_days: e.target.value } })}/><small>Days displayed across planning views.</small></label>
            <label>Telemetry stale after (hours)<input type="number" min="1" max="168" value={draft.settings.stale_telemetry_hours} onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, stale_telemetry_hours: e.target.value } })}/><small>Stale rates do not produce forecast dates.</small></label>
            <label>Deployment safety margin (km)<input type="number" min="0" step="10" value={draft.settings.deployment_safety_margin_km} onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, deployment_safety_margin_km: e.target.value } })}/><small>Must remain after a proposed duty.</small></label>
            <label>Minimum service vehicles<input type="number" min="0" max="30" value={draft.settings.minimum_service_vehicles} onChange={(e) => setDraft({ ...draft, settings: { ...draft.settings, minimum_service_vehicles: e.target.value } })}/><small>Confirmed bookings cannot breach this floor.</small></label>
            <label className="form-span">Operating timezone<input value={draft.settings.operating_timezone} disabled/><small>Daily mileage and schedule dates use Singapore time.</small></label>
          </div>
        </Card>
        <Card title="Maintenance cycle rules" eyebrow="LTA-confirmed package scope and continuous bay occupancy">
          <div className="settings-list">{draft.rules.map((rule, index) => { const duration = editableDuration(rule.duration_minutes); return <div className="settings-row" key={rule.cycle_type}><strong>{cycleLabel(rule.cycle_type)}<small>{(rule.included_cycles || [rule.cycle_type]).map(cycleLabel).join(' + ')}</small></strong><label>Tolerance (km)<input type="number" min="0" value={rule.tolerance_km} onChange={(e) => updateList(setDraft, draft, 'rules', index, 'tolerance_km', e.target.value)}/></label><label>Depot/bay stay ({duration.unit})<input type="number" min="0.5" step="0.5" value={duration.value} onChange={(e) => updateList(setDraft, draft, 'rules', index, 'duration_minutes', Number(e.target.value) * duration.multiplier)}/><small>{formatDuration(rule.duration_minutes)} elapsed</small></label><label>Bay type<select value={rule.compatible_bay_type} onChange={(e) => updateList(setDraft, draft, 'rules', index, 'compatible_bay_type', e.target.value)}><option value="universal">Universal</option><option value="heavy">Heavy</option></select></label></div> })}</div>
        </Card>
        <Card title="Depot bays & hours" eyebrow="Scheduling capacity">
          <div className="settings-list">{draft.bays.map((bay, index) => <div className="settings-row bay-settings" key={bay.bay_id}><strong>{bay.name}</strong><label>Opens<input type="time" value={bay.opens_at.slice(0, 5)} onChange={(e) => updateList(setDraft, draft, 'bays', index, 'opens_at', e.target.value)}/></label><label>Closes<input type="time" value={bay.closes_at.slice(0, 5)} onChange={(e) => updateList(setDraft, draft, 'bays', index, 'closes_at', e.target.value)}/></label><label>Capability<select value={bay.bay_type} onChange={(e) => updateList(setDraft, draft, 'bays', index, 'bay_type', e.target.value)}><option value="universal">Universal</option><option value="heavy">Heavy</option></select></label><label className="toggle"><input type="checkbox" checked={bay.active} onChange={(e) => updateList(setDraft, draft, 'bays', index, 'active', e.target.checked)}/><span/>Active</label></div>)}</div>
        </Card>
        <Card title="Technician capture" eyebrow="Future mobile workflow" className="technician-card"><div className="placeholder-feature"><span><Icon name="train" size={28}/></span><div><h3>Phone-based workshop entry</h3><p>A future Vercel-hosted technician view will record hubometer anchors and maintenance completion against this same Supabase project. Realtime will update OCC screens on connected laptops.</p><BadgeLike/></div></div></Card>
      </div>
    <Toast message={toast?.message} tone={toast?.tone} onClose={() => setToast(null)}/>
  </>
}

function updateList(setDraft, draft, key, index, field, value) {
  const rows = draft[key].map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row)
  setDraft({ ...draft, [key]: rows })
}

function editableDuration(minutes) {
  const value = Number(minutes)
  return value >= 1440
    ? { value: value / 1440, multiplier: 1440, unit: 'days' }
    : { value: value / 60, multiplier: 60, unit: 'hours' }
}

function BadgeLike() { return <span className="badge badge-muted">Planned for a later phase</span> }
