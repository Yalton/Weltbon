CREATE TABLE "entry_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"entry_type" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"meta" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cloned_from" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_templates_user_id_entry_type_name_unique" UNIQUE("user_id","entry_type","name")
);
--> statement-breakpoint
ALTER TABLE "entry_templates" ADD CONSTRAINT "entry_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
