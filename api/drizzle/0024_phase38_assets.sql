--
-- Creates the per-universe image asset registry with UUID primary key, stable
-- universe-scoped FK (CASCADE on universe delete), and all metadata columns.
-- Adds a nullable cover_image_id FK on entries (SET NULL on asset delete per D-12).
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"extension" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"thumb_size_bytes" integer NOT NULL,
	"alt_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "cover_image_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entries" ADD CONSTRAINT "entries_cover_image_id_assets_id_fk" FOREIGN KEY ("cover_image_id") REFERENCES "assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
