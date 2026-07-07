CREATE TABLE "railway_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"railway_user_id" text NOT NULL,
	"granted_projects" jsonb,
	"access_token_ciphertext" "bytea" NOT NULL,
	"access_token_nonce" "bytea" NOT NULL,
	"access_token_key_version" integer DEFAULT 1 NOT NULL,
	"refresh_token_ciphertext" "bytea",
	"refresh_token_nonce" "bytea",
	"refresh_token_key_version" integer,
	"token_expires_at" timestamp with time zone,
	"scope" text,
	"api_key_id" uuid,
	"ingest_key_ciphertext" "bytea",
	"ingest_key_nonce" "bytea",
	"ingest_key_key_version" integer,
	"log_cursor" jsonb,
	"metrics_cursor" jsonb,
	"installed_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "railway_installations" ADD CONSTRAINT "railway_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "railway_installations" ADD CONSTRAINT "railway_installations_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "railway_installations" ADD CONSTRAINT "railway_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "railway_installations_project_user_idx" ON "railway_installations" USING btree ("project_id","railway_user_id");