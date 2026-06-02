ALTER TABLE "source_map_artifacts" ADD COLUMN "storage_bucket" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source_map_artifacts" ADD COLUMN "storage_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source_map_artifacts" DROP COLUMN "content";