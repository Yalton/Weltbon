-- Phase 36 DATA-02: universe-scoped typed field registry.
-- Split from 9b82f27:0014_phase29_structured_data (which bundled three changes);
-- the trigram-extension step is intentionally DROPPED (D-04 — reconciled scope is exact-match chips only, no fuzzy search).
-- DEFAULT is the array literal '[]' (a FieldRegistryEntry[]), unlike Phase 35's link_types Record DEFAULT '{}'.
-- DEFAULT means no table rewrite stalls on existing rows; every existing universe backfills to [].
ALTER TABLE "universes" ADD COLUMN "field_registry" jsonb DEFAULT '[]' NOT NULL;
