CREATE TABLE IF NOT EXISTS "project_github_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"github_repo_full_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_installations" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "org_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_github_repos" ADD CONSTRAINT "project_github_repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_github_repos" ADD CONSTRAINT "project_github_repos_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_github_repos_project_repo_idx" ON "project_github_repos" USING btree ("project_id","github_repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_github_repos_installation_idx" ON "project_github_repos" USING btree ("installation_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_installations_org_idx" ON "github_installations" USING btree ("org_id");