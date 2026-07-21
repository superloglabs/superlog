ALTER TABLE "sentry_webhook_events" ADD COLUMN "transition" text;--> statement-breakpoint
ALTER TABLE "sentry_webhook_events" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "sentry_webhook_events" ADD CONSTRAINT "sentry_webhook_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;