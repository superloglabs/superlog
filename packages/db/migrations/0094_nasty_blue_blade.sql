CREATE TABLE "notion_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"bot_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"workspace_name" text,
	"workspace_icon" text,
	"access_token" text NOT NULL,
	"actor_user_id" uuid,
	"actor_email" text,
	"reauth_required_at" timestamp with time zone,
	"reauth_reason" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notion_installations" ADD CONSTRAINT "notion_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notion_installations" ADD CONSTRAINT "notion_installations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notion_installations_project_active_idx" ON "notion_installations" USING btree ("project_id") WHERE revoked_at IS NULL;