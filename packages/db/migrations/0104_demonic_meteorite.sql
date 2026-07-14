CREATE TABLE "gcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"gcp_project_id" text NOT NULL,
	"gcp_project_number" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"topic_name" text,
	"subscription_name" text,
	"log_sink_name" text,
	"log_sink_writer_identity" text,
	"reader_service_account_email" text NOT NULL,
	"api_key_id" uuid,
	"ingest_key_ciphertext" "bytea",
	"ingest_key_nonce" "bytea",
	"ingest_key_key_version" integer,
	"last_verified_at" timestamp with time zone,
	"last_log_received_at" timestamp with time zone,
	"last_metrics_received_at" timestamp with time zone,
	"metrics_cursor" timestamp with time zone,
	"metrics_budget_month" text,
	"metrics_series_read" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gcp_connections" ADD CONSTRAINT "gcp_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gcp_connections" ADD CONSTRAINT "gcp_connections_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gcp_connections" ADD CONSTRAINT "gcp_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gcp_connections_project_idx" ON "gcp_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "gcp_connections_customer_project_idx" ON "gcp_connections" USING btree ("gcp_project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gcp_connections_active_project_customer_idx" ON "gcp_connections" USING btree ("project_id","gcp_project_id") WHERE revoked_at IS NULL;