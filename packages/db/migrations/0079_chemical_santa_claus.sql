CREATE TABLE "vercel_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"configuration_id" text NOT NULL,
	"team_id" text,
	"team_name" text,
	"access_token_ciphertext" "bytea" NOT NULL,
	"access_token_nonce" "bytea" NOT NULL,
	"access_token_key_version" integer DEFAULT 1 NOT NULL,
	"api_key_id" uuid,
	"ingest_key_ciphertext" "bytea",
	"ingest_key_nonce" "bytea",
	"ingest_key_key_version" integer,
	"drains" jsonb,
	"installed_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vercel_installations" ADD CONSTRAINT "vercel_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vercel_installations" ADD CONSTRAINT "vercel_installations_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vercel_installations" ADD CONSTRAINT "vercel_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vercel_installations_project_configuration_idx" ON "vercel_installations" USING btree ("project_id","configuration_id");