CREATE TABLE "project_mcp_oauth_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"payload_ciphertext" "bytea" NOT NULL,
	"payload_nonce" "bytea" NOT NULL,
	"payload_key_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_mcp_oauth_attempts_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "project_mcp_oauth_attempts" ADD CONSTRAINT "project_mcp_oauth_attempts_server_id_project_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."project_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_mcp_oauth_attempts_server_idx" ON "project_mcp_oauth_attempts" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "project_mcp_oauth_attempts_expiry_idx" ON "project_mcp_oauth_attempts" USING btree ("expires_at");