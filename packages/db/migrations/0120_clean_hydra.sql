CREATE TABLE "cloud_connection_diagnostic_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"region" text NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"checks" jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_connection_diagnostic_runs" ADD CONSTRAINT "cloud_connection_diagnostic_runs_connection_id_cloud_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."cloud_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_connection_diagnostic_runs" ADD CONSTRAINT "cloud_connection_diagnostic_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_connection_diagnostic_runs" ADD CONSTRAINT "cloud_connection_diagnostic_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_connection_diagnostic_runs_connection_created_idx" ON "cloud_connection_diagnostic_runs" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "cloud_connection_diagnostic_runs_project_created_idx" ON "cloud_connection_diagnostic_runs" USING btree ("project_id","created_at");