ALTER TABLE "invitations" DROP CONSTRAINT "invitations_inviter_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "inviter_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;