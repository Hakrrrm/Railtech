# Maintenance planning assistant

The **Plan with AI** button on Maintenance Planning opens a chat drawer. Operators can ask about priorities, forecast horizons, workshop duration, existing bookings and bay availability, compare a read-only plan, then request a proposal. The assistant uses **GPT-4.1 mini**, approved for this feature; OCR retains its separate model setting.

Example conversation:

1. “Which LRVs need attention first, and why?”
2. “What bay capacity is available tomorrow?”
3. “Preview V12 and V29 only over the next seven days.”
4. “Schedule V12 and V29 over the next seven days.”
5. Inspect the blue calendar slots and proposal details, then click **Confirm schedule**. The slots turn green and a notification appears. **Discard proposal** releases the draft slots instead.

The model cannot confirm, cancel existing work, alter mileage, complete maintenance or run arbitrary SQL. Confirmation uses a separate operator action. The assistant redirects unrelated requests and uses calm, concise operational language. Forecasts are estimates; workshop reservation time does not establish continuous staff working hours.

## Components and data flow

- `frontend/src/components/MaintenanceAssistant.jsx`: accessible responsive chat drawer, independent preview/proposal cards, explicit confirmation and discard, retry/reload recovery.
- `frontend/src/lib/maintenanceAssistantApi.js`: Supabase Edge Function transport and browser session capability storage. Requests retain UUIDs across retries.
- `supabase/functions/maintenance-assistant/index.ts`: authenticated/capability-checked endpoint, database reads, Responses API calls, durable messages and proposal actions. No API key reaches the browser.
- `supabase/functions/_shared/assistantAgent.js`: semantic conversation interpretation, bounded tool loop, strict tool schemas and usage accounting. There are no keyword-based conversational routes. GPT-4.1 mini resolves intent, source bay/date and contextual assent before proposal tools are exposed. The only model tools are fleet status, bay availability, preview, proposal and a clarification question. Explicit preview/proposal requests must produce a computed plan or clarification rather than just a conversational promise.
- `supabase/functions/_shared/assistantPlanner.js`: deterministic planner shared with synthetic tests. The model selects supported constraints; it never chooses arbitrary booking timestamps.
- Migrations `202609190002` and `202609190003`: private sessions, messages, proposal batches, audit, rate limits, atomic reservations and confirmation, expiry, cleanup and demo reset integration.

Each turn reads current fleet data. Previews and proposals read it again. Confirming revalidates booking contents, cycles, faults, duties, bay compatibility, duration, conflicts, turnaround and the fleet service minimum in a database transaction. A batch confirms entirely or fails entirely. A failed or retried response cannot create another batch with the same request ID. A comparison preview cannot replace the plan associated with a Confirm button.

Planning respects the due day or earliest feasible later day, balances compatible bays within that day, reserves a 30-minute turnaround, protects 12:00–13:00 lunch for short visits, and handles long packages as continuous bay occupancy. Existing unresolved visits exclude duplicate vehicle bookings. The default order is due today/overdue, faults by severity/age, then nearest future due date. Requested alternatives remain bounded by operating constraints. Missing forecasts/rules/capacity settings fail safely and skipped work is explained.

Supported preferences: selected/excluded LRVs, bay selection, start-date window, 1–42 day horizon, at most 12 bookings, due-first/faults-first/short-jobs-first priority. Short-jobs-first breaks ties within the same urgency/due day; it does not move a future routine job ahead of urgent work. Date windows constrain booking starts; long packages can finish later. Unsupported constraints such as staffing/parts should prompt clarification. This is a bounded planning assistant, not an unconstrained optimizer.

## Rescheduling confirmed bookings

Ask "Reschedule V23 and V24 to Bay 2" to prepare moves for existing future confirmed work. The booked scope, duration, fault and notes are preserved. Dates and times default to the originals; explicit dates/times are respected. The rescheduling window is independently bounded to 42 days, so an earlier one-day new-booking preference does not reject a later move.

Blue proposed moves overlay the calendar while original bookings remain green and reserved. **Confirm reschedule** atomically moves the same booking records after checking their original versions and operational constraints again. **Discard proposal**, expiry or a failed validation leaves originals untouched. Changes to any selected booking invalidate the whole proposal; refresh and prepare another. Started/completed jobs cannot move. Rescheduling previews do not reserve destination bays, so another operator taking a destination can prevent confirmation.

The deterministic implementation is `supabase/functions/_shared/assistantRescheduling.js`; migration `202609190004` adds service-only proposal and atomic rescheduling RPCs. Replies normally use 2-4 sentences or up to three short bullets, avoid repeating earlier summaries, and report planning errors directly.

## Setup and deployment

From PowerShell, the helper script works from any directory:

```powershell
& C:\Users\mhake\Documents\Railtech\scripts\deploy-maintenance-assistant.ps1 -AllowDemo
```

It links the project, applies pending migrations, configures the approved model and allowed origins, then deploys the Edge Function using the API (no Docker required). It uses the existing server `OPENAI_API_KEY`. Never add that key to a `VITE_` variable or commit it. To use another project/origin, pass `-ProjectRef` and `-Origins` explicitly. The UI deploys through the existing Vercel Git integration.

Server settings:

| Secret | Value/purpose |
| --- | --- |
| `OPENAI_API_KEY` | Existing server-only OpenAI project key |
| `OPENAI_MAINTENANCE_MODEL` | `gpt-4.1-mini` |
| `MAINTENANCE_ASSISTANT_ORIGINS` | Comma-separated exact permitted frontend origins |
| `MAINTENANCE_ASSISTANT_ALLOW_DEMO` | `true` for the existing synthetic demo; otherwise anonymous access is denied |

The function has gateway JWT verification disabled to support Supabase publishable keys; the handler itself verifies authenticated user tokens and session capabilities. Do not interpret CORS or a public Supabase key as operator authentication.

**Current demo access:** explicitly enabled for the synthetic fleet. All dashboard visitors, including signed-in accounts without planner roles, receive demo planning access. Role enforcement resumes when demo access is disabled. Each browser uses a random session capability; only its hash is stored on the server. All new assistant tables and RPCs are inaccessible to anonymous browser roles. The existing application still exposes its legacy anonymous manual scheduling/reset RPCs, so this deployment is a demo, not a fully authenticated operational control system.

**Before real operational use:** disable demo access, add an application sign-in flow and assign `admin` or `maintenance_planner` in server-managed Supabase `app_metadata.roles` (or `app_metadata.role`). Restrict the legacy manual scheduling/reset APIs too. Authenticated users remain scoped to SPLRT in this version. Browser session capabilities remain sensitive and should not be shared. Shared-device users should sign out and clear local application storage.

## Limits, lifecycle and costs

- Messages: 2,000 characters. Model context: last 12 bounded messages plus durable last validated planning preferences and current structured facts.
- Provider calls: at most four rounds, six tool calls and 650 generated tokens per round; 20-second timeout per provider call within a 65-second planning deadline. Database requests have eight-second timeouts. Only one chat turn per session can run at a time.
- SQL-enforced usage caps: 100 turns/session/hour, 500 turns/actor/day and 2,000 turns globally/day. Failed provider attempts count. Demo actor tracking uses a hashed request address as an abuse heuristic; the global cap is the reliable final budget bound.
- Session creation: 20/actor/day, 300/global/day. Sessions expire after 24 hours. Proposals expire after two hours; a five-minute database cron releases abandoned draft reservations. Confirmed slots are never expired.
- Housekeeping deletes conversations seven days after session expiry and audit entries after 30 days. The demo reset also clears demo assistant conversations/drafts, browser retry/session cache and rolling usage allowances for the demo sessions, including session-creation counts. Audit history is preserved with reset event labels; authenticated non-demo usage is retained. Audit records contain tool names/constraints and token usage; no API keys or raw IP addresses.
- GPT-4.1 mini published rates checked at implementation: $0.40/million input tokens and $1.60/million output tokens. A 6,000-input/800-output example is about $0.0037, but a tool-based turn may use multiple calls and cost more. Actual token counts are recorded in `assistant_audit` under `turn_completed`. Configure OpenAI project budget alerts/limits in addition to request caps.

Pricing source: [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini). Tool integration: [Function calling](https://developers.openai.com/api/docs/guides/function-calling).

## Validation

```powershell
cd C:\Users\mhake\Documents\Railtech\frontend
npm test
npm run lint
npm run build
npx --yes deno check ../supabase/functions/maintenance-assistant/index.ts
cd ..
npx supabase@latest db query --linked --file supabase/tests/maintenance_assistant.sql
npx supabase@latest db query --linked --file supabase/tests/maintenance_assistant_atomic.sql
npx supabase@latest db query --linked --file supabase/tests/maintenance_assistant_reschedule.sql
node scripts/test-maintenance-assistant-http.mjs
node scripts/test-maintenance-assistant-browser.cjs
node scripts/evaluate-maintenance-assistant.mjs
```

SQL tests wrap changes in a rollback transaction. Browser tests isolate all backend traffic with fixtures and use installed Edge/Playwright. Live-model evaluations require the configured synthetic 30-LRV project and make only read/preview requests; they check that bookings are unchanged and save the responses to `docs/maintenance-assistant-evaluation.json`. They incur a small API cost. Review the saved answers, not only pass counts: language-model responses are probabilistic. Unit tests use the complete synthetic fleet and varied scenarios; no hardcoded assumption that an old dashboard count stays five after the shared-rate forecast change.

Start Vite separately (`npm run dev` in `frontend`) before the browser suite. `npm install` installs its Playwright dependency; Windows uses installed Edge. On Linux/macOS, first run `npx playwright install chromium` in `frontend` or set `PLAYWRIGHT_CHANNEL` to an installed supported browser.

Known limits: no staff/parts inventory, no autonomous repairs, no persisted cross-device login/session transfer in demo mode. Bookings are shared in Supabase and refresh through the existing realtime subscriptions. A pending proposal belongs to its originating session; other operators see its occupied slots but cannot confirm it through this assistant session.

### Verified release

On 19 September 2026: 123 unit tests, 12 isolated browser flows, 17 deployed HTTP boundary checks, both transactional SQL regression suites, and the final 10 live-model cases passed. A separate real-browser smoke check verified Vite → Supabase → GPT-4.1 mini → visible fleet reply. Build, lint and Deno type checks passed. Live evaluation booking rows were unchanged. Earlier evaluations caught timezone, bay-capability and skipped-preview errors; explicit local-time facts, calculated availability windows and required action tools address those regressions.

Rescheduling follow-up: 142 unit tests, 15 isolated browser flows and all three SQL rollback suites passed. The live model successfully previewed the V23/V24 move to Bay 2 on 21 September. Further live-model requests reached the existing daily cap; it was not raised. Preview and proposal summaries now use concise deterministic text. See `maintenance-reschedule-evaluation.json`.

Priority auto-scheduling uses the same overdue/due-within-seven-days/fault selection as Fleet Overview, rather than the first 12 future forecasts. Bay-clearance questions compute a scoped reschedule preview immediately; short affirmative replies prepare the proposal for separate confirmation. Verified with 152 unit tests, 15 browser flows, 17 deployed HTTP checks, transactional reschedule SQL tests, and a live preview/propose/history/discard flow that preserved original bookings.


## Conversational planning revision

Every turn uses a structured model interpretation of the latest request, with history supplied as reference data. It distinguishes discussion, read-only previews, provisional proposals, clarification and unrelated requests. An operational outcome such as “I need Bay 2 clear tomorrow” authorizes a proposal; the separate Confirm button remains mandatory for actual moves.

Bay-clearance tools select source bookings from current database rows. Generic rescheduling tools are checked against the interpreted source scope. Whole-bay requests must consider every movable source booking. The planner and transactional database checks remain deterministic.

A saved preview records its validated request and slot signature. Natural assent re-runs that request and compares the resulting slots before saving a proposal. If the schedule changed, the operator sees an updated preview instead. Dates and times appear in the structured comparison card; model prose does not redefine them.

Migration 202609190007 permits moving future confirmed preventive visits for vehicles labelled maintenance, matching the existing planner. Already-started bookings and faulty-vehicle preventive moves remain blocked.

Validation: `node scripts/evaluate-maintenance-conversation.mjs` runs a real GPT-4.1 mini conversation against the synthetic project, persists and discards proposals, and verifies original bookings are unchanged. Results are recorded in `docs/maintenance-conversation-evaluation.json`. Unit tests cover tool permissions, malformed interpretation, stale previews, source-bay selection and uncertain writes. SQL reschedule tests run in a transaction that rolls back.
