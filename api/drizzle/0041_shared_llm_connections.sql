CREATE TABLE "llm_shared_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "recipient_user_id" uuid NOT NULL,
  "owner_key_id" uuid,
  "provider" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid,
  "revoked_reason" text,
  CONSTRAINT "llm_shared_grants_provider_check" CHECK ("provider" IN ('anthropic', 'openai')),
  CONSTRAINT "llm_shared_grants_active_owner_key_check" CHECK ("owner_key_id" IS NOT NULL OR "revoked_at" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "llm_api_keys_id_user_id_provider_unique" ON "llm_api_keys" ("id", "user_id", "provider");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_shared_grants_id_owner_unique" ON "llm_shared_grants" ("id", "owner_user_id");--> statement-breakpoint
ALTER TABLE "llm_shared_grants" ADD CONSTRAINT "llm_shared_grants_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_shared_grants" ADD CONSTRAINT "llm_shared_grants_recipient_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The two owner-key foreign keys below are ONE mechanism, and it depends on a
-- default nobody writes down: MATCH SIMPLE.
--
-- The single-column FK is ON DELETE SET NULL, so deleting the administrator's
-- llm_api_keys row nulls owner_key_id here rather than deleting the grant --
-- the grant must survive as an audit record of who was given access.
--
-- The composite FK (owner_key_id, owner_user_id, provider) is what actually
-- enforces the invariant that matters: a grant may only ever point at a key
-- that belongs to ITS owner and is for ITS provider. Nothing may repoint a
-- grant at some other administrator's key by updating one column.
--
-- Those two look contradictory: SET NULL writes NULL into a column that is
-- part of a composite FK whose other two columns are still NOT NULL, which
-- under MATCH FULL would be rejected outright and would make the delete fail.
-- Postgres defaults to MATCH SIMPLE, where a composite foreign key with ANY
-- null column is satisfied vacuously -- so the moment owner_key_id becomes
-- NULL the composite constraint stops applying, and the SET NULL succeeds.
-- That is deliberate, not a lucky accident, and it is the whole reason the
-- pair can coexist.
--
-- llm_shared_grants_active_owner_key_check ("owner_key_id" IS NOT NULL OR
-- "revoked_at" IS NOT NULL) is the other half: it makes the vacuous window
-- unreachable for an ACTIVE grant. A grant whose key was deleted must already
-- be revoked, so a row can never sit active with a null owner_key_id and no
-- composite constraint holding it to its owner. Application code
-- (revokeSharedGrantsForOwnerKey) does the revocation; this check is what
-- makes forgetting to impossible rather than merely unlikely.
--
-- If anyone ever adds MATCH FULL to the composite FK, or drops the active-key
-- check, the other one silently becomes load-bearing in a way it was never
-- designed to be. Change them together or not at all.
ALTER TABLE "llm_shared_grants" ADD CONSTRAINT "llm_shared_grants_owner_key_fk" FOREIGN KEY ("owner_key_id") REFERENCES "llm_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_shared_grants" ADD CONSTRAINT "llm_shared_grants_owner_key_owner_provider_fk" FOREIGN KEY ("owner_key_id", "owner_user_id", "provider") REFERENCES "llm_api_keys"("id", "user_id", "provider") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_shared_grants" ADD CONSTRAINT "llm_shared_grants_revoked_by_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_shared_grants_recipient_provider_active_unique" ON "llm_shared_grants" ("recipient_user_id", "provider") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "llm_shared_grants_owner_provider_idx" ON "llm_shared_grants" ("owner_user_id", "provider", "revoked_at");--> statement-breakpoint
CREATE INDEX "llm_shared_grants_recipient_idx" ON "llm_shared_grants" ("recipient_user_id", "revoked_at");--> statement-breakpoint

CREATE TABLE "llm_shared_consents" (
  "grant_id" uuid PRIMARY KEY NOT NULL,
  "recipient_user_id" uuid NOT NULL,
  "policy_version" text NOT NULL,
  "consented_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "llm_shared_grants_id_recipient_unique" ON "llm_shared_grants" ("id", "recipient_user_id");--> statement-breakpoint
ALTER TABLE "llm_shared_consents" ADD CONSTRAINT "llm_shared_consents_grant_fk" FOREIGN KEY ("grant_id", "recipient_user_id") REFERENCES "llm_shared_grants"("id", "recipient_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_shared_consents" ADD CONSTRAINT "llm_shared_consents_recipient_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "llm_shared_usage" (
  "recipient_user_id" uuid NOT NULL,
  "month_start" date NOT NULL,
  "reserved_cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
  "settled_cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
  "active_audit_count" integer DEFAULT 0 NOT NULL,
  "completed_audit_count" integer DEFAULT 0 NOT NULL,
  "failed_audit_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "llm_shared_usage_recipient_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "llm_shared_usage_reserved_nonnegative" CHECK ("reserved_cost_usd" >= 0),
  CONSTRAINT "llm_shared_usage_settled_nonnegative" CHECK ("settled_cost_usd" >= 0),
  CONSTRAINT "llm_shared_usage_active_nonnegative" CHECK ("active_audit_count" >= 0),
  CONSTRAINT "llm_shared_usage_completed_nonnegative" CHECK ("completed_audit_count" >= 0),
  CONSTRAINT "llm_shared_usage_failed_nonnegative" CHECK ("failed_audit_count" >= 0),
  CONSTRAINT "llm_shared_usage_month_start_first_day" CHECK ("month_start" = date_trunc('month', "month_start"::timestamp)::date),
  PRIMARY KEY ("recipient_user_id", "month_start")
);--> statement-breakpoint

ALTER TABLE "audit_runs" ADD COLUMN "credential_source" text DEFAULT 'own' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD COLUMN "credential_owner_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD COLUMN "shared_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_credential_source_check" CHECK ("credential_source" IN ('own', 'shared'));--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_shared_provenance_check" CHECK ("credential_source" = 'own' OR (("credential_owner_id" IS NOT NULL AND "shared_grant_id" IS NOT NULL) OR ("credential_owner_id" IS NULL AND "shared_grant_id" IS NULL)));--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_shared_provenance_fk" FOREIGN KEY ("shared_grant_id", "credential_owner_id") REFERENCES "llm_shared_grants"("id", "owner_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_runs_shared_recipient_active_unique" ON "audit_runs" ("user_id") WHERE "credential_source" = 'shared' AND "status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "audit_runs_shared_user_started_idx" ON "audit_runs" ("user_id", "started_at") WHERE "credential_source" = 'shared';--> statement-breakpoint

CREATE TABLE "llm_shared_audit_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "audit_run_id" uuid NOT NULL,
  "grant_id" uuid,
  "recipient_user_id" uuid NOT NULL,
  "month_start" date NOT NULL,
  "reserved_cost_usd" numeric(12,6) NOT NULL,
  "settled_cost_usd" numeric(12,6) DEFAULT '0' NOT NULL,
  "state" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  CONSTRAINT "llm_shared_reservations_audit_run_unique" UNIQUE ("audit_run_id"),
  CONSTRAINT "llm_shared_reservations_state_check" CHECK ("state" IN ('reserved', 'settled', 'released')),
  CONSTRAINT "llm_shared_reservations_reserved_nonnegative" CHECK ("reserved_cost_usd" > 0),
  CONSTRAINT "llm_shared_reservations_settled_nonnegative" CHECK ("settled_cost_usd" >= 0),
  CONSTRAINT "llm_shared_reservations_month_start_first_day" CHECK ("month_start" = date_trunc('month', "month_start"::timestamp)::date)
);--> statement-breakpoint
ALTER TABLE "llm_shared_audit_reservations" ADD CONSTRAINT "llm_shared_reservations_audit_run_fk" FOREIGN KEY ("audit_run_id") REFERENCES "audit_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_shared_audit_reservations" ADD CONSTRAINT "llm_shared_reservations_grant_fk" FOREIGN KEY ("grant_id") REFERENCES "llm_shared_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_shared_audit_reservations" ADD CONSTRAINT "llm_shared_reservations_recipient_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_shared_reservations_recipient_month_idx" ON "llm_shared_audit_reservations" ("recipient_user_id", "month_start", "state");
