-- Phase 45 XREF-04 (D-08): per-entry aliases array for alternate wikilink resolution names.
-- Mirrors the tags text[] pattern exactly: DEFAULT '{}' means no NULL window; every existing
-- row backfills to an empty array (no data loss, no table rewrite stall).
ALTER TABLE "entries" ADD COLUMN "aliases" text[] DEFAULT '{}' NOT NULL;
