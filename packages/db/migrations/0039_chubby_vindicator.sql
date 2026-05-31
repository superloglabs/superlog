ALTER TABLE "github_installations" DROP CONSTRAINT "github_installations_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "linear_installations" DROP CONSTRAINT "linear_installations_org_id_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_installations" DROP CONSTRAINT "slack_installations_org_id_orgs_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "github_installations_org_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "linear_installations_org_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "slack_installations_org_idx";--> statement-breakpoint
ALTER TABLE "github_installations" DROP COLUMN IF EXISTS "org_id";--> statement-breakpoint
ALTER TABLE "linear_installations" DROP COLUMN IF EXISTS "org_id";--> statement-breakpoint
ALTER TABLE "slack_installations" DROP COLUMN IF EXISTS "org_id";