CREATE TABLE "incident_resolution_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"source_kind" text DEFAULT 'sweep' NOT NULL,
	"proposed_reason_code" text NOT NULL,
	"proposed_reason_text" text NOT NULL,
	"confidence" text NOT NULL,
	"evidence" jsonb,
	"slack_installation_id" uuid,
	"slack_channel_id" text,
	"slack_message_ts" text,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decided_by_slack_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "investigation_events_investigation_idx";--> statement-breakpoint
DROP INDEX "investigation_events_provider_event_idx";--> statement-breakpoint
DROP INDEX "investigation_events_dedupe_idx";--> statement-breakpoint
ALTER TABLE "investigation_events" ALTER COLUMN "investigation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolved_by_kind" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolved_by_slack_user_id" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolved_reason_code" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolved_reason_text" text;--> statement-breakpoint
ALTER TABLE "investigation_events" ADD COLUMN "incident_id" uuid;--> statement-breakpoint
ALTER TABLE "incident_resolution_proposals" ADD CONSTRAINT "incident_resolution_proposals_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_resolution_proposals" ADD CONSTRAINT "incident_resolution_proposals_slack_installation_id_slack_installations_id_fk" FOREIGN KEY ("slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_resolution_proposals" ADD CONSTRAINT "incident_resolution_proposals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_resolution_proposals_incident_idx" ON "incident_resolution_proposals" USING btree ("incident_id","proposed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_resolution_proposals_slack_msg_idx" ON "incident_resolution_proposals" USING btree ("slack_channel_id","slack_message_ts") WHERE slack_channel_id IS NOT NULL AND slack_message_ts IS NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_events" ADD CONSTRAINT "investigation_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investigation_events_incident_idx" ON "investigation_events" USING btree ("incident_id","created_at") WHERE incident_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_events_incident_provider_event_idx" ON "investigation_events" USING btree ("incident_id","provider_event_id") WHERE investigation_id IS NULL AND incident_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_events_incident_dedupe_idx" ON "investigation_events" USING btree ("incident_id","dedupe_key") WHERE investigation_id IS NULL AND incident_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "investigation_events_investigation_idx" ON "investigation_events" USING btree ("investigation_id","created_at") WHERE investigation_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_events_provider_event_idx" ON "investigation_events" USING btree ("investigation_id","provider_event_id") WHERE investigation_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_events_dedupe_idx" ON "investigation_events" USING btree ("investigation_id","dedupe_key") WHERE investigation_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "investigation_events" ADD CONSTRAINT "investigation_events_parentage_check" CHECK (investigation_id IS NOT NULL OR incident_id IS NOT NULL);