ALTER TABLE "github_installations" ADD COLUMN "agent_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "repo_access" jsonb;