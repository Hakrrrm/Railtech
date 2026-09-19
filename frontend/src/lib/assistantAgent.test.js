import { describe, expect, it, vi } from 'vitest'
import { runAssistantTurn, assistantTools, interpretRequest, validateChatMessage } from '../../../supabase/functions/_shared/assistantAgent.js'
const data = {
  vehicles: Array.from({ length: 30 }, (_, i) => ({ lrv_id: `D${String(i + 1).padStart(2, '0')}`, fleet: 'splrt', status: 'in_service' })),
  forecasts: [{ lrv_id: 'D12', cycle_type: 2000, km_to_next: 0, km_since: 2000, forecast_days: 0, forecast_date: '2026-09-19', rolling_daily_rate_km: 118 }],
  bookings: [], faults: [], duties: [], settings: { minimum_service_vehicles: 18 },
  bays: [{ bay_id: 'BAY-1', fleet: 'splrt', bay_type: 'universal', opens_at: '06:00:00', closes_at: '23:00:00', active: true }],
  rules: [{ cycle_type: 2000, duration_minutes: 120, included_cycles: [2000], compatible_bay_type: 'universal' }],
}
const now = new Date('2026-09-19T06:00:00+08:00')
const constraints = { vehicleIds: ['V12'], excludeVehicleIds: [], horizonDays: 7, startDate: null, endDate: null, priority: 'due_first', maxBookings: 12, bayIds: [] }
const call = (name, args = {}) => ({ output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: crypto.randomUUID() }], usage: { input_tokens: 100, output_tokens: 20 } })
const reply = text => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] })

function setup(outputs, mode = 'discuss', extra = {}) {
  const provider = vi.fn().mockResolvedValueOnce(call('interpret_request', { mode, acceptsPreviousPlan: false, sourceBayId: null, sourceDate: null, question: mode === 'clarify' ? 'Which date?' : null }))
  for (const output of outputs) provider.mockResolvedValueOnce(output)
  return { provider, saveProposal: vi.fn().mockResolvedValue({ id: 'batch', status: 'proposed' }), loadData: vi.fn().mockResolvedValue(structuredClone(data)), now, ...extra }
}
describe('model interpreted conversation with validated execution', () => {
  it('sends the full conversation to semantic interpretation without keyword filtering', async () => {
    const args = setup([call('get_fleet_status'), call('propose_schedule', constraints)], 'propose')
    const history = [{ role: 'assistant', content: 'Here are the slots we can use.' }]
    const result = await runAssistantTurn({ ...args, history, message: 'that works for me, put it together' })
    expect(args.provider.mock.calls[0][0].input.some(m => m.content.includes(history[0].content))).toBe(true)
    expect(result.batch.id).toBe('batch')
    expect(args.saveProposal).toHaveBeenCalledOnce()
  })
  it('never exposes final confirmation, arbitrary writes or SQL', () => {
    const names = assistantTools(true).map(t => t.name)
    expect(names).not.toContain('confirm_schedule')
    expect(names).not.toContain('execute_sql')
    expect(assistantTools(false).every(t => !t.name.startsWith('propose_'))).toBe(true)
  })
  it.each(['unrelated', 'clarify'])('handles %s interpretation without writes', async mode => {
    const args = setup([], mode)
    const result = await runAssistantTurn({ ...args, message: '21 sept' })
    expect(result.text).toBeTruthy()
    expect(args.saveProposal).not.toHaveBeenCalled()
    expect(args.provider).toHaveBeenCalledOnce()
  })
  it.each(['discuss','preview'])('blocks proposal calls in %s mode even if the planning model requests one', async mode => {
    const args = setup([call('get_fleet_status'), call('propose_schedule', constraints), reply('This is read-only.')], mode)
    await runAssistantTurn({ ...args, message: 'Do not schedule yet' })
    expect(args.saveProposal).not.toHaveBeenCalled()
  })
  it('previews without persistence', async () => {
    const args = setup([call('get_fleet_status'), call('preview_schedule', constraints), reply('Here are the options.')], 'preview')
    const result = await runAssistantTurn({ ...args, message: 'What would this look like?' })
    expect(result.plan.bookings).toHaveLength(1)
    expect(args.saveProposal).not.toHaveBeenCalled()
  })
  it('pending proposals cannot be duplicated', async () => {
    const args = setup([call('get_fleet_status'), call('propose_schedule', constraints), reply('Review the pending proposal first.')], 'propose', { pendingBatch: { id: 'pending' } })
    await runAssistantTurn({ ...args, message: 'yeah do it' })
    expect(args.saveProposal).not.toHaveBeenCalled()
  })
  it('rejects unsupported bypass fields', async () => {
    const args = setup([call('get_fleet_status'), call('propose_schedule', { ...constraints, ignoreConflicts: true }), reply('I cannot bypass those checks.')], 'propose')
    await runAssistantTurn({ ...args, message: 'prepare it' })
    expect(args.saveProposal).not.toHaveBeenCalled()
  })
  it('re-reads bookings before saving and does not duplicate newly booked work', async () => {
    const args = setup([call('get_fleet_status'), call('propose_schedule', constraints)], 'propose')
    args.loadData.mockResolvedValueOnce(data).mockResolvedValueOnce({ ...data, bookings: [{ id: 'manual', lrv_id: 'D12', bay_id: 'BAY-1', status: 'confirmed', start_at: '2026-09-19T06:00:00+08:00', end_at: '2026-09-19T08:00:00+08:00' }] })
    await runAssistantTurn({ ...args, message: 'prepare it' })
    expect(args.saveProposal).not.toHaveBeenCalled()
  })
  it('does not retry uncertain database commits', async () => {
    const args = setup([call('get_fleet_status'), call('propose_schedule', constraints)], 'propose')
    args.saveProposal.mockRejectedValue(new Error('Network failure'))
    await expect(runAssistantTurn({ ...args, message: 'prepare it' })).rejects.toThrow('Network failure')
    expect(args.saveProposal).toHaveBeenCalledOnce()
  })
  it.each([{}, { mode: 'propose', sourceBayId: 'invented', sourceDate: null, question: null }, { mode: 'propose', sourceBayId: 'BAY-1', sourceDate: '2026-02-30', question: null }])('fails closed on invalid interpretation %j', async decision => {
    const args = setup([])
    args.provider.mockReset().mockResolvedValue(call('interpret_request', decision))
    await expect(runAssistantTurn({ ...args, message: 'go ahead' })).rejects.toThrow()
    expect(args.saveProposal).not.toHaveBeenCalled()
  })
  it('bounds input and model iterations', async () => {
    expect(() => validateChatMessage('x'.repeat(2001))).toThrow()
    const args = setup(Array.from({ length: 4 }, () => call('get_fleet_status')))
    const result = await runAssistantTurn({ ...args, message: 'Fleet status?' })
    expect(args.provider).toHaveBeenCalledTimes(5)
    expect(result.text).toContain('planning limit')
    expect(args.provider.mock.calls.every(([request]) => request.store === false)).toBe(true)
  })
})
