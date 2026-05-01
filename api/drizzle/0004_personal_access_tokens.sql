CREATE TABLE "personal_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"hash" text NOT NULL,
	"body_suffix" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"last_used_at" timestamptz,
	CONSTRAINT "personal_access_tokens_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
