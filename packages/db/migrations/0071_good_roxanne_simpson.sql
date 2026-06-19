ALTER TABLE "users" ADD COLUMN "active_org_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "favorite_org_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "favorite_project_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_active_org_id_orgs_id_fk" FOREIGN KEY ("active_org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_favorite_org_id_orgs_id_fk" FOREIGN KEY ("favorite_org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_favorite_project_id_projects_id_fk" FOREIGN KEY ("favorite_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;