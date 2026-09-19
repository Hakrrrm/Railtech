import { beforeEach, describe, expect, it, vi } from 'vitest'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('../supabaseClient', () => ({ supabase: { functions: { invoke } } }))
import { createAssistantSession, readAssistantSession, readPendingAssistantRequest, requestMaintenanceAssistant } from './maintenanceAssistantApi'

beforeEach(() => {
  const values = new Map()
  vi.stubGlobal('localStorage', { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) })
  invoke.mockReset()
})

describe('maintenance assistant request recovery', () => {
  it('retains a lost mutation response for an idempotent retry across reloads', async () => {
    const session = createAssistantSession()
    const input = { ...session, action: 'confirm', batchId: 'batch-1', requestId: crypto.randomUUID() }
    invoke.mockResolvedValueOnce({ error: new Error('connection lost') })
    await expect(requestMaintenanceAssistant(input)).rejects.toThrow('Retry')
    expect(readAssistantSession()).toEqual(session)
    expect(readPendingAssistantRequest(session)).toEqual(input)
    invoke.mockResolvedValueOnce({ data: { messages: [], batch: { id: 'batch-1', status: 'confirmed' } } })
    await requestMaintenanceAssistant(readPendingAssistantRequest(session))
    expect(invoke.mock.calls[0][1].body.requestId).toBe(invoke.mock.calls[1][1].body.requestId)
    expect(readPendingAssistantRequest(session)).toBeNull()
  })

  it('surfaces server constraints and does not mistake a rejected proposal for success', async () => {
    const session = createAssistantSession()
    invoke.mockResolvedValue({ error: { context: { status: 422, json: async () => ({ error: 'Fleet capacity changed. Generate a fresh proposal.' }) } } })
    await expect(requestMaintenanceAssistant({ ...session, action: 'confirm', requestId: crypto.randomUUID() })).rejects.toThrow('Fleet capacity changed')
    expect(readPendingAssistantRequest(session)).toBeNull()
  })

  it('isolates pending requests from a different conversation', async () => {
    const session = createAssistantSession()
    invoke.mockResolvedValue({ data: { invalid: true } })
    await expect(requestMaintenanceAssistant({ ...session, action: 'chat', message: 'Plan due LRVs', requestId: crypto.randomUUID() })).rejects.toThrow('incomplete')
    expect(readPendingAssistantRequest(createAssistantSession())).toBeNull()
  })

  it.each([
    [410, 'This conversation has expired.'],
    [403, 'The session is not available. Start a new conversation.'],
  ])('recognizes unavailable sessions (%s) without replaying their mutations', async (status, message) => {
    const session = createAssistantSession()
    invoke.mockResolvedValue({ error: { context: { status, json: async () => ({ error: message }) } } })
    await expect(requestMaintenanceAssistant({ ...session, action: 'confirm', batchId: 'old-batch', requestId: crypto.randomUUID() })).rejects.toMatchObject({ sessionExpired: true, definitive: true })
    expect(readPendingAssistantRequest(session)).toBeNull()
    expect(readAssistantSession()).toEqual(session)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('does not treat a generic origin rejection as an expired conversation', async () => {
    invoke.mockResolvedValue({ error: { context: { status: 403, json: async () => ({ error: 'Origin is not allowed.' }) } } })
    await expect(requestMaintenanceAssistant({ action: 'history' })).rejects.toMatchObject({ sessionExpired: false })
  })
})
