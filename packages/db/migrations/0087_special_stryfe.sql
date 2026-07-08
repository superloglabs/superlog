DROP INDEX "agent_chats_thread_idx";--> statement-breakpoint
DROP INDEX "agent_chats_dm_channel_idx";--> statement-breakpoint
ALTER TABLE "agent_chats" ADD COLUMN "session_base_active_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chats_thread_idx" ON "agent_chats" USING btree ("slack_team_id","slack_channel_id","slack_thread_ts") WHERE slack_thread_ts IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_chats_dm_channel_idx" ON "agent_chats" USING btree ("slack_team_id","slack_channel_id") WHERE slack_thread_ts IS NULL;