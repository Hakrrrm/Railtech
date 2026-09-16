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
