-- v2 reshapes invite_codes from {code PK} to {hash + bodySuffix + audit FKs}.
-- v1 plaintext codes cannot be re-hashed (we never stored the plaintext, only the code).
-- Refuse to run when v1 rows exist so the operator notices instead of silently losing
-- bootstrap/issued codes. To accept the destruction, run:
--   TRUNCATE TABLE "invite_codes";    -- after exporting plaintext via your own audit log
-- and re-run `db:migrate`.
DO $$
BEGIN
  IF to_regclass('public.invite_codes') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "invite_codes" LIMIT 1) THEN
      RAISE EXCEPTION 'Migration 0005_invite_codes_v2 refuses to drop a non-empty invite_codes table. '
                      'v1 rows cannot be re-hashed (plaintext was never stored). '
                      'TRUNCATE the table after exporting any operator-issued plaintext codes, then re-run db:migrate.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
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
