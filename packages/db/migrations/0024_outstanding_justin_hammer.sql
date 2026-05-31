CREATE TABLE IF NOT EXISTS "obs_onboarding_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"onboarding_id" uuid NOT NULL,
	"role" text NOT NULL,
	"summary" text,
	"detail" jsonb,
	"provider_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "obs_onboarding_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"onboarding_id" uuid NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"repo_full_name" text NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"step" text DEFAULT 'queued' NOT NULL,
	"subagent_session_id" text,
	"pr_url" text,
	"pr_number" integer,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recent_tool_calls" jsonb,
	"instrumentation_report" jsonb,
	"validation" jsonb,
	"files_changed" integer,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "obs_onboardings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"github_installation_id" uuid,
	"created_by_user_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"questionnaire" jsonb,
	"orchestrator_session_id" text,
	"ingest_api_key_id" uuid,
	"ingest_api_key_plaintext" text,
	"failure_reason" text,
	"dismissed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "obs_onboarding_messages" ADD CONSTRAINT "obs_onboarding_messages_onboarding_id_obs_onboardings_id_fk" FOREIGN KEY ("onboarding_id") REFERENCES "public"."obs_onboardings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "obs_onboarding_repos" ADD CONSTRAINT "obs_onboarding_repos_onboarding_id_obs_onboardings_id_fk" FOREIGN KEY ("onboarding_id") REFERENCES "public"."obs_onboardings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "obs_onboardings" ADD CONSTRAINT "obs_onboardings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "obs_onboardings" ADD CONSTRAINT "obs_onboardings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "obs_onboardings" ADD CONSTRAINT "obs_onboardings_github_installation_id_github_installations_id_fk" FOREIGN KEY ("github_installation_id") REFERENCES "public"."github_installations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "obs_onboardings" ADD CONSTRAINT "obs_onboardings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "obs_onboardings" ADD CONSTRAINT "obs_onboardings_ingest_api_key_id_api_keys_id_fk" FOREIGN KEY ("ingest_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obs_onboarding_messages_onboarding_idx" ON "obs_onboarding_messages" USING btree ("onboarding_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "obs_onboarding_messages_provider_event_idx" ON "obs_onboarding_messages" USING btree ("onboarding_id","provider_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obs_onboarding_repos_onboarding_idx" ON "obs_onboarding_repos" USING btree ("onboarding_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "obs_onboarding_repos_session_idx" ON "obs_onboarding_repos" USING btree ("subagent_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "obs_onboarding_repos_repo_idx" ON "obs_onboarding_repos" USING btree ("onboarding_id","github_repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obs_onboardings_org_idx" ON "obs_onboardings" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "obs_onboardings_orchestrator_session_idx" ON "obs_onboardings" USING btree ("orchestrator_session_id");