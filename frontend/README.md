# Railtech operations dashboard

The React/Vite frontend reads the Supabase tables and derived views documented
in the repository root `README.md`. It has no separate browser mock-data path:
both the deterministic showcase seed and live MQTT events use the same queries.

```powershell
Copy-Item .env.example .env
# Fill in the project URL and publishable/anon key. Never use sb_secret_ or a service-role key.
npm install
npm run dev
```

Quality checks:

```powershell
npm test
npm run lint
npm run build
```

If a page reports that an operations table or view is missing, apply the two
additive migrations listed in the root README, reseed, validate, and reload.

Maintenance Planning includes **Plan with AI**, backed by a separate Supabase
Edge Function and private proposal/session tables. See
[assistant setup, safeguards and validation](../docs/MAINTENANCE_ASSISTANT.md).
Run `npm run test:browser` with Vite running on port 5173; Windows uses installed
Edge, while other platforms can install Chromium with `npx playwright install chromium`.
