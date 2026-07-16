CREATE TABLE "gcp_authorization_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"projects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_ciphertext" "bytea",
	"access_token_nonce" "bytea",
	"access_token_key_version" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gcp_authorization_sessions" ADD CONSTRAINT "gcp_authorization_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gcp_authorization_sessions" ADD CONSTRAINT "gcp_authorization_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gcp_authorization_sessions_project_idx" ON "gcp_authorization_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "gcp_authorization_sessions_user_idx" ON "gcp_authorization_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gcp_authorization_sessions_expiry_idx" ON "gcp_authorization_sessions" USING btree ("expires_at");