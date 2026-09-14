ALTER TABLE "linear_installations" ALTER COLUMN "access_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notion_installations" ALTER COLUMN "access_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ALTER COLUMN "bot_access_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ALTER COLUMN "secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "access_token_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "access_token_nonce" "bytea";--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "access_token_key_version" integer;--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "refresh_token_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "refresh_token_nonce" "bytea";--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "refresh_token_key_version" integer;--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "webhook_secret_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "webhook_secret_nonce" "bytea";--> statement-breakpoint
ALTER TABLE "linear_installations" ADD COLUMN "webhook_secret_key_version" integer;--> statement-breakpoint
ALTER TABLE "notion_installations" ADD COLUMN "access_token_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "notion_installations" ADD COLUMN "access_token_nonce" "bytea";--> statement-breakpoint
ALTER TABLE "notion_installations" ADD COLUMN "access_token_key_version" integer;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "bot_access_token_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "bot_access_token_nonce" "bytea";--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "bot_access_token_key_version" integer;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "secret_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "secret_nonce" "bytea";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "secret_key_version" integer;