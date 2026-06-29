ALTER TABLE "webhook_endpoints" ALTER COLUMN "enabled_events" SET DEFAULT '["incident.created","incident.updated"]'::jsonb;--> statement-breakpoint
-- Backfill: pre-existing endpoints subscribed only to legacy event names
-- (e.g. ["agent_run.completed"]) would silently stop receiving deliveries
-- under the two-event model, since enqueue filters by exact enabledEvents
-- match and the code now only emits incident.created / incident.updated.
-- Migrate any row that subscribes to neither current event onto both.
UPDATE "webhook_endpoints"
SET "enabled_events" = '["incident.created","incident.updated"]'::jsonb
WHERE NOT (
  "enabled_events" @> '["incident.created"]'::jsonb
  OR "enabled_events" @> '["incident.updated"]'::jsonb
);
