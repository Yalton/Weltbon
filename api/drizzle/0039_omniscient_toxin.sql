CREATE TABLE "llm_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"ciphertext" text,
	"iv" text,
	"auth_tag" text,
	"body_suffix" text,
	"encrypted_key_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_validated_at" timestamp with time zone,
	CONSTRAINT "llm_connections_user_id_provider_unique" UNIQUE("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "llm_connections" ADD CONSTRAINT "llm_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;