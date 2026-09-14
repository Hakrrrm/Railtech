-- Example seed rows for bring-up/testing. Copy to seed.sql (gitignored is
-- NOT required here -- there's nothing secret in this file, just adjust
-- the lrv_id values to match whatever the firmware config.h LRV_ID/FLEET
-- fields are set to) and run in the Supabase SQL editor.
--
-- The FK on segment_traversals.lrv_id will reject events for any vehicle
-- not seeded here -- that's intentional (Build Plan Sec 8).

insert into vehicles (lrv_id, fleet, type, status) values
  ('D07', 'splrt', 'LRV', 'active');
