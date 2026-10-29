CREATE TABLE "project_migrations" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"workspace_url" text NOT NULL,
	"cut_over_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_migrations" ADD CONSTRAINT "project_migrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;