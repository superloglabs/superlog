CREATE TABLE "anomaly_scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"metric_series_scanned" integer DEFAULT 0 NOT NULL,
	"findings_count" integer DEFAULT 0 NOT NULL,
	"incidents_opened" integer DEFAULT 0 NOT NULL,
	"incidents_deduped" integer DEFAULT 0 NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audit" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "org_agent_settings" ADD COLUMN "anomaly_scanner_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "anomaly_scanner_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "anomaly_scanner_cadence_hours" integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "anomaly_scanner_observation_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "anomaly_scanner_baseline_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "anomaly_scan_runs" ADD CONSTRAINT "anomaly_scan_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomaly_scan_runs" ADD CONSTRAINT "anomaly_scan_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anomaly_scan_runs_project_started_idx" ON "anomaly_scan_runs" USING btree ("project_id","started_at");