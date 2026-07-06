DROP INDEX "incident_issues_issue_idx";--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "previous_incident_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "escalation_trigger" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "observation_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "observation_baseline_event_count" bigint;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_previous_incident_id_incidents_id_fk" FOREIGN KEY ("previous_incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_issues_pair_idx" ON "incident_issues" USING btree ("incident_id","issue_id");--> statement-breakpoint
CREATE INDEX "incident_issues_issue_lookup_idx" ON "incident_issues" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issues_observation_idx" ON "issues" USING btree ("project_id","observation_started_at") WHERE status = 'under_observation';--> statement-breakpoint
CREATE INDEX "issues_project_status_idx" ON "issues" USING btree ("project_id","status");