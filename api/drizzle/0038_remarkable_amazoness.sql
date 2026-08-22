-- Issue #44 (AS-05) — the auto_sync scheduling columns on sync_links, plus the
-- 13 scoping indexes the per-universe fingerprint aggregates read.
--
-- ===========================================================================
-- DEPLOYER NOTE: THIS MIGRATION BLOCKS WRITES ON THE LARGE TABLES.
-- Read this before deploying it to a hosted database. It is documentation
-- only — nothing about how migrations run is changed by it.
-- ===========================================================================
--
-- WHAT IT LOCKS. The 13 CREATE INDEX statements below are NOT CONCURRENT, so
-- each takes a SHARE lock on its table for the whole of that index's build.
-- SHARE allows concurrent reads and blocks every write — INSERT, UPDATE,
-- DELETE — on that table. The tables are the ones that actually grow:
--   entries, maps, map_pins, map_regions, map_routes, map_layers,
--   terrain_types, diagrams, dictionary_words, categories, issues, links,
--   share_tokens.
-- The six ALTER TABLE ... ADD COLUMN statements at the top are metadata-only
-- on PostgreSQL 11+ (all six are nullable or have a non-volatile default) and
-- are not the concern here.
--
-- HOW LONG THE LOCKS ARE HELD: until the migration COMMITS, not until each
-- statement finishes. Drizzle runs ALL pending migrations inside ONE
-- transaction (drizzle-orm pg-core dialect, migrate(): a single
-- session.transaction around the whole loop), and api/src/index.ts runs
-- migrations at boot. So the first index's SHARE lock is still held while the
-- thirteenth is building, and all 13 are released together at COMMIT. The
-- write stall therefore lasts the SUM of all 13 index builds, not the longest
-- one.
--
-- WHY THIS FILE CARRIES THE NOTE. Every earlier migration here runs through
-- the identical mechanism, and that mechanism is deliberately NOT being
-- changed — do not "fix" it in response to this note. What is new is the
-- SCOPE: 0038 is the first migration in this directory to build indexes on the
-- large content tables. On a laptop-sized database (every desktop install, and
-- most self-hosters) all 13 finish well inside a second and none of this is
-- observable. On a large hosted database it is a fleet-wide write stall.
--
-- WHAT A HOSTED DEPLOY SHOULD DO — either:
--
--   (a) Run the deploy inside a maintenance window sized for the sum of the 13
--       builds. Estimate it first, on a restored copy of production, with the
--       statements exactly as written below.
--
--   (b) Build the indexes OUT-OF-BAND ahead of the deploy, then keep this
--       migration from rebuilding them:
--         1. On the live database, run each index below one at a time as
--            CREATE INDEX CONCURRENTLY, with the same name and definition.
--            CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE (writes keep
--            working) but cannot run inside a transaction block — which is
--            exactly why it cannot be expressed in this file.
--         2. Check none came out invalid (a failed CONCURRENTLY build leaves
--            an invalid index behind):
--              SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--            Drop and rebuild any that appear.
--         3. Apply the six ALTER TABLE ... ADD COLUMN statements by hand
--            (metadata-only, instant), then record this migration as applied
--            so boot skips it:
--              INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
--              VALUES ('manual-0038', 1787377495798);
--            The migrator selects only `created_at` > the newest recorded
--            value (the hash column is written but never compared), and
--            1787377495798 is this migration's `when` in
--            drizzle/meta/_journal.json. Anything AFTER 0038 still applies
--            normally, because its `when` is larger.
--       Step 3 is required: the CREATE INDEX statements below have no
--       IF NOT EXISTS, so letting the migration run after (b)'s step 1 fails
--       on "relation already exists" — and it would fail inside the same
--       single transaction, rolling the whole boot migration back.
ALTER TABLE "sync_links" ADD COLUMN "auto_sync" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "last_synced_fingerprint" text;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "last_remote_fingerprint" text;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "next_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "paused_reason" text;--> statement-breakpoint
CREATE INDEX "categories_universe_id_idx" ON "categories" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "diagrams_universe_id_idx" ON "diagrams" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "dictionary_words_universe_id_idx" ON "dictionary_words" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "entries_universe_id_idx" ON "entries" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "issues_universe_id_idx" ON "issues" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "links_universe_id_idx" ON "links" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "map_layers_universe_id_idx" ON "map_layers" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "map_pins_map_id_idx" ON "map_pins" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "map_regions_map_id_idx" ON "map_regions" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "map_routes_map_id_idx" ON "map_routes" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "maps_universe_id_idx" ON "maps" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "share_tokens_universe_id_idx" ON "share_tokens" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "terrain_types_layer_id_idx" ON "terrain_types" USING btree ("layer_id");