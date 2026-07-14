CREATE TABLE "project_mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"auth_ciphertext" "bytea",
	"auth_nonce" "bytea",
	"auth_key_version" integer,
	"trusted_at" timestamp with time zone NOT NULL,
	"trusted_by_user_id" uuid,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_mcp_servers_auth_fields_check" CHECK ((
        auth_type = 'none'
        AND auth_ciphertext IS NULL
        AND auth_nonce IS NULL
        AND auth_key_version IS NULL
      ) OR (
        auth_type IN ('bearer', 'api_key', 'oauth')
        AND auth_ciphertext IS NOT NULL
        AND auth_nonce IS NOT NULL
        AND auth_key_version IS NOT NULL
      ))
);
--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_trusted_by_user_id_users_id_fk" FOREIGN KEY ("trusted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_mcp_servers_project_name_idx" ON "project_mcp_servers" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_mcp_servers_project_url_idx" ON "project_mcp_servers" USING btree ("project_id","url");--> statement-breakpoint
CREATE INDEX "project_mcp_servers_project_enabled_idx" ON "project_mcp_servers" USING btree ("project_id","enabled");