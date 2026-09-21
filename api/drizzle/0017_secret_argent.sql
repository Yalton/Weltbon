-- Creates the diagrams and diagram_nodes tables and adds write-through columns to links.

CREATE TABLE "diagrams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "diagram_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diagram_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diagram_nodes" ADD CONSTRAINT "diagram_nodes_diagram_id_diagrams_id_fk" FOREIGN KEY ("diagram_id") REFERENCES "diagrams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "diagram_nodes" ADD CONSTRAINT "diagram_nodes_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "diagram_nodes_unique_idx" ON "diagram_nodes" USING btree ("diagram_id","entry_id");
--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "diagram_id" uuid;
--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "line_style" text;
--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "color" text;
--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_diagram_id_diagrams_id_fk" FOREIGN KEY ("diagram_id") REFERENCES "diagrams"("id") ON DELETE set null ON UPDATE no action;
