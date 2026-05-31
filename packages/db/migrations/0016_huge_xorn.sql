ALTER TABLE "project_automation_settings" ALTER COLUMN "auto_investigate_issues_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "custom_instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "investigation_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "linear_ticket_policy" text DEFAULT 'on_ready_to_pr' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "pr_policy" text DEFAULT 'on_ready_to_pr' NOT NULL;