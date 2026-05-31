CREATE TABLE IF NOT EXISTS "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"metric_name" text,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"group_by" text,
	"group_mode" text DEFAULT 'single' NOT NULL,
	"aggregation" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"window_minutes" integer DEFAULT 5 NOT NULL,
	"evaluation_interval_seconds" integer DEFAULT 60 NOT NULL,
	"created_by" uuid NOT NULL,
	"last_evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_firings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"group_key" text DEFAULT '' NOT NULL,
	"state" text NOT NULL,
	"observed_value" double precision NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"issue_id" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_firings" ADD CONSTRAINT "alert_firings_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_firings" ADD CONSTRAINT "alert_firings_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_project_idx" ON "alerts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_enabled_idx" ON "alerts" USING btree ("enabled","last_evaluated_at") WHERE enabled;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_firings_alert_group_idx" ON "alert_firings" USING btree ("alert_id","group_key","evaluated_at");
