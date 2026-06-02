CREATE TABLE "source_map_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"release" text NOT NULL,
	"dist" text,
	"debug_id" text,
	"bundle_file" text,
	"map_file" text NOT NULL,
	"source_map_hash" text NOT NULL,
	"source_map_bytes" integer NOT NULL,
	"content_encoding" text DEFAULT 'gzip' NOT NULL,
	"content" "bytea" NOT NULL,
	"uploaded_by_org_api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_map_artifacts" ADD CONSTRAINT "source_map_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_map_artifacts" ADD CONSTRAINT "source_map_artifacts_uploaded_by_org_api_key_id_org_api_keys_id_fk" FOREIGN KEY ("uploaded_by_org_api_key_id") REFERENCES "public"."org_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_map_artifacts_project_debug_id_idx" ON "source_map_artifacts" USING btree ("project_id","debug_id") WHERE debug_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "source_map_artifacts_project_release_idx" ON "source_map_artifacts" USING btree ("project_id","platform","release","dist");