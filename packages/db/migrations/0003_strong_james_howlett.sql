ALTER TABLE "issues" ADD COLUMN "kind" text DEFAULT 'span' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "service" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "last_alerted_at" timestamp with time zone;