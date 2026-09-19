import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createAssistantSession, readAssistantSession, readPendingAssistantRequest, requestMaintenanceAssistant } from '../lib/maintenanceAssistantApi'
import { cycleLabel, formatDateTime, vehicleLabel } from '../lib/format'
import { Icon } from './Icons'
import './MaintenanceAssistant.css'

const starters = [
  'Which LRVs need attention first, and why?',
  'What bay capacity is available over the next 7 days?',
  'Compare the shortest and longest maintenance jobs.',
]

export function MaintenanceAssistant({ open, onClose, onChanged, onProposal, onNotice }) {
  const [session, setSession] = useState(readAssistantSession)
  const sessionRef = useRef(session)
  const [messages, setMessages] = useState([])
  const [batch, setBatch] = useState(null)
  const [plan, setPlan] = useState(null)
  const [previewPlan, setPreviewPlan] = useState(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [retry, setRetry] = useState(null)
  const [restored, setRestored] = useState(false)
  const callbacks = useRef({ onClose, onChanged, onProposal, onNotice })
  const dialog = useRef(null)
  const conversation = useRef(null)
  const requestInFlight = useRef(false)
  const active = batch?.status === 'proposed'
  const rescheduling = plan?.kind === 'reschedule' || batch?.metadata?.kind === 'reschedule'

  useEffect(() => {
    sessionRef.current = session
    callbacks.current = { onClose, onChanged, onProposal, onNotice }
  }, [session, onClose, onChanged, onProposal, onNotice])

  async function run(input) {
    if (requestInFlight.current) return
    requestInFlight.current = true
    setBusy(true)
    setError(null)
    setRetry(input)
    try {
      const response = await requestMaintenanceAssistant(input)
      setMessages(response.messages.filter((message) => ['assistant', 'user'].includes(message.role)))
      setBatch(response.batch || null)
      setPlan(response.plan || null)
      setPreviewPlan(response.previewPlan || null)
      setRetry(null)
      setRestored(true)
      if (input.action === 'chat') setDraft('')
      callbacks.current.onProposal?.(response.batch?.status === 'proposed' ? response.batch : null, response.plan, input.action === 'chat')
      if (response.batch || ['confirm', 'discard'].includes(input.action)) await callbacks.current.onChanged?.()
      if (input.action === 'confirm') callbacks.current.onNotice?.((response.plan?.kind === 'reschedule' || rescheduling) ? 'Reschedule confirmed. The bookings have moved and are green.' : 'AI proposal confirmed. The bookings are now green.', 'success')
      if (input.action === 'discard') callbacks.current.onNotice?.((response.plan?.kind === 'reschedule' || rescheduling) ? 'Reschedule discarded. Original bookings are unchanged.' : 'AI proposal discarded. The LRVs are available for planning again.', 'success')
    } catch (problem) {
      setError(problem.message)
      if (problem.definitive) { setRetry(null); setRestored(true) }
      if (problem.sessionExpired) {
        setBatch(null)
        setPlan(null)
        setPreviewPlan(null)
        setMessages([])
        setDraft('')
        callbacks.current.onProposal?.(null, null, false)
        if (input.action === 'history') {
          const fresh = createAssistantSession()
          sessionRef.current = fresh
          setSession(fresh)
          setTimeout(() => run({ action: 'new', ...fresh }), 0)
        }
      }
    } finally {
      requestInFlight.current = false
      setBusy(false)
    }
  }

  useEffect(() => {
    const current = sessionRef.current
    if (current) void run(readPendingAssistantRequest(current) || { action: 'history', ...current, requestId: crypto.randomUUID() })
    else setRestored(true)
  }, [])

  useEffect(() => {
    if (!open) return
    const current = sessionRef.current
    if (current && !requestInFlight.current) void run(readPendingAssistantRequest(current) || { action: 'history', ...current, requestId: crypto.randomUUID() })
    const previouslyFocused = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.querySelector('button')?.focus()
    function keyboard(event) {
      if (event.key === 'Escape') callbacks.current.onClose?.()
      if (event.key !== 'Tab') return
      const elements = [...dialog.current.querySelectorAll('button:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
      const first = elements[0]
      const last = elements.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', keyboard)
      previouslyFocused?.focus?.()
    }
  }, [open])

  useEffect(() => {
    if (open && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight
  }, [open, messages, busy])

  function send(message = draft) {
    const text = message.trim()
    if (!text || text.length > 2000 || busy || retry || !restored) return
    const current = session || createAssistantSession()
    if (!session) setSession(current)
    void run({ action: 'chat', ...current, message: text, requestId: crypto.randomUUID() })
  }

  function newConversation() {
    if (active || busy || retry) return
    const next = createAssistantSession()
    setSession(next)
    setMessages([])
    setPlan(null)
    setPreviewPlan(null)
    setBatch(null)
    setDraft('')
    callbacks.current.onProposal?.(null, null, false)
    void run({ action: 'new', ...next, requestId: crypto.randomUUID() })
  }

  if (!open) return null
  const content = <div className="maintenance-assistant-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="maintenance-assistant" role="dialog" aria-modal="true" aria-labelledby="maintenance-assistant-title" ref={dialog}>
      <header className="maintenance-assistant-header">
        <div><span className="maintenance-assistant-eyebrow">OPERATIONS ASSISTANT</span><h2 id="maintenance-assistant-title">Plan maintenance together</h2><p>Fleet priorities, bay capacity and draft schedules.</p></div>
        <button className="icon-button" onClick={onClose} aria-label="Close maintenance assistant">×</button>
      </header>
      <div className="maintenance-assistant-toolbar"><span>AI · GPT-4.1 mini · Singapore time</span><button disabled={busy || active || Boolean(retry)} onClick={newConversation} title={active ? 'Confirm or discard the current proposal first' : undefined}>New conversation</button></div>
      <div className="maintenance-assistant-conversation" ref={conversation} role="log" aria-label="Maintenance planning conversation" aria-live="polite" aria-busy={busy}>
        {!messages.length && <div className="maintenance-assistant-welcome"><Icon name="calendar" size={28}/><h3>What would you like to plan?</h3><p>I can help you compare priorities and find suitable bay slots. Ask me to propose a schedule when you are ready. You will confirm bookings separately.</p><div className="maintenance-assistant-starters">{starters.map((text) => <button key={text} disabled={busy || Boolean(retry) || !restored} onClick={() => send(text)}>{text}<Icon name="chevron" size={16}/></button>)}</div></div>}
        {messages.map((message, index) => <article className={`maintenance-assistant-message maintenance-assistant-message-${message.role}`} key={message.id || index}><strong>{message.role === 'user' ? 'You' : 'Maintenance assistant'}</strong><p>{message.content}</p></article>)}
        {busy && <p className="maintenance-assistant-working" role="status"><span/>Checking the current plan…</p>}
        {previewPlan && <AssistantPlan plan={previewPlan}/>}
        {plan && <AssistantPlan plan={plan} batch={batch}/>}
      </div>
      {active && <div className="maintenance-assistant-confirm"><p><strong>{batch.booking_ids?.length || plan?.bookings?.length || 0} {rescheduling ? 'proposed move(s)' : 'proposed booking(s)'}</strong><span>{rescheduling ? 'Blue shows proposed moves. Original bookings stay green until confirmed.' : 'Shown in blue. Confirm to commit the schedule.'}</span>{batch.expires_at && <small>Review by {formatDateTime(batch.expires_at)} SGT</small>}</p><div><button className="button button-secondary" disabled={busy || Boolean(retry)} onClick={() => run({ action: 'discard', ...session, batchId: batch.id, requestId: crypto.randomUUID() })}>Discard proposal</button><button className="button button-primary schedule-confirm-attention" disabled={busy || Boolean(retry)} onClick={() => run({ action: 'confirm', ...session, batchId: batch.id, requestId: crypto.randomUUID() })}><Icon name="check"/>{rescheduling ? 'Confirm reschedule' : 'Confirm schedule'}</button></div></div>}
      {error && <div className="maintenance-assistant-error" role="alert"><p>{error}</p>{retry && <button disabled={busy} onClick={() => run(retry)}>Retry request</button>}</div>}
      <form className="maintenance-assistant-compose" onSubmit={(event) => { event.preventDefault(); send() }}>
        <label htmlFor="maintenance-assistant-message">Ask about this fleet or request a proposal</label>
        <div><textarea id="maintenance-assistant-message" rows="2" maxLength={2000} value={draft} disabled={busy || !restored || Boolean(retry)} onChange={(event) => setDraft(event.target.value)} placeholder="e.g. Propose slots for LRVs due within 7 days" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }}/><button className="button button-primary" type="submit" disabled={busy || !restored || Boolean(retry) || !draft.trim()} aria-label="Send message"><Icon name="chevron"/></button></div>
        <small>Review recommendations. Operational checks run again before confirmation.</small>
      </form>
    </section>
  </div>
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}

export function AssistantPlan({ plan, batch }) {
  const bookings = plan.bookings || []
  const status = batch?.status || 'preview'
  const moving = plan.kind === 'reschedule' || batch?.metadata?.kind === 'reschedule'
  return <section className="maintenance-assistant-plan" aria-label="Scheduling proposal"><h3>{status === 'confirmed' ? (moving ? 'Confirmed reschedule' : 'Confirmed schedule') : status === 'proposed' ? (moving ? 'Proposed reschedule' : 'Proposed schedule') : status === 'discarded' || status === 'cancelled' ? 'Discarded proposal' : status === 'expired' ? 'Expired proposal' : 'Schedule preview'}</h3>
    <p>{bookings.length} booking{bookings.length === 1 ? '' : 's'} · All times SGT</p>
    {bookings.map((booking, index) => <div className="maintenance-assistant-plan-booking" key={booking.id || index}><strong>{vehicleLabel(booking.lrvId || booking.lrv_id)} · {(booking.workType || booking.work_type) === 'corrective' ? 'Fault repair' : cycleLabel(booking.primaryCycle || booking.primary_cycle)}</strong>{moving && booking.original && <small>From {booking.original.bayName || booking.original.bayId} / {formatDateTime(booking.original.startAt)} - {formatDateTime(booking.original.endAt)}</small>}<span>{moving ? 'To ' : ''}{booking.bayName || booking.bayId || booking.bay_id}</span><small>{formatDateTime(booking.startAt || booking.start_at)} – {formatDateTime(booking.endAt || booking.end_at)}</small></div>)}
    {!!plan.skipped?.length && <div className="maintenance-assistant-plan-notes"><strong>Not scheduled</strong>{plan.skipped.map((item, index) => <p key={index}>{typeof item === 'string' ? item : `${vehicleLabel(item.lrvId || item.lrv_id)}: ${item.reason || 'No suitable slot found.'}`}</p>)}</div>}
    {!!plan.warnings?.length && <div className="maintenance-assistant-plan-notes"><strong>Planning notes</strong>{plan.warnings.map((warning, index) => <p key={index}>{typeof warning === 'string' ? warning : warning.message || warning.reason}</p>)}</div>}
  </section>
}
