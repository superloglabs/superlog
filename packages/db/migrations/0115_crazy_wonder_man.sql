CREATE TABLE "sentry_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sentry_installation_id" text NOT NULL,
	"organization_slug" text NOT NULL,
	"sentry_project_slug" text NOT NULL,
	"access_token_ciphertext" "bytea" NOT NULL,
	"access_token_nonce" text NOT NULL,
	"access_token_key_version" integer DEFAULT 1 NOT NULL,
	"refresh_token_ciphertext" "bytea",
	"refresh_token_nonce" text,
	"refresh_token_key_version" integer,
	"relay_token_ciphertext" "bytea" NOT NULL,
	"relay_token_nonce" text NOT NULL,
	"relay_token_key_version" integer DEFAULT 1 NOT NULL,
	"oauth_expires_at" timestamp with time zone,
	"actor_user_id" uuid,
	"reauth_required_at" timestamp with time zone,
	"reauth_reason" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sentry_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"action" text NOT NULL,
	"sentry_issue_id" text NOT NULL,
	"title" text NOT NULL,
	"culprit" text,
	"level" text,
	"first_seen" timestamp with time zone,
	"last_seen" timestamp with time zone,
	"event_count" bigint DEFAULT 1 NOT NULL,
	"issue_url" text,
	"raw_payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "sentry_webhook_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "sentry_installations" ADD CONSTRAINT "sentry_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentry_installations" ADD CONSTRAINT "sentry_installations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentry_webhook_events" ADD CONSTRAINT "sentry_webhook_events_installation_id_sentry_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."sentry_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sentry_installations_project_active_idx" ON "sentry_installations" USING btree ("project_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "sentry_installations_external_project_idx" ON "sentry_installations" USING btree ("sentry_installation_id","sentry_project_slug");--> statement-breakpoint
CREATE INDEX "sentry_webhook_events_pending_idx" ON "sentry_webhook_events" USING btree ("received_at") WHERE status = 'pending' OR (status = 'failed' AND attempt_count < 10);