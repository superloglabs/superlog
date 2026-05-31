ALTER TABLE "issues" ADD COLUMN "silenced_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX IF EXISTS "issues_project_fingerprint_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "issues_project_fingerprint_idx" ON "issues" ("project_id","fingerprint") WHERE "silenced_at" IS NULL;
