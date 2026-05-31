CREATE TABLE IF NOT EXISTS "agent_linear_ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_linear_ticket_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"summary" text,
	"actor_name" text,
	"actor_linear_id" text,
	"actor_avatar_url" text,
	"payload" jsonb,
	"provider_event_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_linear_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"investigation_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"ticket_identifier" text,
	"url" text,
	"title" text,
	"state" text,
	"state_type" text,
	"assignee_name" text,
	"assignee_linear_id" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_pr_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_pr_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"summary" text,
	"actor_login" text,
	"actor_github_id" bigint,
	"actor_avatar_url" text,
	"payload" jsonb,
	"provider_event_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"investigation_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_node_id" text,
	"url" text NOT NULL,
	"branch_name" text NOT NULL,
	"base_branch" text NOT NULL,
	"head_sha" text,
	"state" text DEFAULT 'open' NOT NULL,
	"title" text,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"merged_by_login" text,
	"merged_by_github_id" bigint,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "webhook_id" text;--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_linear_ticket_events" ADD CONSTRAINT "agent_linear_ticket_events_agent_linear_ticket_id_agent_linear_tickets_id_fk" FOREIGN KEY ("agent_linear_ticket_id") REFERENCES "public"."agent_linear_tickets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_linear_tickets" ADD CONSTRAINT "agent_linear_tickets_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_linear_tickets" ADD CONSTRAINT "agent_linear_tickets_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_linear_tickets" ADD CONSTRAINT "agent_linear_tickets_installation_id_linear_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."linear_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_pr_events" ADD CONSTRAINT "agent_pr_events_agent_pr_id_agent_pull_requests_id_fk" FOREIGN KEY ("agent_pr_id") REFERENCES "public"."agent_pull_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_pull_requests" ADD CONSTRAINT "agent_pull_requests_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_pull_requests" ADD CONSTRAINT "agent_pull_requests_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_pull_requests" ADD CONSTRAINT "agent_pull_requests_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_linear_ticket_events_ticket_idx" ON "agent_linear_ticket_events" USING btree ("agent_linear_ticket_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_linear_ticket_events_provider_event_idx" ON "agent_linear_ticket_events" USING btree ("agent_linear_ticket_id","provider_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_linear_tickets_incident_idx" ON "agent_linear_tickets" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_linear_tickets_investigation_idx" ON "agent_linear_tickets" USING btree ("investigation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_linear_tickets_workspace_ticket_idx" ON "agent_linear_tickets" USING btree ("workspace_id","ticket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_pr_events_pr_idx" ON "agent_pr_events" USING btree ("agent_pr_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_pr_events_provider_event_idx" ON "agent_pr_events" USING btree ("agent_pr_id","provider_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_pull_requests_incident_idx" ON "agent_pull_requests" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_pull_requests_investigation_idx" ON "agent_pull_requests" USING btree ("investigation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_pull_requests_repo_pr_idx" ON "agent_pull_requests" USING btree ("repo_full_name","pr_number");