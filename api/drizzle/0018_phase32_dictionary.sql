-- Phase 32 CONLANG-01 + CONLANG-03
-- Creates the dictionary_words table with a GENERATED tsvector FTS column ('simple' for
-- word/ipa to avoid English stemming corrupting invented words, 'english' for gloss),
-- a GIN index, a scope-unique index using COALESCE sentinel for nullable language_entry_id,
-- and rolls 'language' out to all existing universes (D-08 entry-type backfill).

CREATE TABLE "dictionary_words" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"language_entry_id" uuid,
	"word" text NOT NULL,
	"ipa" text DEFAULT '' NOT NULL,
	"part_of_speech" text DEFAULT '' NOT NULL,
	"gloss" text NOT NULL,
	"etymology" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dictionary_words" ADD CONSTRAINT "dictionary_words_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dictionary_words" ADD CONSTRAINT "dictionary_words_language_entry_id_entries_id_fk" FOREIGN KEY ("language_entry_id") REFERENCES "entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dictionary_words" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple'::regconfig, coalesce(word, '')), 'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce(gloss, '')), 'B') ||
  setweight(to_tsvector('simple'::regconfig, coalesce(ipa, '')), 'C')
) STORED;
--> statement-breakpoint
CREATE INDEX "dictionary_words_search_vector_idx" ON "dictionary_words" USING GIN ("search_vector");
--> statement-breakpoint
CREATE UNIQUE INDEX "dictionary_words_scope_word_unique" ON "dictionary_words" (universe_id, COALESCE(language_entry_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(word));
--> statement-breakpoint
ALTER TABLE "universes" ALTER COLUMN "entry_types" SET DEFAULT '{"concept","entity","location","event","faction","artifact","species","culture","thread","language"}';
--> statement-breakpoint
UPDATE "universes" SET "entry_types" = array_append("entry_types", 'language') WHERE NOT ('language' = ANY("entry_types"));
