import { useEffect, useRef, useState } from 'react'
import { loadMaintenancePhoto } from '../lib/api'
import { formatDateTime, vehicleLabel } from '../lib/format'

export function MaintenancePhoto({ record, onClose }) {
  const dialog = useRef(null)
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => { dialog.current.showModal() }, [])
  useEffect(() => {
    let active = true
    setUrl(null)
    setError(null)
    loadMaintenancePhoto(record.imageUri).then(value => { if (active) setUrl(value) })
      .catch(err => { if (active) setError(err.message) })
    return () => { active = false }
  }, [record.imageUri, attempt])
  return <dialog ref={dialog} className="maintenance-photo-dialog" aria-labelledby="maintenance-photo-title" onCancel={onClose} onClick={event => { if (event.target === dialog.current) onClose() }}>
    <div className="modal-header"><h2 id="maintenance-photo-title">{vehicleLabel(record.lrv_id)} · Maintenance photo</h2><button aria-label="Close photo" onClick={onClose}>×</button></div>
    <div className="maintenance-photo-content">
      <p>{formatDateTime(record.completed_at)} · {record.technician_id}</p>
      {error ? <div role="alert"><p>{error}</p><button className="button button-secondary" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>
        : url ? <img src={url} alt={`Hubometer evidence for ${vehicleLabel(record.lrv_id)} maintenance completed ${formatDateTime(record.completed_at)}`} onError={() => setError('This image could not be displayed. Please try again.')}/>
          : <p role="status">Loading photo…</p>}
    </div>
  </dialog>
}
