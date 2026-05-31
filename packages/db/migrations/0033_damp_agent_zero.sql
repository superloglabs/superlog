CREATE TABLE IF NOT EXISTS "signup_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"return_to" text,
	"claimed_project_id" uuid,
	"claimed_by_user_id" uuid,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_intents_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signup_intents" ADD CONSTRAINT "signup_intents_claimed_project_id_projects_id_fk" FOREIGN KEY ("claimed_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signup_intents" ADD CONSTRAINT "signup_intents_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
