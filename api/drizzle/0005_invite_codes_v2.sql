DROP TABLE IF EXISTS "invite_codes";
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"label" text DEFAULT '' NOT NULL,
	"hash" text NOT NULL,
	"body_suffix" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"used_at" timestamptz,
	"revoked_at" timestamptz,
	"consumed_by_user_id" uuid,
	CONSTRAINT "invite_codes_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_consumed_by_user_id_users_id_fk" FOREIGN KEY ("consumed_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
