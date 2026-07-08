CREATE TABLE "render_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"render_owner_id" text NOT NULL,
	"render_owner_name" text,
	"services" jsonb,
	"render_api_key_ciphertext" "bytea" NOT NULL,
	"render_api_key_nonce" "bytea" NOT NULL,
	"render_api_key_key_version" integer DEFAULT 1 NOT NULL,
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
ALTER TABLE "render_installations" ADD CONSTRAINT "render_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_installations" ADD CONSTRAINT "render_installations_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_installations" ADD CONSTRAINT "render_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "render_installations_project_owner_idx" ON "render_installations" USING btree ("project_id","render_owner_id");