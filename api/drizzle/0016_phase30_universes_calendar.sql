-- Phase 30 CALENDAR-01: per-universe fictional calendar definition persisted as JSONB.
-- Nullable on purpose: existing rows get NULL, which means "no calendar defined"
-- and positions continue to render as raw abstract numerics everywhere
-- (CALENDAR-03 backwards-compat / opt-in). No default, no NOT NULL.
ALTER TABLE "universes" ADD COLUMN "calendar" jsonb;
