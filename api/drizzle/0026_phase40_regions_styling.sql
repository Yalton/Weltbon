-- Phase 40 MAPS-04/05 (D-09, D-01, D-02): map_regions table + style columns.
--
-- map_regions: polygon regions with normalized 0..1 vertex coords (D-09). entryId
--   is nullable (D-05 — standalone territory with no entry link). ON DELETE CASCADE
--   on both mapId and entryId FKs. No unique constraint — multiple regions per entry.
-- map_pins style columns: nullable color + icon (D-01, D-02).
-- maps style columns: nullable legendLabels JSON (D-03).
CREATE TABLE "map_regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"entry_id" uuid,
	"name" text DEFAULT '' NOT NULL,
	"points" text NOT NULL,
	"color" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "map_regions" ADD CONSTRAINT "map_regions_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "maps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "map_regions" ADD CONSTRAINT "map_regions_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "map_pins" ADD COLUMN "color" text;
--> statement-breakpoint
ALTER TABLE "map_pins" ADD COLUMN "icon" text;
--> statement-breakpoint
ALTER TABLE "maps" ADD COLUMN "legend_labels" text;
