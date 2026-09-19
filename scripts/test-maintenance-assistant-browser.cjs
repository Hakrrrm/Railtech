/* Run against a local Vite server. All Supabase HTTP requests are intercepted;
   this exercises UI behavior without touching live bookings or using model tokens.
   PLAYWRIGHT_MODULE may point to an installed Playwright package. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '../frontend/node_modules/playwright')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

async function main() {
  const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : null)
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    context.setDefaultTimeout(10000)
    const page = await context.newPage()
    const crashes = []
    page.on('pageerror', (error) => crashes.push(error.message))
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date())
    const startAt = new Date(`${today}T14:00:00+08:00`).toISOString()
    const endAt = new Date(`${today}T16:00:00+08:00`).toISOString()
    const vehicles = Array.from({ length: 30 }, (_, index) => ({ lrv_id: `D${String(index + 1).padStart(2, '0')}`, fleet: 'splrt', status: 'in_service' }))
    const bookings = []
    const sessions = new Map()
    const requests = []
    const rows = {
      vehicles,
      vehicle_mileage_summary: vehicles.map((vehicle) => ({ ...vehicle, device_odo_km: 200000, lifetime_planning_mileage_km: 200000 })),
      cycle_forecasts: [{ lrv_id: 'D12', cycle_type: 2000, km_to_next: 0, forecast_days: 0, priority_score: 100 }],
      maintenance_bookings: bookings,
      depot_bays: [{ bay_id: 'B1', fleet: 'splrt', name: 'Bay 1 · Routine', bay_type: 'routine', active: true, opens_at: '06:00:00', closes_at: '23:00:00' }, { bay_id: 'B2', fleet: 'splrt', name: 'Bay 2 · Heavy', bay_type: 'heavy', active: true, opens_at: '06:00:00', closes_at: '23:00:00' }],
      maintenance_cycle_rules: [{ cycle_type: 2000, included_cycles: [2000], duration_minutes: 120, compatible_bay_type: 'routine' }],
      planning_settings: [{ fleet: 'splrt', minimum_service_vehicles: 18 }],
      duty_assignments: [], maintenance_faults: [],
    }
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'content-type': 'application/json' }
    await context.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, headers: cors, body: JSON.stringify(rows[new URL(route.request().url()).pathname.split('/').at(-1)] || []) }))
    let rejectNextChat = false
    let loseNextResponse = false
    let expiredSessionId = null
    const cached = new Map()
    await context.route('**/functions/v1/maintenance-assistant', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors, body: '{}' })
      const input = route.request().postDataJSON()
      requests.push(input)
      if (input.sessionId === expiredSessionId) return route.fulfill({ status: 410, headers: cors, body: JSON.stringify({ error: 'This conversation has expired. Start a new conversation.' }) })
      if (cached.has(input.requestId)) return route.fulfill({ status: 200, headers: cors, body: cached.get(input.requestId) })
      const session = sessions.get(input.sessionId) || { messages: [], batch: null, plan: null }
      sessions.set(input.sessionId, session)
      if (input.action === 'chat' && rejectNextChat) {
        rejectNextChat = false
        return route.fulfill({ status: 422, headers: cors, body: JSON.stringify({ error: 'No compatible bay available for that constraint.' }) })
      }
      if (input.action === 'chat') {
        session.messages.push({ id: randomUUID(), role: 'user', content: input.message })
        if (/reschedule/i.test(input.message)) {
          const original = bookings.find((booking) => booking.status === 'confirmed')
          session.batch = { id: randomUUID(), status: 'proposed', booking_ids: [original.id], metadata: { kind: 'reschedule' } }
          session.plan = { kind: 'reschedule', bookings: [{ bookingId: original.id, lrvId: original.lrv_id, bayId: original.bay_id === 'B1' ? 'B2' : 'B1', startAt: original.start_at, endAt: original.end_at, primaryCycle: original.primary_cycle, original: { id: original.id, bayId: original.bay_id, startAt: original.start_at, endAt: original.end_at } }], skipped: [], warnings: [] }
          session.messages.push({ id: randomUUID(), role: 'assistant', content: 'The proposed move is ready to review.' })
        } else if (/propose/i.test(input.message)) {
          const id = randomUUID()
          bookings.push({ id, lrv_id: 'D12', bay_id: 'B1', start_at: startAt, end_at: endAt, primary_cycle: 2000, bundled_cycles: [2000], work_type: 'preventive', status: 'proposed' })
          session.batch = { id: randomUUID(), status: 'proposed', booking_ids: [id], expires_at: new Date(Date.now() + 3600000).toISOString() }
          session.plan = { bookings: [{ lrvId: 'D12', bayId: 'B1', startAt, endAt, primaryCycle: 2000, workType: 'preventive' }], skipped: [], warnings: [] }
          session.messages.push({ id: randomUUID(), role: 'assistant', content: 'I have proposed a 2K slot for V12. Review the blue booking, then confirm when ready.' })
        } else if (/compare preview/i.test(input.message)) {
          session.previewPlan = { bookings: [{ lrvId: 'D21', bayId: 'B2', startAt, endAt, primaryCycle: 2000, workType: 'preventive' }], skipped: [], warnings: [] }
          session.messages.push({ id: randomUUID(), role: 'assistant', content: 'Here is a read-only alternative for V21. Your pending V12 proposal is unchanged.' })
        } else session.messages.push({ id: randomUUID(), role: 'assistant', content: 'V12 is due today. Its 2K maintenance requires 2 hours in a compatible bay.' })
      }
      if (input.action === 'confirm' || input.action === 'discard') {
        session.batch.status = input.action === 'confirm' ? 'confirmed' : 'discarded'
        for (const booking of bookings.filter((booking) => session.batch.booking_ids.includes(booking.id))) {
          if (session.plan.kind === 'reschedule') {
            if (input.action === 'confirm') { const move = session.plan.bookings.find((item) => item.bookingId === booking.id); booking.bay_id = move.bayId; booking.start_at = move.startAt; booking.end_at = move.endAt }
          } else booking.status = input.action === 'confirm' ? 'confirmed' : 'cancelled'
        }
      }
      const body = JSON.stringify({ sessionId: input.sessionId, ...session })
      cached.set(input.requestId, body)
      if (loseNextResponse && input.action === 'chat') { loseNextResponse = false; return route.abort('connectionfailed') }
      await route.fulfill({ status: 200, headers: cors, body })
    })
    await page.goto(`${process.env.ASSISTANT_TEST_URL || 'http://127.0.0.1:5173'}/#/maintenance`)
    await page.getByRole('button', { name: 'Plan with AI' }).click()
    await page.getByRole('button', { name: 'Which LRVs need attention first, and why?' }).click()
    await page.getByText('V12 is due today. Its 2K maintenance requires 2 hours in a compatible bay.').waitFor()
    const composer = page.getByRole('textbox', { name: 'Ask about this fleet or request a proposal' })
    await composer.fill('Propose V12 maintenance')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.locator('.booking-proposed').waitFor()
    assert.equal(await page.locator('.booking-confirmed').count(), 0)
    await page.getByRole('button', { name: 'Close maintenance assistant' }).click()
    assert.match(await page.getByRole('button', { name: /Plan with AI/ }).innerText(), /1 to confirm/)
    await page.reload()
    await page.getByRole('button', { name: /Plan with AI/ }).click()
    await page.getByRole('button', { name: 'Confirm schedule', exact: true }).waitFor()
    const pendingBatchId = [...sessions.values()].find((session) => session.batch?.status === 'proposed').batch.id
    await composer.fill('Compare preview for V21 without changing my proposal')
    await page.getByRole('button', { name: 'Send message' }).click()
    const previewCard = page.locator('.maintenance-assistant-plan').filter({ has: page.getByRole('heading', { name: 'Schedule preview', exact: true }) })
    await previewCard.getByText('V21 · 2K').waitFor()
    const pendingCard = page.locator('.maintenance-assistant-plan').filter({ has: page.getByRole('heading', { name: 'Proposed schedule', exact: true }) })
    await pendingCard.getByText('V12 · 2K').waitFor()
    assert.equal(await pendingCard.getByText('V21 · 2K').count(), 0)
    await page.getByText('Shown in blue. Confirm to commit the schedule.').waitFor()
    await page.getByRole('button', { name: 'Confirm schedule', exact: true }).click()
    await page.locator('.booking-confirmed').waitFor()
    await page.getByText('AI proposal confirmed. The bookings are now green.').waitFor()
    assert.equal(await page.locator('.booking-proposed').count(), 0)
    assert.equal(requests.filter((request) => request.action === 'confirm').at(-1).batchId, pendingBatchId)
    await page.getByRole('button', { name: 'New conversation' }).click()
    await composer.fill('Propose another slot')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('button', { name: 'Discard proposal' }).click()
    await page.getByText('AI proposal discarded. The LRVs are available for planning again.').waitFor()
    assert.equal(await page.locator('.booking-proposed').count(), 0)

    await page.getByRole('button', { name: 'New conversation' }).click()
    const originalBooking = bookings.find((booking) => booking.status === 'confirmed')
    const originalId = originalBooking.id
    const originalBay = originalBooking.bay_id
    const originalCount = bookings.length
    await composer.fill('Reschedule V12 to Bay 2')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('button', { name: 'Confirm reschedule', exact: true }).waitFor()
    assert.equal(originalBooking.bay_id, originalBay)
    assert.equal(bookings.length, originalCount)
    assert.equal(await page.locator('.booking-proposed').count(), 1)
    assert.equal(await page.locator('.booking-confirmed').count(), 1)
    await page.reload()
    await page.getByRole('button', { name: /Plan with AI/ }).click()
    await page.getByRole('button', { name: 'Confirm reschedule', exact: true }).waitFor()
    assert.equal(await page.locator('.booking-proposed').count(), 1)
    assert.equal(originalBooking.bay_id, originalBay)
    await page.getByRole('button', { name: 'Close maintenance assistant' }).click()
    await page.getByRole('button', { name: 'Review proposed move for V12' }).click()
    await page.getByRole('button', { name: 'Confirm reschedule', exact: true }).click()
    await page.getByText('Reschedule confirmed. The bookings have moved and are green.').waitFor()
    assert.equal(originalBooking.id, originalId)
    assert.equal(originalBooking.bay_id, 'B2')
    assert.equal(bookings.length, originalCount)
    assert.equal(await page.locator('.booking-proposed').count(), 0)
    await page.getByRole('button', { name: 'New conversation' }).click()
    await composer.fill('Reschedule V12 back to Bay 1')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('button', { name: 'Confirm reschedule', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Discard proposal' }).click()
    await page.getByText('Reschedule discarded. Original bookings are unchanged.').waitFor()
    assert.equal(originalBooking.bay_id, 'B2')
    assert.equal(originalBooking.status, 'confirmed')
    assert.equal(await page.locator('.booking-proposed').count(), 0)

    rejectNextChat = true
    await composer.fill('Check unavailable capacity')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByText('No compatible bay available for that constraint.').waitFor()
    assert.equal(await composer.isEnabled(), true)
    loseNextResponse = true
    await composer.fill('Read priorities once more')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('button', { name: 'Retry request' }).waitFor()
    const failedId = requests.at(-1).requestId
    await page.reload()
    await page.getByRole('button', { name: /Plan with AI/ }).click()
    await page.getByText('V12 is due today. Its 2K maintenance requires 2 hours in a compatible bay.').waitFor()
    assert.ok(requests.filter((request) => request.requestId === failedId).length >= 2)

    await page.getByRole('button', { name: 'Close maintenance assistant' }).focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'maintenance-assistant-message')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.match(await page.evaluate(() => document.activeElement.textContent), /Plan with AI/)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: /Plan with AI/ }).click()
    const dimensions = await page.getByRole('dialog').evaluate((element) => ({ width: element.getBoundingClientRect().width, bottom: element.getBoundingClientRect().bottom, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, bodyOverflow: document.body.style.overflow }))
    assert.ok(dimensions.width <= 390)
    assert.ok(dimensions.bottom <= 844)
    assert.ok(dimensions.scrollHeight <= dimensions.clientHeight + 1)
    assert.equal(dimensions.bodyOverflow, 'hidden')
    await page.screenshot({ path: process.env.ASSISTANT_SCREENSHOT || join(tmpdir(), 'railtech-assistant-mobile.png') })
    await composer.fill('Propose V12 maintenance')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('button', { name: 'Confirm schedule', exact: true }).waitFor()
    expiredSessionId = requests.at(-1).sessionId
    await page.getByRole('button', { name: 'Close maintenance assistant' }).click()
    await page.getByRole('button', { name: /Plan with AI/ }).click()
    await page.getByText('This conversation has expired. Start a new conversation.').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Confirm schedule', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'New conversation' }).isEnabled(), true)
    assert.equal(await page.getByRole('button', { name: 'Retry request' }).count(), 0)
    const mutationCount = requests.filter((request) => ['chat', 'confirm', 'discard'].includes(request.action)).length
    await page.getByRole('button', { name: 'New conversation' }).click()
    await page.getByRole('button', { name: 'Which LRVs need attention first, and why?' }).waitFor()
    assert.equal(requests.filter((request) => ['chat', 'confirm', 'discard'].includes(request.action)).length, mutationCount)
    assert.notEqual(requests.at(-1).sessionId, expiredSessionId)
    assert.deepEqual(crashes, [])
    console.log(JSON.stringify({ passed: ['fleet read', 'proposal blue', 'reload restores proposal', 'comparison preview cannot replace pending batch', 'confirm green + notification', 'discard', 'reschedule overlay preserves original', 'reschedule confirms same booking ID', 'reschedule discard leaves original unchanged', 'validation recovery', 'lost response idempotent retry', 'focus trap', 'escape focus restore', 'mobile viewport fit', 'expired active session allows fresh conversation without replaying mutations'], requests: requests.length, dimensions }, null, 2))
  } finally { await browser.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
