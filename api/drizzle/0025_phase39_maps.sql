--
-- maps: per-universe image-backed map definition. imageAssetId is nullable (SET NULL
--   on asset delete per D-03 so image swaps don't break existing pins). The API
--   requires imageAssetId at create-time (D-02); nullability is a DB-level fallback.
--
-- map_pins: entry-linked pins with normalized 0..1 coordinates (D-10). No unique
--   constraint on (map_id, entry_id) — multiple pins per entry allowed (D-11).
--   Deleting a map cascades to all its pins; deleting an entry cascades to pins
--   that link to it (the entry itself is never deleted by pin operations).
CREATE TABLE "maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"name" text NOT NULL,
	"image_asset_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maps" ADD CONSTRAINT "maps_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "maps" ADD CONSTRAINT "maps_image_asset_id_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE "map_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "map_pins" ADD CONSTRAINT "map_pins_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "maps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "map_pins" ADD CONSTRAINT "map_pins_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
