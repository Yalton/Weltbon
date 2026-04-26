CREATE TABLE "timeline_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL UNIQUE,
	"label" text NOT NULL,
	"position" double precision NOT NULL,
	"precision" text DEFAULT 'exact' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timeline_pins" ADD CONSTRAINT "timeline_pins_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE cascade ON UPDATE no action;
