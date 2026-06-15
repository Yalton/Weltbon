-- Phase 36 DATA-03: per-entry WIP/draft flag.
-- Mirrors the entries.is_public boolean idiom (0014_phase29_entries_is_public.sql) byte-for-byte.
-- DEFAULT false means no NULL window and no table rewrite stall; every existing entry backfills to false.
ALTER TABLE "entries" ADD COLUMN "wip" boolean DEFAULT false NOT NULL;
