ALTER TABLE "org_agent_settings"
  ADD COLUMN "linear_ticket_policy" text NOT NULL DEFAULT 'on_ready_to_pr';
