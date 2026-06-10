ALTER TABLE "agent_runs" ADD COLUMN "trigger" text DEFAULT 'incident' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "trigger_detail" jsonb;--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "auto_follow_up_enabled" boolean DEFAULT true NOT NULL;