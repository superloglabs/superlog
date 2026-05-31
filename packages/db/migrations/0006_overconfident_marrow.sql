ALTER TABLE "orgs" ADD COLUMN "clerk_org_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_clerk_org_id_unique" UNIQUE("clerk_org_id");