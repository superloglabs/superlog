CREATE TABLE "org_integrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_integrations_org_id_orgs_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX "org_integrations_org_slug_idx"
  ON "org_integrations" ("org_id", "slug");--> statement-breakpoint
CREATE INDEX "org_integrations_org_enabled_idx"
  ON "org_integrations" ("org_id") WHERE "enabled";--> statement-breakpoint

CREATE TABLE "org_integration_secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_integration_id" uuid NOT NULL,
  "secret_name" text NOT NULL,
  "ciphertext" bytea NOT NULL,
  "nonce" bytea NOT NULL,
  "key_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_integration_secrets_org_integration_id_fk"
    FOREIGN KEY ("org_integration_id") REFERENCES "org_integrations"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX "org_integration_secrets_unique_idx"
  ON "org_integration_secrets" ("org_integration_id", "secret_name");
