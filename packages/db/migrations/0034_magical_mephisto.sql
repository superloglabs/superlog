ALTER TABLE "github_installations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "linear_installations" ADD CONSTRAINT "linear_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_installations_project_idx" ON "github_installations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linear_installations_project_idx" ON "linear_installations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slack_installations_project_idx" ON "slack_installations" USING btree ("project_id");