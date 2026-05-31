CREATE TABLE IF NOT EXISTS "incident_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"service" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"issue_count" integer DEFAULT 1 NOT NULL,
	"slack_channel_id" text,
	"slack_thread_ts" text,
	"last_slack_posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investigation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"investigation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"summary" text,
	"detail" jsonb,
	"provider_event_id" text,
	"dedupe_key" text,
	"processed_at" timestamp with time zone,
	"slack_posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investigations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"runtime" text DEFAULT 'anthropic' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"provider_session_id" text,
	"provider_thread_id" text,
	"provider_session_status" text,
	"selected_repo_full_name" text,
	"selected_repo_url" text,
	"selected_base_branch" text,
	"selected_repo_score" integer,
	"cumulative_runtime_minutes" integer DEFAULT 0 NOT NULL,
	"resume_count" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_slack_posted_at" timestamp with time zone,
	"failure_reason" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_automation_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"auto_investigate_issues_enabled" boolean DEFAULT false NOT NULL,
	"investigation_provider" text DEFAULT 'anthropic' NOT NULL,
	"max_runtime_minutes" integer DEFAULT 90 NOT NULL,
	"max_human_resume_count" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "normalized_frames" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "last_sample" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incident_issues" ADD CONSTRAINT "incident_issues_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incident_issues" ADD CONSTRAINT "incident_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incidents" ADD CONSTRAINT "incidents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigation_events" ADD CONSTRAINT "investigation_events_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investigations" ADD CONSTRAINT "investigations_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_automation_settings" ADD CONSTRAINT "project_automation_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "incident_issues_issue_idx" ON "incident_issues" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incident_issues_incident_idx" ON "incident_issues" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_project_status_seen_idx" ON "incidents" USING btree ("project_id","status","last_seen");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "incidents_slack_thread_idx" ON "incidents" USING btree ("slack_channel_id","slack_thread_ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investigation_events_investigation_idx" ON "investigation_events" USING btree ("investigation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "investigation_events_provider_event_idx" ON "investigation_events" USING btree ("investigation_id","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "investigation_events_dedupe_idx" ON "investigation_events" USING btree ("investigation_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investigations_incident_idx" ON "investigations" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "investigations_provider_session_idx" ON "investigations" USING btree ("provider_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_automation_settings_project_idx" ON "project_automation_settings" USING btree ("project_id");