CREATE TABLE "linear_agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"agent_session_id" text NOT NULL,
	"kind" text NOT NULL,
	"issue_id" text NOT NULL,
	"issue_identifier" text,
	"issue_title" text,
	"issue_url" text,
	"incident_id" uuid,
	"agent_chat_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linear_agent_sessions_root_check" CHECK ((kind = 'chat' AND agent_chat_id IS NOT NULL AND incident_id IS NULL) OR (kind = 'incident' AND incident_id IS NOT NULL AND agent_chat_id IS NULL))
);
--> statement-breakpoint
DROP INDEX "agent_chats_thread_idx";--> statement-breakpoint
DROP INDEX "agent_chats_dm_channel_idx";--> statement-breakpoint
ALTER TABLE "agent_chats" ALTER COLUMN "slack_team_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_chats" ALTER COLUMN "slack_channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_chat_messages" ADD COLUMN "author_linear_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_chat_messages" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "agent_chats" ADD COLUMN "provider" text DEFAULT 'slack' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_chats" ADD COLUMN "created_by_linear_user_id" text;--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "app_user_id" text;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD CONSTRAINT "linear_agent_sessions_installation_id_linear_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."linear_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD CONSTRAINT "linear_agent_sessions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_agent_sessions" ADD CONSTRAINT "linear_agent_sessions_agent_chat_id_agent_chats_id_fk" FOREIGN KEY ("agent_chat_id") REFERENCES "public"."agent_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_agent_sessions_install_session_idx" ON "linear_agent_sessions" USING btree ("installation_id","agent_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_agent_sessions_incident_idx" ON "linear_agent_sessions" USING btree ("incident_id") WHERE incident_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_agent_sessions_chat_idx" ON "linear_agent_sessions" USING btree ("agent_chat_id") WHERE agent_chat_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chats_thread_idx" ON "agent_chats" USING btree ("slack_team_id","slack_channel_id","slack_thread_ts") WHERE provider = 'slack' AND slack_thread_ts IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chats_dm_channel_idx" ON "agent_chats" USING btree ("slack_team_id","slack_channel_id") WHERE provider = 'slack' AND slack_thread_ts IS NULL;