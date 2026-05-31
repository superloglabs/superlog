DROP INDEX IF EXISTS "obs_onboarding_repos_repo_idx";--> statement-breakpoint
ALTER TABLE "obs_onboarding_repos" ADD COLUMN "service_name" text;--> statement-breakpoint
ALTER TABLE "obs_onboarding_repos" ADD COLUMN "service_path" text;--> statement-breakpoint
ALTER TABLE "obs_onboarding_repos" ADD COLUMN "assignment_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "obs_onboarding_repos_repo_service_idx" ON "obs_onboarding_repos" USING btree ("onboarding_id","github_repo_id","service_name");