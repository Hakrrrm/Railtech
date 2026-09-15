import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabaseClient'

// --- SVG ICONS ---
const Icons = {
  Grid: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>,
  Wrench: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>,
  MapPin: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>,
  Settings: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>,
  ChevronDown: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>,
  Alert: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>,
  Clock: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>,
  Gear: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>,
  Clipboard: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>,
  Train: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="16" rx="2" ry="2"></rect><path d="M4 11h16"></path><path d="M12 3v8"></path><path d="M8 19l-2 3"></path><path d="M16 19l2 3"></path><path d="M8 15h0"></path><path d="M16 15h0"></path></svg>,
};

function App() {
  // --- NAVIGATION STATE ---
  const [activeNav, setActiveNav] = useState('fleet_overview')
  const [selectedVehicle, setSelectedVehicle] = useState(null)
  const [adminMenuOpen, setAdminMenuOpen] = useState(false)

  // --- FLEET DATA STATE ---
  const [fleetData, setFleetData] = useState([])
  const [globalEvents, setGlobalEvents] = useState([])
  const [globalAuditLogs, setGlobalAuditLogs] = useState([])
  const [allCycles, setAllCycles] = useState([])

  // --- VEHICLE & FORM DETAIL STATE ---
  const [lrvId, setLrvId] = useState('D07')
  const [manualReading, setManualReading] = useState('')
  const [gnssOdo, setGnssOdo] = useState(0)
  const [lastManualOdo, setLastManualOdo] = useState(0)
  const [recentEvents, setRecentEvents] = useState([])
  const [auditLogs, setAuditLogs] = useState([])
  const [needsOverride, setNeedsOverride] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const [message, setMessage] = useState('')

  // --- DATA FETCHING ---
  const fetchFleetData = useCallback(async () => {
    // 1. Fetch full vehicle list ordered by lrv_id
    const { data: vData } = await supabase.from('vehicles').select('*').order('lrv_id', { ascending: true }) 
    const { data: cycles } = await supabase.from('cycle_state').select('*').order('km_to_next', { ascending: true }) 
    
    // Global logs for the fleet view
    const { data: globalT } = await supabase.from('segment_traversals').select('lrv_id, ts, seg_id, dir, odo_km, hdop').order('id', { ascending: false }).limit(10)
    if (globalT) setGlobalEvents(globalT)

    const { data: globalLogs } = await supabase.from('mileage_anchors').select('lrv_id, ts, technician_id, value_km, divergence_km, override').order('id', { ascending: false }).limit(10)
    if (globalLogs) setGlobalAuditLogs(globalLogs)

    if (vData) {
      // 4. Fetch the absolute latest traversal per vehicle via mapping
      const traversalPromises = vData.map(v => 
        supabase.from('segment_traversals').select('lrv_id, ts, seg_id, dir, odo_km, hdop').eq('lrv_id', v.lrv_id).order('id', { ascending: false }).limit(1)
      );
      const traversalResults = await Promise.all(traversalPromises);
      
      const latestPerVehicle = {};
      traversalResults.forEach(res => {
        if (res.data && res.data.length > 0) {
          latestPerVehicle[res.data[0].lrv_id] = res.data[0];
        }
      });

      const finalFleetArray = vData.map(v => {
        const telemetry = latestPerVehicle[v.lrv_id] || {};
        return { 
          lrv_id: v.lrv_id,
          status: v.status || 'idle', // 9. Use pure vehicle status 
          seg_id: telemetry.seg_id || 'Depot',
          odo_km: telemetry.odo_km || 0,
          hdop: telemetry.hdop || null,
          run_time_minutes: null // 2. Deprecated daily_run_time mapping
        }
      })
      setFleetData(finalFleetArray)
    }
    if (cycles) setAllCycles(cycles);
  }, []);

  const fetchVehicleData = useCallback(async () => {
    const targetLrv = selectedVehicle || lrvId;
    if (!targetLrv) return;

    // 7. Sort explicitly by id descending
    const { data: traversals } = await supabase.from('segment_traversals').select('ts, seg_id, dir, odo_km, hdop').eq('lrv_id', targetLrv).order('id', { ascending: false }).limit(5)
    if (traversals && traversals.length > 0) {
      setGnssOdo(traversals[0].odo_km); 
      setRecentEvents(traversals);
    } else {
      setGnssOdo(0); 
      setRecentEvents([]);
    }

    const { data: anchors } = await supabase.from('mileage_anchors').select('value_km').eq('lrv_id', targetLrv).is('superseded_by', null).order('ts', { ascending: false }).limit(1)
    setLastManualOdo(anchors && anchors.length > 0 ? anchors[0].value_km : 0)

    // 5. Included lrv_id in history pull
    const { data: history } = await supabase.from('mileage_anchors').select('lrv_id, ts, technician_id, value_km, divergence_km, override').eq('lrv_id', targetLrv).order('id', { ascending: false }).limit(10)
    if (history) setAuditLogs(history)
  }, [selectedVehicle, lrvId]);

  // --- WEBSOCKET SUBSCRIPTION ---
  useEffect(() => {
    fetchFleetData(); fetchVehicleData();
    const channelName = `realtime-feed-${Date.now()}`
    const lrvChannel = supabase.channel(channelName)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'segment_traversals' }, () => { fetchFleetData(); fetchVehicleData() })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mileage_anchors' }, () => { fetchFleetData(); fetchVehicleData() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cycle_state' }, () => { fetchFleetData() })
      .subscribe()
    return () => { supabase.removeChannel(lrvChannel) }
  }, [fetchFleetData, fetchVehicleData])

  // --- HELPERS & DERIVATIONS ---
  const formatRunTime = (totalMinutes) => {
    if (totalMinutes === null || totalMinutes === undefined || isNaN(totalMinutes) || totalMinutes < 1) return '--';
    const d = Math.floor(totalMinutes / 1440);
    const h = Math.floor((totalMinutes % 1440) / 60);
    const m = Math.floor(totalMinutes % 60);
    let parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || parts.length === 0) parts.push(`${m}m`);
    return parts.join(' ');
  };

  const getPMThresholds = (odo, vehicleId) => {
    const vehicleCycles = allCycles.filter(c => c.lrv_id === vehicleId);
    const defThreshold = (cycle) => cycle - ((odo || 0) % cycle);
    // 3. Strict numeric cycle matching
    return {
      next2k: vehicleCycles.find(c => c.cycle_type === 2000)?.km_to_next ?? defThreshold(2000),
      next13k: vehicleCycles.find(c => c.cycle_type === 13000)?.km_to_next ?? defThreshold(13000),
      next40k: vehicleCycles.find(c => c.cycle_type === 40000)?.km_to_next ?? defThreshold(40000),
      next120k: vehicleCycles.find(c => c.cycle_type === 120000)?.km_to_next ?? defThreshold(120000),
    }
  }

  // 8. Mathematically Derived Dashboard KPI Logic
  const inactiveLRVs = fleetData.filter(v => v.status === 'idle');
  const activeRevenueFleet = fleetData.filter(v => v.status === 'in_service').length;
  
  const dueWithin7Days = allCycles.filter(c => {
    if (!c.due_date) return false;
    const today = new Date(); today.setHours(0,0,0,0);
    const dd = new Date(c.due_date); dd.setHours(0,0,0,0);
    const diff = Math.floor((dd - today) / (1000 * 60 * 60 * 24));
    return diff >= 0 && diff <= 7;
  }).length;

  const attentionCount = fleetData.filter(v => v.status === 'faulty' || v.status === 'maintenance').length + allCycles.filter(c => c.km_to_next < 500).length;
  
  const generate14DayOutlook = () => {
    const bins = new Array(14).fill(0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    allCycles.forEach(c => {
      if (c.due_date) {
        const dd = new Date(c.due_date); dd.setHours(0, 0, 0, 0);
        const diffDays = Math.floor((dd.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays < 14) bins[diffDays]++;
      }
    });
    return bins;
  };

  const outlookBins = generate14DayOutlook();
  const outlookDates = Array.from({length: 14}, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + i);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  });

  const nextActionLrv = allCycles.filter(c => c.km_to_next > 0).sort((a,b) => a.km_to_next - b.km_to_next)[0];

  // --- HANDLERS ---
  const handleExamine = (id) => {
    // 5. Perfect Sync: Selected vehicle drills down, setting lrvId prepares form logic
    setSelectedVehicle(id);
    setLrvId(id);
  }

  const handleReadingChange = (e) => {
    const val = parseFloat(e.target.value); setManualReading(e.target.value)
    if (!val) { setNeedsOverride(false); return; }
    const drift = Math.abs(val - gnssOdo);
    setNeedsOverride(val < lastManualOdo || drift > (gnssOdo * 0.05))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (needsOverride && !overrideReason) { setMessage("❌ Error: Provide override reason."); return }
    const targetLrv = selectedVehicle || lrvId;
    const { error } = await supabase.from('mileage_anchors').insert([{ lrv_id: targetLrv, ts: new Date().toISOString(), technician_id: 'TECH_01', source: 'manual_entry', value_km: parseFloat(manualReading), gnss_odo_km: gnssOdo, divergence_km: parseFloat(manualReading) - gnssOdo, override: needsOverride, override_reason: needsOverride ? overrideReason : null }])
    if (error) { setMessage("❌ Database Error: " + error.message) } 
    else { setMessage("✅ Success: Hubometer anchor recorded."); setManualReading(''); setOverrideReason(''); setNeedsOverride(false) }
  }

  // --- MOCKUP COMPONENTS ---
  const SidebarItem = ({ id, icon, label }) => (
    <div 
      onClick={() => { setActiveNav(id); setSelectedVehicle(null); }}
      style={{ 
        display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 24px', cursor: 'pointer',
        background: activeNav === id && !selectedVehicle ? '#1e293b' : 'transparent',
        borderLeft: activeNav === id && !selectedVehicle ? '4px solid #38bdf8' : '4px solid transparent',
        color: activeNav === id && !selectedVehicle ? '#ffffff' : '#94a3b8',
        fontWeight: activeNav === id && !selectedVehicle ? '700' : '500',
        transition: 'all 0.15s'
      }}
    >
      <div style={{ color: activeNav === id && !selectedVehicle ? '#38bdf8' : '#64748b', display: 'flex', alignItems: 'center' }}>{icon}</div>
      <span style={{ fontSize: '15px' }}>{label}</span>
    </div>
  );

  const KPICard = ({ icon, color, count, label }) => (
    <div style={{ flex: 1, background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: `${color}15`, color: color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>
        <span style={{ fontSize: '12px', color: '#475569', fontWeight: '700' }}>{label}</span>
      </div>
      <div style={{ fontSize: '28px', fontWeight: '900', color: color }}>{count}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: '#f8fafc', fontFamily: 'system-ui, -apple-system, sans-serif', overflow: 'hidden' }}>
      
      {/* --- SIDEBAR --- */}
      <div style={{ width: '260px', background: '#0f172a', color: '#ffffff', display: 'flex', flexDirection: 'column', flexShrink: 0, zIndex: 100 }}>
        <div style={{ padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: '24px', marginBottom: '8px' }}>
          <img src="https://www.lta.gov.sg/content/dam/ltagov/img/general/logo.png" alt="LTA Logo" style={{ width: '190px', height: 'auto', alignSelf: 'flex-start', filter: 'brightness(0) invert(1)' }} />
          <span style={{ fontSize: '22px', fontWeight: '900', letterSpacing: '0.5px', color: '#ffffff', whiteSpace: 'nowrap' }}>LRV Maintenance</span>
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <SidebarItem id="fleet_overview" icon={<Icons.Grid />} label="Fleet Overview" />
          <SidebarItem id="maintenance" icon={<Icons.Wrench />} label="Maintenance Planning" />
          <SidebarItem id="deployment" icon={<Icons.MapPin />} label="Fleet Deployment" />
        </div>

        <div style={{ marginTop: 'auto', padding: '24px 28px', borderTop: '1px solid #1e293b' }}>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px' }}>Safe Trains</div>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Reliable Journeys</div>
        </div>
      </div>

      {/* --- MAIN CONTENT AREA --- */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        
        {/* Top Navbar */}
        <div style={{ height: '56px', background: '#ffffff', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 28px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <span style={{ background: '#f1f5f9', color: '#475569', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.5px' }}>DEMO</span>
            <span style={{ color: '#334155', fontSize: '14px', fontWeight: '500' }}>Sengkang East | {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#475569', fontWeight: '600' }}><span style={{ color: '#10b981' }}>●</span> Operations View</span>
            
            <div style={{ position: 'relative' }}>
              <div onClick={() => setAdminMenuOpen(!adminMenuOpen)} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#475569', fontWeight: '600', cursor: 'pointer', padding: '6px 10px', borderRadius: '6px', background: adminMenuOpen ? '#f1f5f9' : 'transparent' }}>
                <div style={{ background: '#475569', color: 'white', width: '26px', height: '26px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '800' }}>AD</div>
                Admin <Icons.ChevronDown />
              </div>
              {adminMenuOpen && (
                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: '6px', background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)', width: '160px', zIndex: 100, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#475569', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }} onMouseOver={(e) => e.currentTarget.style.background = '#f8fafc'} onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}><Icons.Settings /> System Settings</div>
                  <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#dc2626', cursor: 'pointer' }} onMouseOver={(e) => e.currentTarget.style.background = '#fef2f2'} onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}>Sign Out</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Viewport Canvas */}
        <div style={{ flex: 1, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: '18px', overflow: 'hidden' }}>

          {/* ========================================== */}
          {/* VIEW: FLEET OVERVIEW                       */}
          {/* ========================================== */}
          {activeNav === 'fleet_overview' && !selectedVehicle && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
              <div style={{ flexShrink: 0 }}>
                <h1 style={{ margin: '0 0 4px 0', fontSize: '24px', color: '#0f172a', fontWeight: '900' }}>Fleet Overview</h1>
                <p style={{ margin: 0, color: '#475569', fontSize: '13px' }}>Real-time telemetry and immediate tactical priorities.</p>
              </div>

              <div style={{ display: 'flex', gap: '16px', flexShrink: 0 }}>
                <KPICard icon={<Icons.Alert />} color="#dc2626" count={attentionCount} label="Maintenance attention" />
                <KPICard icon={<Icons.Clock />} color="#d97706" count={dueWithin7Days} label="Due within 7 days" />
                <KPICard icon={<Icons.Gear />} color="#0ea5e9" count={inactiveLRVs.length} label="Available spares" />
                <KPICard icon={<Icons.Clipboard />} color="#475569" count="1" label="Mileage checks" />
              </div>

              <div style={{ display: 'flex', gap: '20px', flex: 1, minHeight: 0 }}>
                {/* Priority Vehicles Table */}
                <div style={{ flex: '2', background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
                    <h3 style={{ margin: 0, fontSize: '14px', color: '#0f172a', fontWeight: '800', textTransform: 'uppercase' }}>Priority Vehicles (Live Feed)</h3>
                  </div>
                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                      <thead style={{ position: 'sticky', top: 0, background: '#ffffff', zIndex: 1 }}>
                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                          <th style={{ padding: '12px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px' }}>Vehicle</th>
                          <th style={{ padding: '12px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px' }}>Status</th>
                          <th style={{ padding: '12px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px' }}>Live Mileage</th>
                          <th style={{ padding: '12px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px' }}>Track Node</th>
                          <th style={{ padding: '12px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', textAlign: 'right' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fleetData.map((lrv) => (
                          <tr key={lrv.lrv_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '12px 20px', fontWeight: '800', color: '#0f172a' }}>{lrv.lrv_id}</td>
                            <td style={{ padding: '12px 20px' }}>
                              {lrv.status === 'in_service' && <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#166534', fontWeight: '700', fontSize: '12px', background: '#dcfce7', padding: '3px 8px', borderRadius: '4px', width: 'fit-content' }}><span style={{ color: '#16a34a' }}>●</span> Serviceable</span>}
                              {lrv.status === 'idle' && <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#64748b', fontWeight: '700', fontSize: '12px', background: '#e2e8f0', padding: '3px 8px', borderRadius: '4px', width: 'fit-content' }}>Depot / Spare</span>}
                              {lrv.status === 'maintenance' && <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#92400e', fontWeight: '700', fontSize: '12px', background: '#fef3c7', padding: '3px 8px', borderRadius: '4px', width: 'fit-content' }}><span style={{ color: '#d97706' }}>●</span> Maintenance</span>}
                              {lrv.status === 'faulty' && <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#991b1b', fontWeight: '700', fontSize: '12px', background: '#fee2e2', padding: '3px 8px', borderRadius: '4px', width: 'fit-content' }}><span style={{ color: '#dc2626' }}>●</span> Faulty</span>}
                            </td>
                            <td style={{ padding: '12px 20px', fontWeight: '700', color: '#0f172a', fontFamily: 'monospace' }}>{lrv.odo_km.toFixed(1)} km</td>
                            <td style={{ padding: '12px 20px', color: '#64748b', fontWeight: '500' }}>{lrv.seg_id}</td>
                            <td style={{ padding: '12px 20px', textAlign: 'right' }}>
                              <button onClick={() => handleExamine(lrv.lrv_id)} style={{ padding: '5px 14px', background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: '4px', color: '#334155', fontWeight: '700', cursor: 'pointer' }}>Examine</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Next Best Action Card */}
                <div style={{ flex: '1', background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <h3 style={{ margin: 0, fontSize: '14px', color: '#0f172a', fontWeight: '800', textTransform: 'uppercase' }}>Next Best Action</h3>
                  <div style={{ width: '36px', height: '36px', background: '#e0f2fe', color: '#0284c7', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icons.Train /></div>
                  <div>
                    <h4 style={{ margin: '0 0 4px 0', fontSize: '14px', color: '#0f172a', fontWeight: '800', lineHeight: '1.4' }}>
                      {nextActionLrv ? `${nextActionLrv.lrv_id} reaching ${nextActionLrv.cycle_type === 2000 ? '2K' : nextActionLrv.cycle_type === 13000 ? '13K' : nextActionLrv.cycle_type === 40000 ? '40K' : '120K'} threshold.` : "Fleet operating nominally."}
                    </h4>
                    <p style={{ margin: 0, fontSize: '12px', color: '#475569' }}>Review schedule for preemptive depot slot.</p>
                  </div>
                  <button onClick={() => setActiveNav('maintenance')} style={{ width: '100%', padding: '10px', background: '#0f766e', color: '#ffffff', border: 'none', borderRadius: '6px', fontWeight: '700', fontSize: '13px', cursor: 'pointer' }}>Open Maintenance Plan</button>
                  <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '8px' }}>
                    <div style={{ fontSize: '11px', fontWeight: '700', color: '#0f172a', marginBottom: '2px' }}>Why this matters</div>
                    <div style={{ fontSize: '11px', color: '#64748b', lineHeight: '1.4' }}>Staying ahead of scheduled maintenance avoids in-service faults and maintains fleet reliability.</div>
                  </div>
                </div>
              </div>

              {/* 14-Day Maintenance Outlook */}
              <div style={{ flexShrink: 0, height: '140px', background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '16px 20px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0, fontSize: '13px', color: '#0f172a', fontWeight: '800', textTransform: 'uppercase' }}>14-Day Maintenance Outlook</h3>
                  <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: '#475569', fontWeight: '600' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span style={{ color: '#0f766e' }}>●</span> Planned maintenance</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span style={{ color: '#cbd5e1' }}>●</span> Other activities</span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', height: '56px', borderBottom: '1px solid #e2e8f0', paddingBottom: '4px' }}>
                  {outlookBins.map((val, i) => (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                      <div style={{ width: '100%', height: val === 0 ? '3px' : `${val * 30}%`, background: val > 0 ? '#0f766e' : '#f1f5f9', borderRadius: '3px 3px 0 0', minHeight: '3px' }}></div>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: '8px', color: '#64748b', fontSize: '10px', textAlign: 'center', fontWeight: '600' }}>
                  {outlookDates.map((d, i) => <div key={i} style={{ flex: 1 }}>{d}</div>)}
                </div>
              </div>
            </div>
          )}

          {/* ========================================== */}
          {/* VIEW: VEHICLE DETAIL (Drill-down)          */}
          {/* ========================================== */}
          {selectedVehicle && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 }}>
                <div>
                  <button onClick={() => setSelectedVehicle(null)} style={{ padding: '5px 12px', background: '#f1f5f9', border: 'none', borderRadius: '4px', fontSize: '12px', fontWeight: '700', color: '#475569', cursor: 'pointer', marginBottom: '8px' }}>← Back to Overview</button>
                  <h1 style={{ margin: '0 0 2px 0', fontSize: '28px', color: '#0f172a', fontWeight: '900' }}>{selectedVehicle}</h1>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '16px' }}>
                   <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#166534', fontWeight: '700', fontSize: '12px', background: '#dcfce7', padding: '6px 12px', borderRadius: '6px' }}><span style={{ color: '#16a34a' }}>●</span> Tracking Active</span>
                   <button style={{ padding: '8px 16px', background: '#0f766e', color: '#ffffff', border: 'none', borderRadius: '6px', fontWeight: '700', fontSize: '13px', cursor: 'pointer' }}>Plan Recall</button>
                </div>
              </div>

              {/* Top KPI Cards */}
              <div style={{ display: 'flex', gap: '20px', flexShrink: 0 }}>
                <div style={{ flex: 1, background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '18px 20px' }}>
                  <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', marginBottom: '6px' }}>Planning Mileage</div>
                  <div style={{ fontSize: '28px', color: '#0f172a', fontWeight: '900', fontFamily: 'monospace' }}>{(gnssOdo + 120000).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} km</div>
                </div>
                <div style={{ flex: 1, background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '18px 20px', borderLeft: '4px solid #0284c7' }}>
                  <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', marginBottom: '6px' }}>Device Odometer (Live)</div>
                  <div style={{ fontSize: '28px', color: '#0f172a', fontWeight: '900', fontFamily: 'monospace' }}>{gnssOdo} km</div>
                </div>
                <div style={{ flex: 1, background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '18px 20px' }}>
                  <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', marginBottom: '6px' }}>Last Physical Check</div>
                  <div style={{ fontSize: '28px', color: '#0f172a', fontWeight: '900', fontFamily: 'monospace' }}>{lastManualOdo} km</div>
                </div>
              </div>

              {/* Route Position and Event Log */}
              <div style={{ flex: 1, display: 'flex', gap: '20px', minHeight: 0 }}>
                <div style={{ flex: '1', background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
                    <h3 style={{ margin: 0, fontSize: '14px', color: '#0f172a', fontWeight: '800', textTransform: 'uppercase' }}>Live Route Tracing</h3>
                  </div>
                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                      <thead style={{ position: 'sticky', top: 0, background: '#ffffff', zIndex: 1 }}>
                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                          <th style={{ padding: '10px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '10px' }}>Timestamp</th>
                          <th style={{ padding: '10px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '10px' }}>Node Segment</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentEvents.map((ev, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '12px 20px', color: '#475569', fontFamily: 'monospace' }}>{new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                            <td style={{ padding: '12px 20px', color: '#0f172a', fontWeight: '700' }}>{ev.seg_id}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div style={{ flex: '1', background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <h3 style={{ margin: 0, fontSize: '14px', color: '#0f172a', fontWeight: '800', textTransform: 'uppercase' }}>Illustrative Route Position</h3>
                  <div style={{ flex: 1, border: '2px dashed #cbd5e1', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: '280px', height: '90px', border: '5px solid #e2e8f0', borderRadius: '45px', position: 'relative' }}>
                      <div style={{ position: 'absolute', top: '-10px', left: '60%', width: '15px', height: '15px', background: '#10b981', border: '3px solid #fff', borderRadius: '50%', boxShadow: '0 0 0 2px #10b981' }}></div>
                      <div style={{ position: 'absolute', top: '-28px', left: '55%', fontSize: '12px', fontWeight: '800', color: '#0f172a' }}>{recentEvents[0]?.seg_id || 'Depot'}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ========================================== */}
          {/* VIEW: MAINTENANCE PLANNING                 */}
          {/* ========================================== */}
          {activeNav === 'maintenance' && !selectedVehicle && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
              <div style={{ flexShrink: 0 }}>
                <h1 style={{ margin: '0 0 4px 0', fontSize: '24px', color: '#0f172a', fontWeight: '900' }}>Maintenance Planning</h1>
                <p style={{ margin: 0, color: '#475569', fontSize: '13px' }}>Preventive maintenance schedules and hubometer logs.</p>
              </div>

              <div style={{ display: 'flex', gap: '20px', flex: 1, minHeight: 0 }}>
                {/* PM Schedule Matrix */}
                <div style={{ flex: '1.3', background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div style={{ padding: '14px 20px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
                    <h3 style={{ margin: 0, fontSize: '14px', color: '#0f172a', fontWeight: '800', textTransform: 'uppercase' }}>Preventive Maintenance Schedule (Km to Next)</h3>
                  </div>
                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'center' }}>
                      <thead style={{ position: 'sticky', top: 0, background: '#e2e8f0', zIndex: 1 }}>
                        <tr>
                          <th style={{ padding: '10px', color: '#0f172a', fontWeight: '800', borderRight: '1px solid #cbd5e1' }}>LRV No.</th>
                          <th style={{ padding: '10px', color: '#0f172a', fontWeight: '800', borderRight: '1px solid #cbd5e1' }}>Next 2K PM</th>
                          <th style={{ padding: '10px', color: '#0f172a', fontWeight: '800', borderRight: '1px solid #cbd5e1' }}>Next 13K PM</th>
                          <th style={{ padding: '10px', color: '#0f172a', fontWeight: '800', borderRight: '1px solid #cbd5e1' }}>Next 40K PM</th>
                          <th style={{ padding: '10px', color: '#0f172a', fontWeight: '800' }}>Next 120K</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fleetData.map((lrv) => {
                          const pm = getPMThresholds(lrv.odo_km, lrv.lrv_id);
                          return (
                            <tr key={lrv.lrv_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '10px', fontWeight: '800', color: '#0f172a', borderRight: '1px solid #f1f5f9', background: '#f8fafc' }}>{lrv.lrv_id}</td>
                              <td style={{ padding: '10px', fontFamily: 'monospace', fontWeight: '600', borderRight: '1px solid #f1f5f9', background: pm.next2k < 500 ? '#fbcfe8' : 'transparent', color: pm.next2k < 500 ? '#9d174d' : '#334155' }}>{Math.round(pm.next2k).toLocaleString()}</td>
                              <td style={{ padding: '10px', fontFamily: 'monospace', fontWeight: '600', borderRight: '1px solid #f1f5f9', background: pm.next13k < 500 ? '#fbcfe8' : 'transparent', color: pm.next13k < 500 ? '#9d174d' : '#334155' }}>{Math.round(pm.next13k).toLocaleString()}</td>
                              <td style={{ padding: '10px', fontFamily: 'monospace', fontWeight: '600', borderRight: '1px solid #f1f5f9', background: pm.next40k < 500 ? '#fbcfe8' : 'transparent', color: pm.next40k < 500 ? '#9d174d' : '#334155' }}>{Math.round(pm.next40k).toLocaleString()}</td>
                              <td style={{ padding: '10px', fontFamily: 'monospace', fontWeight: '600', background: pm.next120k < 500 ? '#fbcfe8' : 'transparent', color: pm.next120k < 500 ? '#9d174d' : '#334155' }}>{Math.round(pm.next120k).toLocaleString()}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Hubometer Input / History */}
                <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '16px', minHeight: 0 }}>
                  <div style={{ flexShrink: 0, background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <h3 style={{ margin: 0, fontSize: '14px', color: '#0f172a', fontWeight: '800', textTransform: 'uppercase' }}>Log Hubometer PM (Technician Input)</h3>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <select value={lrvId} onChange={(e) => setLrvId(e.target.value)} style={{ padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#f8fafc', fontWeight: '700' }}>
                        {fleetData.map(v => <option key={v.lrv_id} value={v.lrv_id}>{v.lrv_id}</option>)}
                      </select>
                      <input type="number" step="0.1" value={manualReading} onChange={handleReadingChange} placeholder="Odometer value..." style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1', fontFamily: 'monospace', fontWeight: '600' }} />
                      <button onClick={handleSubmit} style={{ padding: '10px 20px', background: '#0ea5e9', color: 'white', border: 'none', borderRadius: '6px', fontWeight: '800', cursor: 'pointer' }}>Submit</button>
                    </div>
                    {needsOverride && (
                      <div style={{ borderLeft: '4px solid #dc2626', padding: '10px', background: '#fef2f2', borderRadius: '0 6px 6px 0' }}>
                        <span style={{ display: 'block', fontSize: '11px', fontWeight: '800', textTransform: 'uppercase', color: '#991b1b', marginBottom: '4px' }}>Threshold Exceeded</span>
                        <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Engineering justification required..." style={{ width: '100%', padding: '6px', border: '1px solid #fca5a5', borderRadius: '4px', outline: 'none', fontSize: '12px' }} required />
                      </div>
                    )}
                    {message && <div style={{ padding: '8px 12px', borderRadius: '6px', background: '#f1f5f9', border: '1px solid #cbd5e1', color: '#0f172a', fontSize: '12px', fontWeight: '600' }}>{message}</div>}
                  </div>

                  <div style={{ flex: 1, background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div style={{ padding: '14px 20px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
                      <h3 style={{ margin: 0, fontSize: '14px', color: '#0f172a', fontWeight: '800', textTransform: 'uppercase' }}>Recent PM Records</h3>
                    </div>
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'center' }}>
                        <thead style={{ position: 'sticky', top: 0, background: '#f8fafc', zIndex: 1 }}>
                          <tr>
                            <th style={{ padding: '10px 8px', color: '#64748b', fontWeight: '800' }}>Date</th>
                            <th style={{ padding: '10px 8px', color: '#64748b', fontWeight: '800' }}>LRV</th>
                            <th style={{ padding: '10px 8px', color: '#64748b', fontWeight: '800' }}>Type</th>
                            <th style={{ padding: '10px 8px', color: '#64748b', fontWeight: '800' }}>Value (km)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {globalAuditLogs.length === 0 ? (
                            <tr><td colSpan="4" style={{ padding: '16px', color: '#64748b' }}>No recent records found.</td></tr>
                          ) : (
                            globalAuditLogs.map((log, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                <td style={{ padding: '10px' }}>{new Date(log.ts).toLocaleDateString()}</td>
                                <td style={{ fontWeight: '800' }}>{log.lrv_id || '--'}</td>
                                <td>{log.override ? 'Override' : 'Routine'}</td>
                                <td style={{ fontFamily: 'monospace', fontWeight: '700' }}>{log.value_km}</td>
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
          )}

          {/* ========================================== */}
          {/* VIEW: DEPLOYMENT STATUS BOARD              */}
          {/* ========================================== */}
          {activeNav === 'deployment' && !selectedVehicle && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
              <div style={{ flexShrink: 0 }}>
                <h1 style={{ margin: '0 0 4px 0', fontSize: '24px', color: '#0f172a', fontWeight: '900' }}>Fleet Deployment</h1>
                <p style={{ margin: 0, color: '#475569', fontSize: '13px' }}>Strategic allocation and depot status of all LRVs.</p>
              </div>

              <div style={{ display: 'flex', gap: '20px', flex: 1, minHeight: 0 }}>
                {/* Main Deployment Table */}
                <div style={{ flex: '2', background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
                    <h3 style={{ margin: 0, fontSize: '14px', color: '#0f172a', fontWeight: '800', textTransform: 'uppercase' }}>Network Allocation</h3>
                  </div>
                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                      <thead style={{ position: 'sticky', top: 0, background: '#ffffff', zIndex: 1 }}>
                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                          <th style={{ padding: '12px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px' }}>Vehicle</th>
                          <th style={{ padding: '12px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px' }}>Assignment Status</th>
                          <th style={{ padding: '12px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px' }}>Current Location</th>
                          <th style={{ padding: '12px 20px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', fontSize: '11px', textAlign: 'right' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fleetData.map((lrv) => (
                          <tr key={lrv.lrv_id} style={{ borderBottom: '1px solid #f1f5f9', background: lrv.status === 'in_service' ? 'transparent' : '#f8fafc' }}>
                            <td style={{ padding: '12px 20px', fontWeight: '800', color: lrv.status === 'in_service' ? '#0f172a' : '#94a3b8' }}>{lrv.lrv_id}</td>
                            <td style={{ padding: '12px 20px' }}>
                              {lrv.status === 'in_service' && <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#0369a1', fontWeight: '700', fontSize: '12px', background: '#e0f2fe', padding: '3px 8px', borderRadius: '4px', width: 'fit-content' }}><span style={{ color: '#0284c7' }}>●</span> Revenue Service</span>}
                              {lrv.status === 'idle' && <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#64748b', fontWeight: '700', fontSize: '12px', background: '#e2e8f0', padding: '3px 8px', borderRadius: '4px', width: 'fit-content' }}>Depot / Spare</span>}
                              {lrv.status === 'maintenance' && <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#92400e', fontWeight: '700', fontSize: '12px', background: '#fef3c7', padding: '3px 8px', borderRadius: '4px', width: 'fit-content' }}><span style={{ color: '#d97706' }}>●</span> Maintenance</span>}
                              {lrv.status === 'faulty' && <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#991b1b', fontWeight: '700', fontSize: '12px', background: '#fee2e2', padding: '3px 8px', borderRadius: '4px', width: 'fit-content' }}><span style={{ color: '#dc2626' }}>●</span> Faulty</span>}
                            </td>
                            <td style={{ padding: '12px 20px', color: lrv.status === 'in_service' ? '#475569' : '#94a3b8', fontWeight: '500' }}>{lrv.status === 'in_service' ? lrv.seg_id : 'Sengkang Depot'}</td>
                            <td style={{ padding: '12px 20px', textAlign: 'right' }}>
                              <button 
                                onClick={() => handleExamine(lrv.lrv_id)} 
                                style={{ 
                                  padding: '5px 14px', 
                                  background: lrv.status === 'in_service' ? '#f1f5f9' : '#ffffff', 
                                  border: '1px solid #cbd5e1', 
                                  borderRadius: '4px', 
                                  color: lrv.status === 'in_service' ? '#334155' : '#0f766e', 
                                  fontWeight: '700', 
                                  cursor: 'pointer',
                                  transition: 'all 0.15s ease-in-out'
                                }}
                              >
                                {lrv.status === 'idle' ? 'Assign' : 'Examine'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Deployment Metrics */}
                <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '20px', minHeight: 0 }}>
                  <div style={{ background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
                    <div style={{ fontSize: '12px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', marginBottom: '12px' }}>Active Revenue Fleet</div>
                    <div style={{ fontSize: '64px', color: '#0f172a', fontWeight: '900', letterSpacing: '-3px', lineHeight: '1' }}>{activeRevenueFleet}<span style={{ fontSize: '24px', color: '#cbd5e1', fontWeight: '600', letterSpacing: '0' }}> / {fleetData.length}</span></div>
                    <div style={{ marginTop: '20px', display: 'flex', gap: '6px', alignItems: 'center', color: '#166534', background: '#dcfce7', padding: '6px 12px', borderRadius: '6px', fontSize: '13px', fontWeight: '700' }}>
                      <Icons.MapPin /> Optimal Deployment Level
                    </div>
                  </div>
                  <div style={{ background: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
                    <div style={{ fontSize: '12px', color: '#64748b', fontWeight: '800', textTransform: 'uppercase', marginBottom: '12px' }}>Available Depot Spares</div>
                    <div style={{ fontSize: '64px', color: '#0f172a', fontWeight: '900', letterSpacing: '-3px', lineHeight: '1' }}>{availableDepotSpares}</div>
                    <p style={{ margin: '16px 0 0 0', fontSize: '13px', color: '#475569', lineHeight: '1.5' }}>Ready for immediate injection into Sengkang East loop if required.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

export default App