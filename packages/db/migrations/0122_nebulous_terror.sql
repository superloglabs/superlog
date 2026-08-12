CREATE TABLE "agent_pull_request_overlap_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"base_branch" text NOT NULL,
	"changed_files" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_pull_request_overlap_claims" ADD CONSTRAINT "agent_pull_request_overlap_claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pull_request_overlap_claims" ADD CONSTRAINT "agent_pull_request_overlap_claims_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pull_request_overlap_claims" ADD CONSTRAINT "agent_pull_request_overlap_claims_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pr_overlap_claims_delivery_idx" ON "agent_pull_request_overlap_claims" USING btree ("agent_run_id","repo_full_name","base_branch");--> statement-breakpoint
CREATE INDEX "agent_pr_overlap_claims_lookup_idx" ON "agent_pull_request_overlap_claims" USING btree ("project_id","repo_full_name","base_branch","created_at");