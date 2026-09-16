# MQTT ingest bridge and simulator

`index.js` subscribes to `lrv/+/+/events`, validates Tier 1 `SEG_DONE` packets
and idempotently inserts them into Supabase. Packets are processed in sequence
per vehicle, transient database errors receive bounded retries, and exhausted or
invalid packets are written to the configured NDJSON dead-letter file.

```powershell
Copy-Item .env.example .env
# Configure MQTT_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
npm install
npm start
```

Run the optional simulator in another terminal with `npm run simulate`. It
publishes through MQTT and never writes directly to Supabase. `SIM_SPEED`
controls cadence rather than altering calibrated segment distances.

Checks:

```powershell
npm test
npm run test:mqtt  # optional public/network broker round trip
```

Use `mqtts://` with broker authentication outside local/demo testing. The bridge
retries short Supabase failures, but the current cellular firmware still sends
QoS 0 and has no automatic SD replay; that is a field-readiness item rather than
a property this bridge can recover after a device-side loss.
