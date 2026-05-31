ALTER TABLE "linear_installations" ADD COLUMN "reauth_required_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "reauth_reason" text;