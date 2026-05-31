CREATE TABLE "linear_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" text NOT NULL,
  "workspace_name" text,
  "workspace_url_key" text,
  "actor_user_id" uuid,
  "actor_email" text,
  "access_token" text NOT NULL,
  "refresh_token" text,
  "access_expires_at" timestamp with time zone,
  "scope" text,
  "anthropic_vault_id" text,
  "anthropic_credential_id" text,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "linear_installations_org_id_orgs_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade,
  CONSTRAINT "linear_installations_actor_user_id_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX "linear_installations_org_idx" ON "linear_installations" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_installations_org_active_idx" ON "linear_installations" ("org_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE "org_agent_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "custom_instructions" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_agent_settings_org_id_orgs_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX "org_agent_settings_org_idx" ON "org_agent_settings" ("org_id");
