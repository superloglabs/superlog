CREATE TABLE "usage_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"threshold" integer NOT NULL,
	"feature" text NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_notifications" ADD CONSTRAINT "usage_notifications_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_notifications_org_period_threshold_idx" ON "usage_notifications" USING btree ("org_id","period_key","threshold");