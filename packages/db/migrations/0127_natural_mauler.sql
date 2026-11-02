CREATE TABLE "org_spend_limits" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"monthly_limit_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_spend_limits" ADD CONSTRAINT "org_spend_limits_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;