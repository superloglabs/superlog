ALTER TABLE "incidents" ADD COLUMN "codename" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "severity" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "incidents_project_codename_idx" ON "incidents" USING btree ("project_id","codename") WHERE codename <> '';