DROP INDEX IF EXISTS "github_installations_project_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "github_installations_org_installation_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "linear_installations_project_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "linear_installations_org_active_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "slack_installations_project_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "slack_installations_team_idx";--> statement-breakpoint
ALTER TABLE "github_installations" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "linear_installations" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_installations_project_installation_idx" ON "github_installations" USING btree ("project_id","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linear_installations_project_active_idx" ON "linear_installations" USING btree ("project_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_installations_project_team_idx" ON "slack_installations" USING btree ("project_id","team_id");