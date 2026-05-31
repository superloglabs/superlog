ALTER TABLE "org_agent_settings"
  ADD COLUMN "investigation_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN "pr_policy" text NOT NULL DEFAULT 'on_ready_to_pr';
