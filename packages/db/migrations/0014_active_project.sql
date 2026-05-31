ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "active_project_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_active_project_id_projects_id_fk" FOREIGN KEY ("active_project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
