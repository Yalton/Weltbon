CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"label" text NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"severity" text DEFAULT 'minor' NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_entries" (
	"issue_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	CONSTRAINT "issue_entries_issue_id_entry_id_pk" PRIMARY KEY("issue_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "graph_positions" (
	"universe_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "graph_positions_universe_id_entry_id_pk" PRIMARY KEY("universe_id","entry_id")
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_entries" ADD CONSTRAINT "issue_entries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_entries" ADD CONSTRAINT "issue_entries_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_positions" ADD CONSTRAINT "graph_positions_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_positions" ADD CONSTRAINT "graph_positions_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
  setweight(array_to_tsvector(coalesce(tags, ARRAY[]::text[])), 'B') ||
  setweight(to_tsvector('english'::regconfig, coalesce(summary, '')), 'B') ||
  setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'C')
) STORED;--> statement-breakpoint
CREATE INDEX "entries_search_vector_idx" ON "entries" USING GIN ("search_vector");
