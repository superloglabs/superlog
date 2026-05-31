ALTER TABLE "incidents" ADD COLUMN "noise_reason" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "noise_resolved_at" timestamp with time zone;