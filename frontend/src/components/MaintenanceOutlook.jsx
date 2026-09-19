import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { buildMaintenanceOutlook } from '../lib/maintenanceOutlook'
import { cycleLabel, formatDate, formatTime, vehicleLabel } from '../lib/format'

export function MaintenanceOutlook({ bookings }) {
  const days = buildMaintenanceOutlook(bookings)
  const scale = Math.max(3, ...days.map(day => day.count))
  const [active, setActive] = useState(null)
  const tooltipId = useId()
  const selected = days.find(day => day.date === active?.date)
  useEffect(() => {
    const close = () => setActive(null)
    window.addEventListener('resize', close)
    return () => window.removeEventListener('resize', close)
  }, [])
  const show = (event, day) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setActive({ date: day.date, left: Math.max(12, Math.min(rect.left + rect.width / 2 - 150, window.innerWidth - 312)), top: Math.max(12, Math.min(rect.bottom, window.innerHeight - 312)) })
  }
  const leave = event => { if (!event.relatedTarget?.closest?.('.outlook-tooltip')) setActive(null) }
  return <div className="outlook-chart">
    <div className="outlook-axis-label">Maintenance blocks scheduled</div>
    <div className="outlook-scale" aria-label={`Scale from zero to ${scale}`}>{Array.from({ length: scale + 1 }, (_, index) => <span key={index}>{scale - index}</span>)}</div>
    <div className="outlook" style={{ '--outlook-grid-step': `${100 / scale}%` }}>{days.map(day => <div className="outlook-day" key={day.date}>
      <button className="bar-area outlook-bar-button" aria-label={`${formatDate(day.date)}: ${day.count} maintenance bookings`} aria-describedby={active?.date === day.date ? tooltipId : undefined}
        onMouseEnter={event => show(event, day)} onMouseLeave={leave} onFocus={event => show(event, day)} onBlur={leave}
        onClick={event => show(event, day)} onKeyDown={event => { if (event.key === 'Escape') setActive(null) }}>
        <span style={{ height: `${day.count / scale * 100}%` }} className={day.count ? 'bar-active' : ''}/>
      </button>
      <small><span>{formatDate(day.date)}</span><span>{formatDate(day.date, { weekday: 'short', day: undefined, month: undefined })}</span></small>
    </div>)}</div>
    {selected && createPortal(<div className="outlook-tooltip" id={tooltipId} role="tooltip" style={{ left: active.left, top: active.top }} onMouseLeave={() => setActive(null)}>
      <strong>{formatDate(selected.date, { weekday: 'long' })}</strong>
      <p>{selected.count ? `${selected.count} scheduled booking${selected.count === 1 ? '' : 's'}` : 'No maintenance scheduled'}</p>
      {selected.bookings.map(booking => <div className="outlook-tooltip-booking" key={booking.id}>
        <strong>{vehicleLabel(booking.lrv_id)} <span>· {booking.work_type === 'corrective' ? 'Corrective repair' : cycleLabel(booking.primary_cycle)}</span></strong>
        <small>{booking.bay_id?.replace(/^SPLRT-/, '').replace('BAY-', 'Bay ')} · {formatDate(booking.start_at) === formatDate(booking.end_at) ? `${formatTime(booking.start_at)}–${formatTime(booking.end_at)}` : `${formatDate(booking.start_at)} ${formatTime(booking.start_at)} – ${formatDate(booking.end_at)} ${formatTime(booking.end_at)}`}{booking.status === 'proposed' ? ' · Draft' : ''}</small>
      </div>)}
    </div>, document.body)}
  </div>
}
