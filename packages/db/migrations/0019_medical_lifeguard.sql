ALTER TABLE "github_installations" ADD COLUMN "commit_author_name" text;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "commit_author_email" text;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "commit_author_github_login" text;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "commit_author_github_id" bigint;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "commit_author_avatar_url" text;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "commit_author_set_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "commit_author_set_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_commit_author_set_by_user_id_users_id_fk" FOREIGN KEY ("commit_author_set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
