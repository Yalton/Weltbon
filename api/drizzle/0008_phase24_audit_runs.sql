-- Phase 24 AUDIT-01/02/03: audit_runs table + issues extensions + universes extensions.
-- Hand-written migration (NOT drizzle-kit generated) because the NULLS NOT DISTINCT clause
-- on the (universe_id, gap_key) unique index is unsupported by the Drizzle schema DSL.
-- AUDIT-02 T-24-01-01: This raw-SQL UNIQUE INDEX is the load-bearing dedup mechanism that
-- makes ON CONFLICT DO NOTHING on (universe_id, gap_key) semantically correct for AI issues
-- while allowing unlimited human-authored issues (gap_key = NULL, NULLS NOT DISTINCT allows
-- multiple NULLs in a unique index).
CREATE TABLE "audit_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_entry_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10,4) DEFAULT '0' NOT NULL,
	"trigger_source" text DEFAULT 'manual' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"gap_key_collision_count" integer DEFAULT 0 NOT NULL,
	"consulted_entry_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"partial_suggestions_persisted_at" timestamp with time zone,
	"hallucinated_entry_reference_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_scope_entry_id_entries_id_fk" FOREIGN KEY ("scope_entry_id") REFERENCES "entries"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- AUDIT-02 T-24-01-02: source DEFAULT 'human' NOT NULL back-fills existing rows to 'human',
-- preserving byte-identical behavior for all existing issue creation paths.
ALTER TABLE "issues" ADD COLUMN "source" text DEFAULT 'human' NOT NULL;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "dismissed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "gap_key" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "model" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "audit_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "dismissal_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_audit_run_id_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "audit_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- AUDIT-03: audit_enabled defaults to false (opt-in per-universe, enforced server-side).
ALTER TABLE "universes" ADD COLUMN "audit_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "universes" ADD COLUMN "audit_provider" text;
--> statement-breakpoint
ALTER TABLE "universes" ADD COLUMN "audit_model" text;
--> statement-breakpoint
-- T-24-01-01: The load-bearing dedup constraint. NULLS NOT DISTINCT means multiple rows
-- with gap_key = NULL (human-authored issues) are allowed, while AI issues with the same
-- (universe_id, gap_key) pair are deduplicated. This cannot be expressed in Drizzle TS.
CREATE UNIQUE INDEX "issues_universe_gap_key_unique" ON "issues" ("universe_id", "gap_key") NULLS NOT DISTINCT;
