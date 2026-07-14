ALTER TABLE "org_agent_settings" ADD COLUMN "digest_run_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "digest_enabled" boolean;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "digest_slack_installation_id" uuid;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "digest_slack_channel_id" text;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "digest_slack_channel_name" text;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "digest_last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "digest_run_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD CONSTRAINT "project_automation_settings_digest_slack_installation_id_slack_installations_id_fk" FOREIGN KEY ("digest_slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE set null ON UPDATE no action;