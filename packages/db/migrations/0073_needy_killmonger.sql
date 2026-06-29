CREATE TABLE "alert_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"group_key" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'firing' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"open_observed_value" double precision NOT NULL,
	"peak_observed_value" double precision NOT NULL,
	"last_observed_value" double precision NOT NULL,
	"last_firing_at" timestamp with time zone NOT NULL,
	"issue_id" uuid,
	"incident_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_episodes" ADD CONSTRAINT "alert_episodes_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_episodes" ADD CONSTRAINT "alert_episodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_episodes" ADD CONSTRAINT "alert_episodes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_episodes" ADD CONSTRAINT "alert_episodes_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_episodes_alert_started_idx" ON "alert_episodes" USING btree ("alert_id","started_at");--> statement-breakpoint
CREATE INDEX "alert_episodes_incident_idx" ON "alert_episodes" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_episodes_open_uniq" ON "alert_episodes" USING btree ("alert_id","group_key") WHERE state = 'firing';