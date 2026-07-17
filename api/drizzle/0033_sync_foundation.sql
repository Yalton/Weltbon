-- Sync Foundation (Plan A, sync spec S-03/S-10 + spike-report hardening note).
--
-- Part 1 — convert the five NAIVE updated_at columns to timestamptz.
-- USING "updated_at" AT TIME ZONE 'UTC' interprets stored naive values as UTC,
-- which matches every deployment to date (containers + PGlite driver run UTC).
-- After this, LWW comparisons and the issues D-12 freshness predicate are
-- correct under ANY session timezone, not only UTC.
ALTER TABLE "universes" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "entries" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "issues" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "graph_positions" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "dictionary_words" ALTER COLUMN "updated_at" TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';
--> statement-breakpoint
-- Part 2 — add updated_at to the synced tables that lack it (sync LWW, S-03).
-- Backfill semantics: DEFAULT now() stamps existing rows with migration time,
-- which is the honest "last known write" floor for pre-sync data.
ALTER TABLE "categories" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "timeline_pins" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "diagrams" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "diagram_nodes" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "maps" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "map_pins" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "map_regions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "map_routes" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "map_layers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "terrain_types" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
-- Part 3 — sync tables (sync spec "Data model").
CREATE TABLE "sync_remotes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "label" text DEFAULT '' NOT NULL,
  "base_url" text NOT NULL,
  "encrypted_pat" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "universe_id" uuid NOT NULL REFERENCES "universes"("id") ON DELETE CASCADE,
  "remote_id" uuid NOT NULL REFERENCES "sync_remotes"("id") ON DELETE CASCADE,
  "base_snapshot_key" text,
  "last_synced_at" timestamp with time zone,
  "status" text DEFAULT 'idle' NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sync_links_universe_remote_unique" ON "sync_links" ("universe_id","remote_id");
--> statement-breakpoint
CREATE TABLE "sync_conflicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "universe_id" uuid NOT NULL REFERENCES "universes"("id") ON DELETE CASCADE,
  "table_name" text NOT NULL,
  "row_id" uuid NOT NULL,
  "winner" text NOT NULL,
  "loser_payload" jsonb NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
