CREATE TABLE "pr_observability_review_projects" (
	"review_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pr_observability_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint NOT NULL,
	"org_id" uuid,
	"project_id" uuid,
	"repo_id" bigint NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"summary" text,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processed_reaction_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_reaction_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_github_installation_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"observability_review_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "provider_event_id" text;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "observability_review_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_observability_review_projects" ADD CONSTRAINT "pr_observability_review_projects_review_id_pr_observability_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."pr_observability_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_observability_review_projects" ADD CONSTRAINT "pr_observability_review_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_observability_reviews" ADD CONSTRAINT "pr_observability_reviews_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_observability_reviews" ADD CONSTRAINT "pr_observability_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_github_installation_settings" ADD CONSTRAINT "project_github_installation_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_github_installation_settings" ADD CONSTRAINT "project_github_installation_settings_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_observability_review_projects_uniq" ON "pr_observability_review_projects" USING btree ("review_id","project_id");--> statement-breakpoint
CREATE INDEX "pr_observability_review_projects_project_idx" ON "pr_observability_review_projects" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_observability_reviews_head_idx" ON "pr_observability_reviews" USING btree ("repo_full_name","pr_number","head_sha");--> statement-breakpoint
CREATE INDEX "pr_observability_reviews_queued_idx" ON "pr_observability_reviews" USING btree ("created_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "pr_observability_reviews_reaction_sync_idx" ON "pr_observability_reviews" USING btree ("last_reaction_synced_at","completed_at") WHERE status = 'completed';--> statement-breakpoint
CREATE UNIQUE INDEX "project_github_installation_settings_uniq" ON "project_github_installation_settings" USING btree ("project_id","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_provider_event_idx" ON "feedback" USING btree ("provider_event_id") WHERE provider_event_id IS NOT NULL;