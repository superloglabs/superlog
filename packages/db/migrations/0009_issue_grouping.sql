ALTER TABLE "issues" ADD COLUMN "grouping_state" text NOT NULL DEFAULT 'grouped';--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "grouping_source" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "grouping_reason" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "grouping_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "grouping_attempt_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE "issues" SET "grouping_source" = 'heuristic' WHERE "grouping_source" IS NULL;--> statement-breakpoint
CREATE INDEX "issues_grouping_state_idx" ON "issues" ("project_id", "grouping_state") WHERE "grouping_state" IN ('pending', 'failed');
