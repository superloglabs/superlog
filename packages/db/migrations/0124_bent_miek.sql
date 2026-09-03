CREATE TABLE "supabase_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"supabase_project_ref" text NOT NULL,
	"supabase_project_name" text NOT NULL,
	"supabase_organization_slug" text NOT NULL,
	"region" text NOT NULL,
	"environment" text NOT NULL,
	"api_key_id" uuid,
	"ingest_key_ciphertext" "bytea",
	"ingest_key_nonce" "bytea",
	"ingest_key_key_version" integer,
	"last_polled_at" timestamp with time zone,
	"last_metrics_received_at" timestamp with time zone,
	"last_error" text,
	"created_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supabase_oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"supabase_user_id" text NOT NULL,
	"primary_email" text NOT NULL,
	"username" text NOT NULL,
	"access_token_ciphertext" "bytea" NOT NULL,
	"access_token_nonce" "bytea" NOT NULL,
	"access_token_key_version" integer DEFAULT 1 NOT NULL,
	"refresh_token_ciphertext" "bytea",
	"refresh_token_nonce" "bytea",
	"refresh_token_key_version" integer,
	"token_expires_at" timestamp with time zone,
	"scope" text NOT NULL,
	"installed_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supabase_connections" ADD CONSTRAINT "supabase_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supabase_connections" ADD CONSTRAINT "supabase_connections_grant_id_supabase_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."supabase_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supabase_connections" ADD CONSTRAINT "supabase_connections_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supabase_connections" ADD CONSTRAINT "supabase_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supabase_oauth_grants" ADD CONSTRAINT "supabase_oauth_grants_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supabase_oauth_grants" ADD CONSTRAINT "supabase_oauth_grants_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supabase_connections_project_ref_idx" ON "supabase_connections" USING btree ("project_id","supabase_project_ref");--> statement-breakpoint
CREATE INDEX "supabase_connections_grant_idx" ON "supabase_connections" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supabase_oauth_grants_org_user_idx" ON "supabase_oauth_grants" USING btree ("org_id","supabase_user_id");--> statement-breakpoint
CREATE INDEX "supabase_oauth_grants_org_idx" ON "supabase_oauth_grants" USING btree ("org_id");