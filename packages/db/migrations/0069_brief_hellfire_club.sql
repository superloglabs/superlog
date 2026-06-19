CREATE TABLE "cloud_stream_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"api_key_id" uuid NOT NULL,
	"key_ciphertext" "bytea" NOT NULL,
	"key_nonce" "bytea" NOT NULL,
	"key_key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_stream_keys" ADD CONSTRAINT "cloud_stream_keys_connection_id_cloud_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."cloud_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_stream_keys" ADD CONSTRAINT "cloud_stream_keys_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_stream_keys_connection_kind_idx" ON "cloud_stream_keys" USING btree ("connection_id","kind");