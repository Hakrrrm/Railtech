import { supabase } from '../supabaseClient'

const sessionKey = 'railtech-maintenance-assistant-session-v1'
const pendingKey = `${sessionKey}-pending`

export function readAssistantSession() {
  try {
    const value = JSON.parse(globalThis.localStorage.getItem(sessionKey))
    return value?.sessionId && value?.sessionToken ? value : null
  } catch { return null }
}

export function createAssistantSession() {
  const value = { sessionId: crypto.randomUUID(), sessionToken: `${crypto.randomUUID()}${crypto.randomUUID()}` }
  try { globalThis.localStorage.setItem(sessionKey, JSON.stringify(value)) } catch { /* This tab can still use the session in memory. */ }
  return value
}

export function readPendingAssistantRequest(session) {
  try {
    const value = JSON.parse(globalThis.localStorage.getItem(pendingKey))
    return value?.sessionId === session?.sessionId && value?.requestId ? value : null
  } catch { return null }
}

export async function requestMaintenanceAssistant(input) {
  if (!supabase) throw new Error('Connect this dashboard to Supabase to use the maintenance assistant.')
  try { globalThis.localStorage.setItem(pendingKey, JSON.stringify(input)) } catch { /* Retries still work in this tab. */ }
  const { data, error } = await supabase.functions.invoke('maintenance-assistant', { body: input })
  if (error) {
    let detail
    try { detail = await error.context?.json() } catch { /* Network errors have no JSON response. */ }
    const problem = new Error(detail?.error || 'The maintenance assistant could not complete this request. Retry to check the same request safely.')
    problem.sessionExpired = error.context?.status === 410 || /session is not available/i.test(detail?.error || '')
    problem.definitive = Boolean(detail?.error && error.context?.status >= 400 && error.context?.status < 500 && ![408, 409, 429].includes(error.context.status))
    if (problem.sessionExpired) problem.definitive = true
    if (problem.definitive) {
      try { globalThis.localStorage.removeItem(pendingKey) } catch { /* No mutation occurred. */ }
    }
    throw problem
  }
  if (data?.error) {
    const problem = new Error(data.error)
    problem.definitive = true
    problem.sessionExpired = /session is not available/i.test(data.error)
    try { globalThis.localStorage.removeItem(pendingKey) } catch { /* No mutation occurred. */ }
    throw problem
  }
  if (!data || !Array.isArray(data.messages)) throw new Error('The assistant returned an incomplete response. Retry to check the same request safely.')
  try { globalThis.localStorage.removeItem(pendingKey) } catch { /* The server also deduplicates requests. */ }
  return data
}
