CREATE TABLE "agent_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"author_slack_user_id" text,
	"text" text NOT NULL,
	"slack_message_ts" text,
	"dedupe_key" text NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slack_installation_id" uuid,
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"slack_thread_ts" text,
	"created_by_slack_user_id" text,
	"title" text,
	"runtime" text DEFAULT 'community' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"provider_session_id" text,
	"provider_session_status" text,
	"failure_reason" text,
	"cumulative_active_seconds" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_automation_settings" ADD COLUMN "chat_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "is_default_chat_project" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_chat_messages" ADD CONSTRAINT "agent_chat_messages_chat_id_agent_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."agent_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chats" ADD CONSTRAINT "agent_chats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chats" ADD CONSTRAINT "agent_chats_slack_installation_id_slack_installations_id_fk" FOREIGN KEY ("slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chat_messages_dedupe_idx" ON "agent_chat_messages" USING btree ("chat_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "agent_chat_messages_pending_idx" ON "agent_chat_messages" USING btree ("chat_id","created_at") WHERE processed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chats_thread_idx" ON "agent_chats" USING btree ("slack_channel_id","slack_thread_ts") WHERE slack_thread_ts IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chats_dm_channel_idx" ON "agent_chats" USING btree ("slack_channel_id") WHERE slack_thread_ts IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chats_provider_session_idx" ON "agent_chats" USING btree ("provider_session_id");--> statement-breakpoint
CREATE INDEX "agent_chats_state_idx" ON "agent_chats" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_installations_default_chat_idx" ON "slack_installations" USING btree ("team_id") WHERE is_default_chat_project;