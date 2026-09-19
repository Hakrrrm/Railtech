// Deployed boundary smoke tests; creates one demo conversation, no bookings.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const env = Object.fromEntries((await readFile(new URL('../frontend/.env', import.meta.url), 'utf8')).split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const p = l.indexOf('='); return [l.slice(0, p), l.slice(p + 1).trim().replace(/^['"]|['"]$/g, '')] }))
const base = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
const session = { sessionId: crypto.randomUUID(), sessionToken: crypto.randomUUID() + crypto.randomUUID() }
async function request(body, expected, extraHeaders = {}) {
  const response = await fetch(`${base}/functions/v1/maintenance-assistant`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const data = await response.json()
  assert.equal(response.status, expected, JSON.stringify(data))
  return data
}
await request({ action: 'new', ...session }, 200)
const state = await request({ action: 'history', ...session }, 200)
assert.deepEqual(state.messages, [])
assert(!JSON.stringify(state).includes(session.sessionToken))
assert(!JSON.stringify(state).includes('token_hash'))
await request({ action: 'history', ...session, sessionToken: crypto.randomUUID() + crypto.randomUUID() }, 403)
await request({ action: 'history', sessionId: session.sessionId }, 400)
await request({ action: 'execute_sql', ...session, sql: 'delete from maintenance_bookings' }, 400)
await request({ action: 'chat', ...session, requestId: crypto.randomUUID(), message: 'x'.repeat(2001) }, 422)
await request({ action: 'chat', ...session, requestId: 'not-a-uuid', message: 'Hello' }, 400)
await request({ action: 'confirm', ...session, requestId: crypto.randomUUID(), batchId: crypto.randomUUID() }, 422)
await request('{bad json', 422)
await request('x'.repeat(12001), 413)
await request({ action: 'history', ...session }, 403, { Origin: 'https://untrusted.example' })
for (const table of ['assistant_sessions', 'assistant_messages', 'assistant_batches', 'assistant_audit']) {
  const response = await fetch(`${base}/rest/v1/${table}?select=*`, { headers })
  assert([401, 403].includes(response.status), `${table} accessible to browser role`)
}
for (const [name, body] of [
  ['assistant_store_proposal', { p_session_id: session.sessionId, p_request_id: crypto.randomUUID(), p_bookings: [], p_metadata: {} }],
  ['assistant_apply_proposal', { p_session_id: session.sessionId, p_batch_id: crypto.randomUUID(), p_action: 'confirm' }],
]) {
  const response = await fetch(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) })
  assert([401, 403, 404].includes(response.status), `${name} accessible to browser role`)
}
console.log('PASS 17 deployed HTTP boundary checks; no model calls or booking mutations.')
