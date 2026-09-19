import { createClient } from 'npm:@supabase/supabase-js@2.112.4'
import { ASSISTANT_MODEL, runAssistantTurn, validateChatMessage, proposalText } from '../_shared/assistantAgent.js'

const url = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, global: {
  fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }),
} })
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const origins = (Deno.env.get('MAINTENANCE_ASSISTANT_ORIGINS') || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s => s.trim())
const model = Deno.env.get('OPENAI_MAINTENANCE_MODEL') || ASSISTANT_MODEL

Deno.serve(async request => {
  const deadline = Date.now() + 65000
  const origin = request.headers.get('origin')
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    'Access-Control-Allow-Origin': origin && origins.includes(origin) ? origin : origins[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS' }
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers })
  if (origin && !origins.includes(origin)) return json({ error: 'This origin is not enabled for the maintenance assistant.' }, 403)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)
  let reservedSession: string | null = null
  let reservedUntil: string | null = null
  let mutationCommitted = false
  try {
    if (Number(request.headers.get('content-length')) > 12000) return json({ error: 'Request too large.' }, 413)
    const raw = await request.text()
    if (raw.length > 12000) return json({ error: 'Request too large.' }, 413)
    const body = JSON.parse(raw)
    const action = body.action
    if (!['new', 'chat', 'history', 'confirm', 'discard'].includes(action)) return json({ error: 'Unknown assistant action.' }, 400)
    if (!uuid.test(body.sessionId || '') || typeof body.sessionToken !== 'string' || !/^[0-9a-f-]{64,100}$/i.test(body.sessionToken)) {
      return json({ error: 'Start a new assistant session.' }, 400)
    }
    if (action === 'chat') validateChatMessage(body.message)
    if (['chat', 'confirm', 'discard'].includes(action) && !uuid.test(body.requestId || '')) return json({ error: 'A valid request ID is required.' }, 400)
    if (['confirm', 'discard'].includes(action) && !uuid.test(body.batchId || '')) return json({ error: 'A valid proposal ID is required.' }, 400)

    const identity = await operatorIdentity(request)
    const tokenHash = await digest(body.sessionToken)
    let session = await checked(db.from('assistant_sessions').select('*').eq('id', body.sessionId).maybeSingle())
    if (!session && ['new', 'chat'].includes(action)) {
      const actorHash = await digest(`${serviceKey.slice(-24)}:${identity.id || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown'}`)
      session = await checked(db.rpc('assistant_create_session', { p_session_id: body.sessionId, p_token_hash: tokenHash,
        p_owner_id: identity.id, p_is_demo: identity.demo, p_actor_hash: actorHash }))
    }
    if (!session || session.token_hash !== tokenHash || session.owner_id !== identity.id || session.is_demo !== identity.demo) return json({ error: 'This assistant session is not available to this operator.' }, 403)
    if (new Date(session.expires_at) <= new Date()) return json({ error: 'Your assistant session expired. Start a new conversation.' }, 410)
    await checked(db.rpc('assistant_expire_proposals'))
    if (action === 'history' || action === 'new') return json(await state(session.id))

    if (action === 'confirm' || action === 'discard') {
      if (session.busy_until && new Date(session.busy_until) > new Date()) return json({ error: 'Please wait for the current planning request to finish.' }, 409)
      const batch = await checked(db.rpc('assistant_apply_proposal', { p_session_id: session.id, p_batch_id: body.batchId, p_action: action }))
      mutationCommitted = true
      await recordReply(session.id, body.requestId,
        action === 'confirm' ? `${batch.booking_ids.length} bookings ${batch.metadata?.kind === 'reschedule' ? 'rescheduled' : 'confirmed'}. The slots are now green.` : batch.metadata?.kind === 'reschedule' ? 'Proposed moves discarded. Original bookings are unchanged.' : 'Proposal discarded. Unconfirmed slots released.',
        { plan: batch.metadata?.plan, batchId: batch.id })
      return json({ ...await state(session.id), batch })
    }

    // Replays recover committed results without another model call or another booking.
    const prior = await checked(db.from('assistant_messages').select('*').eq('session_id', session.id).eq('request_id', body.requestId))
    const oldUser = prior.find((m: any) => m.role === 'user')
    if (oldUser && oldUser.content !== body.message.trim()) return json({ error: 'This request ID was already used for a different message.' }, 409)
    if (prior.some((m: any) => m.role === 'assistant')) return json(await state(session.id))
    const recoveredBatch = await checked(db.from('assistant_batches').select('*').eq('session_id', session.id).eq('request_id', body.requestId).maybeSingle())
    if (recoveredBatch) {
      const plan = recoveredBatch.metadata?.plan || await recoverPlan(recoveredBatch.booking_ids)
      await recordReply(session.id, body.requestId, proposalText(plan, recoveredBatch), { plan, batchId: recoveredBatch.id, recovered: true })
      return json(await state(session.id))
    }
    const key = Deno.env.get('OPENAI_API_KEY')
    if (!key) return json({ error: 'The maintenance assistant is not configured: set the server OPENAI_API_KEY secret.' }, 503)
    const actorHash = await digest(`${serviceKey.slice(-24)}:${identity.id || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown'}`)
    await checked(db.rpc('assistant_reserve_turn', { p_session_id: session.id, p_actor_hash: actorHash }))
    reservedSession = session.id
    reservedUntil = (await checked(db.from('assistant_sessions').select('busy_until').eq('id', session.id).single())).busy_until
    const currentState = await state(session.id)
    const history = currentState.messages.filter((m: any) => m.request_id !== body.requestId)
    if (!oldUser) await checked(db.from('assistant_messages').insert({ session_id: session.id, request_id: body.requestId, role: 'user', content: body.message.trim() }))
    const result = await runAssistantTurn({
      message: body.message, history, model,
      planningPreferences: currentState.planningPreferences,
      pendingBatch: currentState.batch?.status === 'proposed' ? currentState.batch : null,
      loadData: () => loadFleet(session.fleet),
      saveProposal: async (plan: any, constraints: any) => {
        if (Date.now() >= deadline) throw new Error('The planning request timed out before adding bookings. Please retry.')
        const batch = await checked(db.rpc(plan.kind === 'reschedule' ? 'assistant_store_reschedule' : 'assistant_store_proposal', { p_session_id: session.id, p_request_id: body.requestId,
          p_bookings: plan.bookings, p_metadata: { plan, constraints, ...(plan.kind === 'reschedule' ? { kind: 'reschedule' } : {}) } }))
        mutationCommitted = true
        return batch
      },
      provider: async (payload: any) => {
        if (Date.now() >= deadline) throw new Error('The planning request timed out. Please retry.')
        const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', signal: AbortSignal.timeout(Math.max(1, Math.min(20000, deadline - Date.now()))),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        if (!response.ok) throw new Error(response.status === 429 ? 'The AI provider is busy or its budget is exhausted. Please try again later.' : `The AI provider is unavailable (${response.status}). No confirmation was made.`)
        return response.json()
      },
    })
    await recordReply(session.id, body.requestId, result.text, { plan: result.plan, batchId: result.batch?.id,
      planningPreferences: result.planningPreferences, usage: result.usage, model })
    await checked(db.from('assistant_audit').insert({ session_id: session.id, event: 'turn_completed', details: { requestId: body.requestId, model, tools: result.audit, usage: result.usage } }))
    return json({ ...await state(session.id), previewPlan: currentState.batch?.status === 'proposed' && !result.batch ? result.plan : null })
  } catch (error) {
    const message = error instanceof Error ? error.message : (error as any)?.message || 'The maintenance assistant is unavailable. Please retry.'
    const status = mutationCommitted || /fetch|network|AI provider|timed out|timeout/i.test(message) ? 503 : /limit reached|usage limit/i.test(message) ? 429 : /sign.in|operator access/i.test(message) ? 403 : /still running|current planning request/i.test(message) ? 409 : 422
    return json({ error: message.slice(0, 400) }, status)
  } finally {
    if (reservedSession && reservedUntil) await db.from('assistant_sessions').update({ busy_until: null }).eq('id', reservedSession).eq('busy_until', reservedUntil)
  }
})

async function operatorIdentity(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (token?.startsWith('eyJ')) {
    const { data } = await db.auth.getUser(token)
    if (data.user) {
      const roles = data.user.app_metadata?.roles || [data.user.app_metadata?.role]
      if (!roles.some((r: string) => ['admin', 'maintenance_planner'].includes(r))) throw new Error('Maintenance planner operator access is required.')
      return { id: data.user.id, demo: false }
    }
  }
  if (Deno.env.get('MAINTENANCE_ASSISTANT_ALLOW_DEMO') !== 'true') throw new Error('Please sign in with maintenance planner operator access. Demo access is disabled.')
  return { id: null, demo: true }
}

async function digest(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}
async function checked(query: any) { const { data, error } = await query; if (error) throw error; return data }
async function recordReply(sessionId: string, requestId: string, content: string, metadata: any) {
  await checked(db.from('assistant_messages').upsert({ session_id: sessionId, request_id: requestId, role: 'assistant', content, metadata }, { onConflict: 'session_id,role,request_id' }))
}
async function state(sessionId: string) {
  const messages = await checked(db.from('assistant_messages').select('id,role,content,created_at,request_id,metadata').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(40))
  messages.reverse()
  const batches = await checked(db.from('assistant_batches').select('id,status,booking_ids,expires_at,created_at,metadata').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(1))
  const batch = batches[0] || null
  const lastReply = messages.filter((m: any) => m.role === 'assistant').at(-1)
  const planningPreferences = messages.filter((m: any) => m.metadata?.planningPreferences).at(-1)?.metadata.planningPreferences || batch?.metadata?.constraints || null
  const visibleBatch = batch && (batch.status === 'proposed' || lastReply?.metadata?.batchId === batch.id) ? batch : null
  const boundPlan = visibleBatch ? visibleBatch.metadata?.plan || await recoverPlan(visibleBatch.booking_ids) : lastReply?.metadata?.plan || null
  return { sessionId, messages: messages.map(({ metadata: _metadata, ...m }: any) => m), batch: visibleBatch,
    plan: boundPlan, planningPreferences, model, updatedAt: new Date().toISOString() }
}
async function recoverPlan(ids: string[]) {
  const rows = await checked(db.from('maintenance_bookings').select('*').in('id', ids))
  return { bookings: rows.map((b: any) => ({ lrvId: b.lrv_id, bayId: b.bay_id, workType: b.work_type,
    primaryCycle: b.primary_cycle, startAt: b.start_at, endAt: b.end_at })), skipped: [], warnings: [] }
}
async function loadFleet(fleet: string) {
  const vehicles = await checked(db.from('vehicles').select('lrv_id,fleet,status').eq('fleet', fleet))
  const ids = vehicles.map((v: any) => v.lrv_id)
  const [forecasts, bookings, bays, rules, settings, duties, faults] = await Promise.all([
    checked(db.from('cycle_forecasts').select('*').in('lrv_id', ids)),
    checked(db.from('maintenance_bookings').select('*').in('lrv_id', ids).in('status', ['proposed', 'confirmed'])),
    checked(db.from('depot_bays').select('*').eq('fleet', fleet)),
    checked(db.from('maintenance_cycle_rules').select('*').eq('fleet', fleet)),
    checked(db.from('planning_settings').select('*').eq('fleet', fleet).single()),
    checked(db.from('duty_assignments').select('*').in('lrv_id', ids).in('status', ['planned', 'active'])),
    checked(db.from('maintenance_faults').select('*').in('lrv_id', ids).in('status', ['open', 'scheduled'])),
  ])
  return { vehicles, forecasts, bookings, bays, rules, settings, duties, faults }
}
