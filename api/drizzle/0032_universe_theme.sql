-- Universe theming: nullable JSONB, null = default Observatory theme.
ALTER TABLE "universes" ADD COLUMN "theme" jsonb;
