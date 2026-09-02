import { useState, useEffect } from 'react'
import { supabase } from './supabaseClient'

function App() {
  const [lrvId, setLrvId] = useState('D07')
  const [manualReading, setManualReading] = useState('')
  const [gnssOdo, setGnssOdo] = useState(0)
  const [lastManualOdo, setLastManualOdo] = useState(0)
  
  const [recentEvents, setRecentEvents] = useState([])
  const [auditLogs, setAuditLogs] = useState([])
  
  const [needsOverride, setNeedsOverride] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const [message, setMessage] = useState('')

  async function fetchData() {
    // Ordered by id (the table's own auto-incrementing primary key --
    // insertion order into Supabase), not by the device-reported seq.
    // seq is normally monotonic per device (seq_store persists it across
    // reboots), but a test/load-generator harness with its own counter
    // can restart lower than what's already recorded, and ordering by
    // seq would then silently hide its rows from "most recent" instead
    // of just mis-ordering them. id has no such dependency on anything
    // a device reports -- Postgres assigns it, so it's always accurate
    // for "most recently written," independent of device state. Revisit
    // if/when SD backfill-after-outage ships: a backfilled old event
    // would get a new high id despite being chronologically old.
    const { data: traversals } = await supabase
      .from('segment_traversals')
      .select('id, ts, seg_id, dir, odo_km, hdop')
      .eq('lrv_id', lrvId)
      .order('id', { ascending: false })
      .limit(5)
      
    if (traversals && traversals.length > 0) {
      setGnssOdo(traversals[0].odo_km)
      setRecentEvents(traversals)
    } else {
      setGnssOdo(0)
      setRecentEvents([]) 
    }

    const { data: anchors } = await supabase
      .from('mileage_anchors')
      .select('value_km')
      .eq('lrv_id', lrvId)
      .is('superseded_by', null)
      .order('ts', { ascending: false })
      .limit(1)

    if (anchors && anchors.length > 0) {
      setLastManualOdo(anchors[0].value_km)
    } else {
      setLastManualOdo(0)
    }

    const { data: history } = await supabase
      .from('mileage_anchors')
      .select('ts, technician_id, value_km, divergence_km, override')
      .eq('lrv_id', lrvId)
      .order('ts', { ascending: false })
      .limit(5)
      
    if (history) {
      setAuditLogs(history)
    } else {
      setAuditLogs([])
    }
  }

  useEffect(() => {
    fetchData()
  }, [lrvId])

  const handleReadingChange = (e) => {
    const val = parseFloat(e.target.value)
    setManualReading(e.target.value)

    if (!val) {
      setNeedsOverride(false)
      return
    }
    
    const isLower = val < lastManualOdo;
    const drift = Math.abs(val - gnssOdo);
    const isHighDrift = drift > (gnssOdo * 0.05);

    setNeedsOverride(isLower || isHighDrift)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    
    if (needsOverride && !overrideReason) {
      setMessage("❌ Error: You must provide an override reason.")
      return
    }

    const finalReading = parseFloat(manualReading)
    const divergence = finalReading - gnssOdo

    const { error } = await supabase
      .from('mileage_anchors')
      .insert([
        {
          lrv_id: lrvId,
          ts: new Date().toISOString(),
          technician_id: 'TECH_01', 
          source: 'manual_entry',
          value_km: finalReading,
          gnss_odo_km: gnssOdo,
          divergence_km: divergence,
          override: needsOverride,
          override_reason: needsOverride ? overrideReason : null
        }
      ])

    if (error) {
      setMessage("❌ Database Error: " + error.message)
    } else {
      setMessage("✅ Success: New mileage anchor securely recorded!")
      setManualReading('')
      setOverrideReason('')
      setNeedsOverride(false)
      fetchData() 
    }
  }

  return (
    <div style={{ padding: '40px 24px', maxWidth: '1200px', margin: '0 auto', textAlign: 'left', background: '#f8fafc', minHeight: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      
      {/* Enterprise Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px', marginBottom: '32px', borderBottom: '2px solid #cbd5e1', paddingBottom: '20px' }}>
        <div>
          {/* LTA Logo & Department Tag */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
            <img 
              src="https://www.lta.gov.sg/content/dam/ltagov/img/general/logo.png" 
              alt="LTA Logo" 
              style={{ height: '48px', width: 'auto', display: 'block' }} 
            />
            <div style={{ width: '2px', height: '32px', background: '#cbd5e1', borderRadius: '2px' }}></div>
            <span style={{ fontSize: '12px', fontWeight: '800', color: '#64748b', letterSpacing: '1.5px', textTransform: 'uppercase' }}>
              Light Rail Transit Division
            </span>
          </div>
          
          <h1 style={{ fontSize: '26px', margin: '0 0 4px 0', color: '#0f172a', fontWeight: '800', letterSpacing: '-0.75px' }}>LRV MAINTENANCE TERMINAL</h1>
          <p style={{ color: '#475569', fontSize: '13px', margin: 0, fontWeight: '500' }}>Real-time telemetry tracking & physical hubometer validation module</p>
        </div>
        
        <div style={{ background: '#ffffff', padding: '10px 14px', borderRadius: '8px', border: '1px solid #cbd5e1', boxShadow: '0 1px 3px rgba(0,0,0,0.02)' }}>
          <label style={{ display: 'block', fontSize: '10px', color: '#64748b', fontWeight: '800', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Active Fleet Unit
          </label>
          <select 
            value={lrvId} 
            onChange={(e) => setLrvId(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #94a3b8', background: '#f8fafc', color: '#0f172a', fontSize: '14px', fontWeight: '700', outline: 'none', cursor: 'pointer', minWidth: '130px' }}
          >
            <option value="D07">LRV - D07</option>
            <option value="D08">LRV - D08</option>
            <option value="D09">LRV - D09</option>
          </select>
        </div>
      </div>
      
      {/* TWO-COLUMN LAYOUT WRAPPER */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '32px', alignItems: 'flex-start' }}>
        
        {/* LEFT COLUMN: ACTION PANEL */}
        <div style={{ flex: '1 1 350px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* Overview Cards (Stacked Vertically) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ background: '#ffffff', border: '1px solid #cbd5e1', borderLeft: '5px solid #0284c7', padding: '22px 24px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h4 style={{ margin: 0, color: '#475569', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '1px', fontWeight: '800' }}>Auto-Tracked Mileage</h4>
                <span style={{ fontSize: '10px', background: '#e0f2fe', color: '#0369a1', padding: '2px 6px', borderRadius: '4px', fontWeight: '700' }}>Live Feed</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <h2 style={{ margin: 0, color: '#0f172a', fontSize: '36px', fontFamily: 'monospace', fontWeight: '800', letterSpacing: '-1px' }}>{gnssOdo}</h2>
                <span style={{ fontSize: '15px', color: '#64748b', fontWeight: '700' }}>km</span>
              </div>
              <div style={{ marginTop: '12px', fontSize: '12px', color: '#64748b', borderTop: '1px solid #f1f5f9', paddingTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
                <span>Target Node:</span>
                <strong style={{ color: '#0f172a', fontFamily: 'monospace' }}>{lrvId}</strong>
              </div>
            </div>
            
            <div style={{ background: '#ffffff', border: '1px solid #cbd5e1', borderLeft: '5px solid #f97316', padding: '22px 24px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h4 style={{ margin: 0, color: '#475569', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '1px', fontWeight: '800' }}>Last Physical Check</h4>
                <span style={{ fontSize: '10px', background: '#ffedd5', color: '#c2410c', padding: '2px 6px', borderRadius: '4px', fontWeight: '700' }}>Verified</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <h2 style={{ margin: 0, color: '#0f172a', fontSize: '36px', fontFamily: 'monospace', fontWeight: '800', letterSpacing: '-1px' }}>{lastManualOdo}</h2>
                <span style={{ fontSize: '15px', color: '#64748b', fontWeight: '700' }}>km</span>
              </div>
              <div style={{ marginTop: '12px', fontSize: '12px', color: '#64748b', borderTop: '1px solid #f1f5f9', paddingTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
                <span>Baseline Status:</span>
                <strong style={{ color: '#16a34a' }}>Synchronized</strong>
              </div>
            </div>
          </div>

          {/* Manual Input Form */}
          <div style={{ background: '#ffffff', border: '1px solid #cbd5e1', padding: '28px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
            <div style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: '12px', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, color: '#0f172a', fontSize: '15px', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Hubometer Validation Input
              </h3>
            </div>
            
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <input 
                  type="number" 
                  step="0.1"
                  value={manualReading} 
                  onChange={handleReadingChange} 
                  placeholder="Enter hubometer reading (km)..."
                  style={{ width: '100%', padding: '14px 16px', borderRadius: '6px', border: '1px solid #94a3b8', background: '#ffffff', color: '#0f172a', fontSize: '15px', fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }}
                  required
                />
                
                <label style={{ 
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                  background: '#f1f5f9', border: '1px solid #cbd5e1', color: '#334155', 
                  padding: '14px 20px', borderRadius: '6px', cursor: 'pointer', fontWeight: '700', fontSize: '14px',
                  width: '100%', boxSizing: 'border-box', transition: 'background 0.15s'
                }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                    <circle cx="12" cy="13" r="4"/>
                  </svg>
                  Scan Hubometer
                  <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} />
                </label>
              </div>

              {needsOverride && (
                <div style={{ borderLeft: '4px solid #dc2626', padding: '16px', background: '#fef2f2', borderRadius: '0 6px 6px 0', border: '1px solid #fca5a5' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#991b1b', marginBottom: '6px' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>                    <span style={{ fontSize: '13px', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Plausibility Threshold Exceeded</span>
                  </div>
                  <p style={{ fontSize: '13px', margin: '0 0 10px 0', color: '#b91c1c' }}>The entered reading diverges outside acceptable tracking tolerances. Engineering justification is required.</p>
                  <textarea 
                    value={overrideReason} 
                    onChange={(e) => setOverrideReason(e.target.value)} 
                    placeholder="Enter mandatory technical override justification..."
                    style={{ width: '100%', padding: '10px 12px', border: '1px solid #fca5a5', borderRadius: '4px', background: '#ffffff', color: '#0f172a', boxSizing: 'border-box', minHeight: '70px', outline: 'none', fontSize: '13px' }}
                    required
                  />
                </div>
              )}

              <button type="submit" style={{ padding: '16px', background: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: '800', fontSize: '14px', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '1px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', width: '100%' }}>
                Commit Hubometer Record
              </button>
            </form>
            {message && <div style={{ marginTop: '16px', padding: '10px 14px', borderRadius: '4px', background: '#f1f5f9', border: '1px solid #cbd5e1', color: '#0f172a', fontWeight: '600', fontSize: '13px' }}>{message}</div>}
          </div>
        </div>

        {/* RIGHT COLUMN: DATA FEED */}
        <div style={{ flex: '1.8 1 500px', display: 'flex', flexDirection: 'column', gap: '32px' }}>
          
          {/* Telemetry Event Log */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ color: '#0f172a', fontSize: '15px', fontWeight: '800', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Live Vehicle Tracking Stream</h3>
              <span style={{ fontSize: '12px', color: '#64748b', fontWeight: '600' }}>Last 5 map-matched segments</span>
            </div>
            <div style={{ overflowX: 'auto', background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                <thead>
                  <tr style={{ background: '#f1f5f9', borderBottom: '2px solid #cbd5e1' }}>
                    <th style={{ padding: '12px 16px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.5px' }}>Timestamp</th>
                    <th style={{ padding: '12px 16px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.5px' }}>Track Section</th>
                    <th style={{ padding: '12px 16px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.5px' }}>Dir</th>
                    <th style={{ padding: '12px 16px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.5px' }}>Est. Mileage</th>
                    <th style={{ padding: '12px 16px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.5px' }}>GPS Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {recentEvents.length === 0 ? (
                    <tr>
                      <td colSpan="5" style={{ padding: '24px', textAlign: 'center', color: '#64748b' }}>No telemetry data packets received.</td>
                    </tr>
                  ) : (
                    recentEvents.map((ev, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '12px 16px', color: '#475569', fontFamily: 'monospace' }}>
                          {new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </td>
                        <td style={{ padding: '12px 16px', color: '#0f172a', fontWeight: '700' }}>{ev.seg_id}</td>
                        <td style={{ padding: '12px 16px', color: '#475569', fontWeight: '600' }}>{ev.dir}</td>
                        <td style={{ padding: '12px 16px', fontWeight: '800', color: '#0f172a', fontFamily: 'monospace' }}>{ev.odo_km} km</td>
                        <td style={{ padding: '12px 16px' }}>
                          {ev.hdop != null ? (
                            <span style={{ 
                              display: 'inline-flex', alignItems: 'center', gap: '5px',
                              padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '800', textTransform: 'uppercase',
                              background: ev.hdop < 1.0 ? '#dcfce7' : ev.hdop < 2.0 ? '#fef3c7' : '#fee2e2',
                              color: ev.hdop < 1.0 ? '#166534' : ev.hdop < 2.0 ? '#92400e' : '#991b1b'
                            }}>
                              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: ev.hdop < 1.0 ? '#166534' : ev.hdop < 2.0 ? '#92400e' : '#991b1b' }}></span>
                              {ev.hdop < 1.0 ? 'Strong' : ev.hdop < 2.0 ? 'Fair' : 'Weak'}
                            </span>
                          ) : (
                            <span style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '11px', background: '#e2e8f0', color: '#475569' }}>N/A</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Divergence Audit History */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ color: '#0f172a', fontSize: '15px', fontWeight: '800', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Manual Entry & Audit History</h3>
              <span style={{ fontSize: '12px', color: '#64748b', fontWeight: '600' }}>Archived validation logs</span>
            </div>
            <div style={{ overflowX: 'auto', background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                <thead>
                  <tr style={{ background: '#f1f5f9', borderBottom: '2px solid #cbd5e1' }}>
                    <th style={{ padding: '12px 16px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.5px' }}>Timestamp</th>
                    <th style={{ padding: '12px 16px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.5px' }}>Tech ID</th>
                    <th style={{ padding: '12px 16px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.5px' }}>Logged Value</th>
                    <th style={{ padding: '12px 16px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.5px' }}>Drift Delta</th>
                    <th style={{ padding: '12px 16px', color: '#475569', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', letterSpacing: '0.5px' }}>Override Status</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan="5" style={{ padding: '24px', textAlign: 'center', color: '#64748b' }}>No manual audit records found for this unit.</td>
                    </tr>
                  ) : (
                    auditLogs.map((log, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '12px 16px', color: '#475569', fontFamily: 'monospace' }}>
                          {new Date(log.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td style={{ padding: '12px 16px', color: '#475569', fontWeight: '600' }}>{log.technician_id}</td>
                        <td style={{ padding: '12px 16px', fontWeight: '800', color: '#0f172a', fontFamily: 'monospace' }}>{log.value_km} km</td>
                        <td style={{ padding: '12px 16px', color: '#475569', fontFamily: 'monospace' }}>
                          <span style={{ 
                            color: Math.abs(log.divergence_km) > 10 ? '#dc2626' : '#475569',
                            fontWeight: Math.abs(log.divergence_km) > 10 ? '800' : '600'
                          }}>
                            {log.divergence_km > 0 ? '+' : ''}{log.divergence_km?.toFixed(1)} km
                          </span>
                        </td>
                        <td style={{ padding: '12px 16px' }}>
                          {log.override ? (
                            <span style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '800' }}>FLAGGED OVERRIDE</span>
                          ) : (
                            <span style={{ color: '#16a34a', fontWeight: '700', fontSize: '12px' }}>Normal</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
          
        </div>
      </div>
    </div>
  )
}

export default App