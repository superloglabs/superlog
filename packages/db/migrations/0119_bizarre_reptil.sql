CREATE TABLE "sentry_authorization_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"organization_slug" text NOT NULL,
	"sentry_installation_id" text NOT NULL,
	"projects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_ciphertext" "bytea",
	"access_token_nonce" "bytea",
	"access_token_key_version" integer,
	"refresh_token_ciphertext" "bytea",
	"refresh_token_nonce" "bytea",
	"refresh_token_key_version" integer,
	"oauth_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sentry_authorization_sessions" ADD CONSTRAINT "sentry_authorization_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentry_authorization_sessions" ADD CONSTRAINT "sentry_authorization_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sentry_authorization_sessions_project_idx" ON "sentry_authorization_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sentry_authorization_sessions_user_idx" ON "sentry_authorization_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sentry_authorization_sessions_expiry_idx" ON "sentry_authorization_sessions" USING btree ("expires_at");