ALTER TABLE "incidents" ADD COLUMN "slack_installation_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incidents" ADD CONSTRAINT "incidents_slack_installation_id_slack_installations_id_fk" FOREIGN KEY ("slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
