CREATE TABLE "project_topologies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"graph" jsonb,
	"enrichment" jsonb,
	"status" text DEFAULT 'idle' NOT NULL,
	"error" text,
	"generated_at" timestamp with time zone,
	"refresh_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_topologies" ADD CONSTRAINT "project_topologies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_topologies_project_idx" ON "project_topologies" USING btree ("project_id");