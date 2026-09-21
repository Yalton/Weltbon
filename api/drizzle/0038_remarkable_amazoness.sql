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
--   (b) Build the indexes OUT-OF-BAND ahead of the deploy, then deploy
--       normally. This is the recommended path for any database large enough
--       for (a)'s window to matter.
--         1. Against the live database, run
--              scripts/0038-indexes-concurrently.sql
--            It is this file's 13 indexes, same names and definitions, as
--            CREATE INDEX CONCURRENTLY. CONCURRENTLY takes only SHARE UPDATE
--            EXCLUSIVE — writes keep working — but cannot run inside a
--            transaction block, which is exactly why it cannot live in this
--            file. Run it with psql -f, NOT wrapped in BEGIN/COMMIT, and not
--            through a tool that opens a transaction for you.
--         2. Check none came out invalid (a failed CONCURRENTLY build leaves
--            an invalid index behind):
--              SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--            Drop and rebuild any that appear.
--         3. Deploy. Nothing else to do by hand: the six ALTER TABLE
--            statements are metadata-only and instant, and each CREATE INDEX
--            below is IF NOT EXISTS, so it finds its index already there and
--            costs a catalogue lookup. No long lock, no faked migration row.
--
--       The two files MUST stay in step. api/tests/migration-0038-indexes.test.ts
--       parses both and fails if an index is added, removed, or renamed in one
--       and not the other — a mismatch would otherwise be silent until a
--       differently-named duplicate index appeared in production.
--
--       IF NOT EXISTS matches on NAME only. An index that already exists under
--       one of these names with a DIFFERENT definition is skipped rather than
--       reported. That is the accepted cost of making (b) a two-step process;
--       the sync test above is what keeps the definitions from drifting.
ALTER TABLE "sync_links" ADD COLUMN "auto_sync" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "last_synced_fingerprint" text;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "last_remote_fingerprint" text;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "next_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "paused_reason" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categories_universe_id_idx" ON "categories" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "diagrams_universe_id_idx" ON "diagrams" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dictionary_words_universe_id_idx" ON "dictionary_words" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entries_universe_id_idx" ON "entries" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_universe_id_idx" ON "issues" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "links_universe_id_idx" ON "links" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "map_layers_universe_id_idx" ON "map_layers" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "map_pins_map_id_idx" ON "map_pins" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "map_regions_map_id_idx" ON "map_regions" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "map_routes_map_id_idx" ON "map_routes" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "maps_universe_id_idx" ON "maps" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_tokens_universe_id_idx" ON "share_tokens" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "terrain_types_layer_id_idx" ON "terrain_types" USING btree ("layer_id");