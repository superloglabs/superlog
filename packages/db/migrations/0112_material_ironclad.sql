CREATE TABLE "pr_observability_review_projects" (
	"review_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pr_observability_reviews" ADD COLUMN "repo_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_observability_review_projects" ADD CONSTRAINT "pr_observability_review_projects_review_id_pr_observability_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."pr_observability_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_observability_review_projects" ADD CONSTRAINT "pr_observability_review_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_observability_review_projects_uniq" ON "pr_observability_review_projects" USING btree ("review_id","project_id");--> statement-breakpoint
CREATE INDEX "pr_observability_review_projects_project_idx" ON "pr_observability_review_projects" USING btree ("project_id");