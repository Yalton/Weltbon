CREATE TABLE "share_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"universe_id" uuid NOT NULL,
	"scope" text DEFAULT 'universe' NOT NULL,
	"scope_entry_id" uuid,
	"label" text DEFAULT '' NOT NULL,
	"hash" text NOT NULL,
	"body_suffix" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_tokens_hash_unique" UNIQUE("hash"),
	CONSTRAINT "share_tokens_scope_check" CHECK ("scope" IN ('universe','entry'))
);
--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_scope_entry_id_entries_id_fk" FOREIGN KEY ("scope_entry_id") REFERENCES "entries"("id") ON DELETE cascade ON UPDATE no action;
