CREATE TABLE IF NOT EXISTS "project_slack_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text,
	"bot_user_id" text,
	"bot_access_token" text NOT NULL,
	"scope" text,
	"installed_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "slack_message_ts" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_slack_routes" ADD CONSTRAINT "project_slack_routes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_slack_routes" ADD CONSTRAINT "project_slack_routes_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_slack_routes_project_idx" ON "project_slack_routes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slack_installations_org_idx" ON "slack_installations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_installations_team_idx" ON "slack_installations" USING btree ("team_id");