ALTER TABLE "investigations" RENAME TO "agent_runs";--> statement-breakpoint
ALTER TABLE "investigation_events" RENAME TO "incident_events";--> statement-breakpoint
ALTER TABLE "agent_linear_tickets" RENAME COLUMN "investigation_id" TO "agent_run_id";--> statement-breakpoint
ALTER TABLE "agent_pull_requests" RENAME COLUMN "investigation_id" TO "agent_run_id";--> statement-breakpoint
ALTER TABLE "incident_events" RENAME COLUMN "investigation_id" TO "agent_run_id";--> statement-breakpoint
ALTER TABLE "org_agent_settings" RENAME COLUMN "investigation_enabled" TO "agent_run_enabled";--> statement-breakpoint
ALTER TABLE "project_automation_settings" RENAME COLUMN "investigation_provider" TO "agent_run_provider";--> statement-breakpoint
ALTER TABLE "project_automation_settings" RENAME COLUMN "investigation_enabled" TO "agent_run_enabled";--> statement-breakpoint
ALTER TABLE "incident_events" DROP CONSTRAINT "investigation_events_parentage_check";--> statement-breakpoint
ALTER TABLE "agent_linear_tickets" DROP CONSTRAINT "agent_linear_tickets_investigation_id_investigations_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_pull_requests" DROP CONSTRAINT "agent_pull_requests_investigation_id_investigations_id_fk";
--> statement-breakpoint
ALTER TABLE "incident_events" DROP CONSTRAINT "investigation_events_investigation_id_investigations_id_fk";
--> statement-breakpoint
ALTER TABLE "incident_events" DROP CONSTRAINT "investigation_events_incident_id_incidents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "investigations_incident_id_incidents_id_fk";
--> statement-breakpoint
DROP INDEX "agent_linear_tickets_investigation_idx";--> statement-breakpoint
DROP INDEX "agent_pull_requests_investigation_idx";--> statement-breakpoint
DROP INDEX "investigation_events_investigation_idx";--> statement-breakpoint
DROP INDEX "investigation_events_incident_idx";--> statement-breakpoint
DROP INDEX "investigation_events_provider_event_idx";--> statement-breakpoint
DROP INDEX "investigation_events_incident_provider_event_idx";--> statement-breakpoint
DROP INDEX "investigation_events_dedupe_idx";--> statement-breakpoint
DROP INDEX "investigation_events_incident_dedupe_idx";--> statement-breakpoint
DROP INDEX "investigations_incident_idx";--> statement-breakpoint
DROP INDEX "investigations_provider_session_idx";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ALTER COLUMN "enabled_events" SET DEFAULT '["agent_run.completed"]'::jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "agent_summary" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "root_cause_text" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "root_cause_confidence" integer;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "estimated_impact_text" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "estimated_impact_confidence" integer;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "suggested_severity" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "noise_classification" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolution_classification" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "findings_agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_linear_tickets" ADD CONSTRAINT "agent_linear_tickets_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pull_requests" ADD CONSTRAINT "agent_pull_requests_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_findings_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("findings_agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_linear_tickets_agent_run_idx" ON "agent_linear_tickets" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "agent_pull_requests_agent_run_idx" ON "agent_pull_requests" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "incident_events_agent_run_idx" ON "incident_events" USING btree ("agent_run_id","created_at") WHERE agent_run_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "incident_events_incident_idx" ON "incident_events" USING btree ("incident_id","created_at") WHERE incident_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_events_provider_event_idx" ON "incident_events" USING btree ("agent_run_id","provider_event_id") WHERE agent_run_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_events_incident_provider_event_idx" ON "incident_events" USING btree ("incident_id","provider_event_id") WHERE agent_run_id IS NULL AND incident_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_events_dedupe_idx" ON "incident_events" USING btree ("agent_run_id","dedupe_key") WHERE agent_run_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_events_incident_dedupe_idx" ON "incident_events" USING btree ("incident_id","dedupe_key") WHERE agent_run_id IS NULL AND incident_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_runs_incident_idx" ON "agent_runs" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_provider_session_idx" ON "agent_runs" USING btree ("provider_session_id");--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_parentage_check" CHECK (agent_run_id IS NOT NULL OR incident_id IS NOT NULL);