ALTER TABLE "issues" ADD COLUMN "observation_last_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "observation_last_event_count" bigint;