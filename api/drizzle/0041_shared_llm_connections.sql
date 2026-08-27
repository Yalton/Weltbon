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
  CONSTRAINT "llm_shared_grants_provider_check" CHECK ("provider" IN ('anthropic', 'openai'))
);
ALTER TABLE "llm_shared_grants" ADD CONSTRAINT "llm_shared_grants_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "llm_shared_grants" ADD CONSTRAINT "llm_shared_grants_recipient_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "llm_shared_grants" ADD CONSTRAINT "llm_shared_grants_owner_key_fk" FOREIGN KEY ("owner_key_id") REFERENCES "llm_api_keys"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "llm_shared_grants" ADD CONSTRAINT "llm_shared_grants_revoked_by_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "llm_shared_grants_recipient_provider_active_unique" ON "llm_shared_grants" ("recipient_user_id", "provider") WHERE "revoked_at" IS NULL;
CREATE INDEX "llm_shared_grants_owner_provider_idx" ON "llm_shared_grants" ("owner_user_id", "provider", "revoked_at");
CREATE INDEX "llm_shared_grants_recipient_idx" ON "llm_shared_grants" ("recipient_user_id", "revoked_at");

CREATE TABLE "llm_shared_consents" (
  "grant_id" uuid PRIMARY KEY NOT NULL,
  "recipient_user_id" uuid NOT NULL,
  "policy_version" text NOT NULL,
  "consented_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "llm_shared_consents" ADD CONSTRAINT "llm_shared_consents_grant_fk" FOREIGN KEY ("grant_id") REFERENCES "llm_shared_grants"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "llm_shared_consents" ADD CONSTRAINT "llm_shared_consents_recipient_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;

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
  PRIMARY KEY ("recipient_user_id", "month_start")
);

ALTER TABLE "audit_runs" ADD COLUMN "credential_source" text DEFAULT 'own' NOT NULL;
ALTER TABLE "audit_runs" ADD COLUMN "credential_owner_id" uuid;
ALTER TABLE "audit_runs" ADD COLUMN "shared_grant_id" uuid;
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_credential_source_check" CHECK ("credential_source" IN ('own', 'shared'));
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_credential_owner_fk" FOREIGN KEY ("credential_owner_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_shared_grant_fk" FOREIGN KEY ("shared_grant_id") REFERENCES "llm_shared_grants"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "audit_runs_shared_recipient_active_unique" ON "audit_runs" ("user_id") WHERE "credential_source" = 'shared' AND "status" IN ('pending', 'running');
CREATE INDEX "audit_runs_shared_user_started_idx" ON "audit_runs" ("user_id", "started_at") WHERE "credential_source" = 'shared';

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
  CONSTRAINT "llm_shared_reservations_reserved_nonnegative" CHECK ("reserved_cost_usd" >= 0),
  CONSTRAINT "llm_shared_reservations_settled_nonnegative" CHECK ("settled_cost_usd" >= 0)
);
ALTER TABLE "llm_shared_audit_reservations" ADD CONSTRAINT "llm_shared_reservations_audit_run_fk" FOREIGN KEY ("audit_run_id") REFERENCES "audit_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "llm_shared_audit_reservations" ADD CONSTRAINT "llm_shared_reservations_grant_fk" FOREIGN KEY ("grant_id") REFERENCES "llm_shared_grants"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "llm_shared_audit_reservations" ADD CONSTRAINT "llm_shared_reservations_recipient_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "llm_shared_reservations_recipient_month_idx" ON "llm_shared_audit_reservations" ("recipient_user_id", "month_start", "state");
