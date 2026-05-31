ALTER TABLE "incidents" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incidents" ADD CONSTRAINT "incidents_merged_into_id_incidents_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
