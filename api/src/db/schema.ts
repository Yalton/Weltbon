import { pgTable, uuid, text, timestamp, jsonb, boolean, integer, doublePrecision, primaryKey, unique, numeric, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/**
 * Phase 20 D-01: per-universe horizontal timeline window persisted as JSONB
 * on `universes.timeline_window`. `null` (the default for any pre-Phase-20
 * row) triggers the first-visit "Configure range" dialog (D-02).
 */
export interface TimelineWindow {
  start: number;
  end: number;
}

/**
 * Phase 30 CALENDAR-01: per-universe fictional calendar definition persisted as
 * JSONB on `universes.calendar`. `null` (the default for existing rows) means
 * "no calendar defined" — positions render as raw abstract numerics everywhere
 * (CALENDAR-03 backwards-compat). Non-null value unlocks the position→date
 * renderer (`formatCalendar`) for all display surfaces.
 */
export interface CalendarEra {
  name: string;
  abbr: string;
  /** Absolute day-number position where this era begins (D-05). */
  startPosition: number;
}

export interface CalendarMonth {
  name: string;
  /** Fixed number of days in this month (no leap years in v1, D-04). */
  lengthDays: number;
}

export interface CalendarMoon {
  name: string;
  /** Orbital cycle in days; moon phase = dayIndex mod cycleDays (D-04). */
  cycleDays: number;
}

export interface Calendar {
  /** Ordered list of eras; must have >= 1 entry. startPosition values must be strictly increasing. */
  eras: CalendarEra[];
  /** Ordered list of months in a year; must have >= 1 entry. */
  months: CalendarMonth[];
  /** Optional weekday names in cycle order; empty = no weekday display. */
  weekdays: string[];
  /** Optional moons; empty = no moon-phase display. */
  moons: CalendarMoon[];
  /** Abbreviation for pre-epoch dates (e.g. "BE" for "Before Era"). Used as the era-abbr for positions before the earliest era's startPosition (D-08). */
  beforeEraAbbr: string;
}

export const users = pgTable('users', {
  id:               uuid('id').primaryKey().defaultRandom(),
  email:            text('email').notNull().unique(),
  displayName:      text('display_name').notNull(),
  passwordHash:     text('password_hash').notNull(),
  createdAt:        timestamp('created_at').defaultNow().notNull(),
  // Phase 22 D-07: nullable timestamptz; set to NOW() on first "I accept" click
  // in /settings/llm consent block. Persists forever (revoking keys does NOT clear).
  llmConsentedAt:   timestamp('llm_consented_at', { withTimezone: true }),
});

export const universes = pgTable('universes', {
  id:           uuid('id').primaryKey().defaultRandom(),
  userId:       uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name:         text('name').notNull(),
  description:  text('description').default('').notNull(),
  entryTypes:   text('entry_types').array().default([
    'concept','entity','location','event','faction',
    'artifact','species','culture','thread'
  ]).notNull(),
  // Phase 20 D-01: nullable JSONB; `null` = "first visit, configure range".
  timelineWindow: jsonb('timeline_window').$type<TimelineWindow | null>(),
  // Phase 30 CALENDAR-01: nullable JSONB; `null` = "no calendar" → raw numeric
  // fallback everywhere (CALENDAR-03 backwards-compat). Non-null unlocks the
  // formatCalendar renderer for all position-display surfaces.
  calendar: jsonb('calendar').$type<Calendar | null>(),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
  // Phase 24 AUDIT-03: per-universe LLM audit opt-in (default OFF).
  // audit_provider and audit_model are nullable until the user enables auditing.
  auditEnabled: boolean('audit_enabled').default(false).notNull(),
  auditProvider: text('audit_provider'),
  auditModel: text('audit_model'),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash:  text('token_hash').notNull(),
  expiresAt:  timestamp('expires_at').notNull(),
  revokedAt:  timestamp('revoked_at'),
  createdAt:  timestamp('created_at').defaultNow().notNull(),
});

export const personalAccessTokens = pgTable('personal_access_tokens', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  label:      text('label').default('').notNull(),
  hash:       text('hash').notNull().unique(),
  bodySuffix: text('body_suffix').notNull(),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

/**
 * Phase 22 BYOK: per-user, per-provider LLM API key storage with AES-256-GCM at-rest.
 *
 * - `ciphertext`, `iv` (12 bytes → 24 hex chars), `auth_tag` (16 bytes → 32 hex chars) are
 *   the AES-256-GCM outputs stored as hex strings.
 * - `encrypted_key_version` defaults to 1 (D-12); rotation tooling is NOT shipped in v3.0,
 *   but the column ships from day one so future rotation needs no schema migration.
 * - `body_suffix` (last 4 chars of plaintext) is computed at INSERT time (D-14) — same
 *   pattern as personalAccessTokens.bodySuffix. Never derived from ciphertext at read time.
 * - `label` is optional (D-13): UI falls back to provider name when empty.
 * - UNIQUE(user_id, provider) enforces one row per (user, provider) pair (D-14). Replace
 *   semantics handled at the route layer via UPDATE or INSERT ON CONFLICT.
 */
export const llmApiKeys = pgTable('llm_api_keys', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  userId:               uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  provider:             text('provider').notNull(),
  ciphertext:           text('ciphertext').notNull(),
  iv:                   text('iv').notNull(),
  authTag:              text('auth_tag').notNull(),
  encryptedKeyVersion:  integer('encrypted_key_version').default(1).notNull(),
  bodySuffix:           text('body_suffix').notNull(),
  label:                text('label').default('').notNull(),
  createdAt:            timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastValidatedAt:      timestamp('last_validated_at', { withTimezone: true }),
}, (t) => ({
  userProviderUnique: unique('llm_api_keys_user_id_provider_unique').on(t.userId, t.provider),
}));

export const inviteCodes = pgTable('invite_codes', {
  id:                uuid('id').primaryKey().defaultRandom(),
  ownerId:           uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
  label:             text('label').default('').notNull(),
  hash:              text('hash').notNull().unique(),
  bodySuffix:        text('body_suffix').notNull(),
  createdAt:         timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  usedAt:            timestamp('used_at', { withTimezone: true }),
  revokedAt:         timestamp('revoked_at', { withTimezone: true }),
  consumedByUserId:  uuid('consumed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

export const inviteCodesRelations = relations(inviteCodes, ({ one }) => ({
  owner:       one(users, { fields: [inviteCodes.ownerId], references: [users.id], relationName: 'invite_owner' }),
  consumedBy:  one(users, { fields: [inviteCodes.consumedByUserId], references: [users.id], relationName: 'invite_consumer' }),
}));

/**
 * Phase 29 D-15: Per-(user, universe) share-token credentials for unauthenticated
 * read-only /share/:token routes. Combines personalAccessTokens (hash/body_suffix/
 * lastUsedAt pattern) + inviteCodes (revokedAt soft-delete) + per-token expiry +
 * access tracking + scope columns.
 *
 * - `scope` ships ready for v3.3 single-entry sharing (CHECK constraint in raw SQL
 *   migration restricts to 'universe' | 'entry'); the v1 router rejects scope !== 'universe'.
 * - `scopeEntryId` is nullable and FK-cascades on entries; left as a plain FK (no
 *   Drizzle relation declaration) until v3.3 single-entry-scope work surfaces a
 *   `with: { scopeEntry }` use case.
 * - `hash` is SHA-256 hex of the `wbn_share_<base64url(32)>` token string — D-08 hash-only at rest.
 *   The UNIQUE constraint name `share_tokens_hash_unique` is load-bearing for the
 *   23505 collision catch in Plan 02 routes/shares.ts.
 * - `bodySuffix` is the last 4 chars of the body (UI-SPEC §D 4-char `••••••ABCD` mask;
 *   deliberate divergence from PAT's 3-char suffix).
 * - `lastAccessedAt` + `accessCount` are fire-and-forget telemetry written on every
 *   /api/share/* hit by recordShareAccess (D-09; T-29-06).
 */
export const shareTokens = pgTable('share_tokens', {
  id:             uuid('id').primaryKey().defaultRandom(),
  userId:         uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  universeId:     uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  scope:          text('scope').default('universe').notNull(),
  scopeEntryId:   uuid('scope_entry_id').references(() => entries.id, { onDelete: 'cascade' }),
  label:          text('label').default('').notNull(),
  hash:           text('hash').notNull().unique(),
  bodySuffix:     text('body_suffix').notNull(),
  expiresAt:      timestamp('expires_at', { withTimezone: true }),
  revokedAt:      timestamp('revoked_at', { withTimezone: true }),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  accessCount:    integer('access_count').default(0).notNull(),
  createdAt:      timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const shareTokensRelations = relations(shareTokens, ({ one }) => ({
  user:     one(users, { fields: [shareTokens.userId], references: [users.id], relationName: 'share_owner' }),
  universe: one(universes, { fields: [shareTokens.universeId], references: [universes.id], relationName: 'share_universe' }),
}));

/**
 * Phase 28 TEMPLATES-01/03: Per-user entry templates.
 *
 * - Templates are user-scoped (no universe_id per D-05); they travel with the author
 *   across all universes.
 * - `meta` stores an ordered array of `{name, default_value}` blueprint fields as JSONB
 *   (D-09 — array shape, NOT Record). Contrast with `entries.meta` which is `{}` (Record shape).
 * - `cloned_from` is a nullable text field (NOT a FK) referencing an in-tree default
 *   template id string (D-02). Enables future "reset to default" without a schema change.
 * - `last_used_at` is stamped when the template scaffolds a real entry create (D-16).
 * - UNIQUE(user_id, entry_type, name) enforces per-user, per-type name uniqueness (D-04).
 *   The constraint name `entry_templates_user_id_entry_type_name_unique` is load-bearing
 *   for the 23505 catch in the /templates router.
 * - No per-user hide list column per D-03 — defaults always render in the picker.
 */
export const entryTemplates = pgTable('entry_templates', {
  id:          uuid('id').primaryKey().defaultRandom(),
  userId:      uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name:        text('name').notNull(),
  entryType:   text('entry_type').notNull(),
  summary:     text('summary').default('').notNull(),
  body:        text('body').default('').notNull(),
  meta:        jsonb('meta').default([]).notNull(),     // D-09 — ordered array [{name, default_value}]
  clonedFrom:  text('cloned_from'),                     // D-02 — nullable; references in-tree default id string (NOT a FK)
  lastUsedAt:  timestamp('last_used_at', { withTimezone: true }),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userTypeNameUnique: unique('entry_templates_user_id_entry_type_name_unique').on(t.userId, t.entryType, t.name),  // D-04
}));

export const categories = pgTable('categories', {
  id:         uuid('id').primaryKey().defaultRandom(),
  universeId: uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  label:      text('label').notNull(),
  icon:       text('icon').default('').notNull(),
  sortOrder:  integer('sort_order').default(0).notNull(),
  createdAt:  timestamp('created_at').defaultNow().notNull(),
});

export const entries = pgTable('entries', {
  id:           uuid('id').primaryKey().defaultRandom(),
  universeId:   uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  title:        text('title').notNull(),
  entryType:    text('entry_type').notNull(),
  summary:      text('summary').default('').notNull(),
  body:         text('body').default('').notNull(),
  tags:         text('tags').array().default([]).notNull(),
  meta:         jsonb('meta').default({}).notNull(),
  icon:         text('icon').default('').notNull(),
  searchVector: text('search_vector'),
  categoryId:   uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
  // Phase 29 D-10: per-entry public flag for share-link visibility (default OFF).
  // Backfilled to false for every existing row by 0014_phase29_entries_is_public.sql.
  // Mirrors universes.auditEnabled (line ~40) pattern: boolean opt-in with safer-by-default.
  isPublic: boolean('is_public').default(false).notNull(),
});

export const links = pgTable('links', {
  id:            uuid('id').primaryKey().defaultRandom(),
  universeId:    uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  sourceEntryId: uuid('source_entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  targetEntryId: uuid('target_entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  label:         text('label').notNull(),
  bidirectional: boolean('bidirectional').default(false).notNull(),
  createdAt:     timestamp('created_at').defaultNow().notNull(),
});

/**
 * Phase 24 AUDIT-01: Per-run audit telemetry table.
 *
 * Tracks every audit run to completion. Includes AUDIT-01 columns for
 * observability (user_id, trigger_source, started_at, finished_at) plus
 * engine-owned columns from CONTEXT D-11 (gap_key_collision_count),
 * D-15 (consulted_entry_ids), and D-01 (partial_suggestions_persisted_at),
 * and AUDIT-09 (hallucinated_entry_reference_count).
 *
 * Note: The (universe_id, gap_key) UNIQUE NULLS NOT DISTINCT constraint on
 * the `issues` table lives in the raw SQL migration only — Drizzle TS has no
 * nullsNotDistinct support on unique(). The DB enforces the constraint.
 */
export const auditRuns = pgTable('audit_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  universeId: uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  scope: text('scope').notNull(), // 'universe' | 'entry'
  scopeEntryId: uuid('scope_entry_id').references(() => entries.id, { onDelete: 'set null' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  status: text('status').default('pending').notNull(), // 'pending' | 'running' | 'succeeded' | 'failed'
  promptTokens: integer('prompt_tokens').default(0).notNull(),
  completionTokens: integer('completion_tokens').default(0).notNull(),
  cachedTokens: integer('cached_tokens').default(0).notNull(),
  toolCallCount: integer('tool_call_count').default(0).notNull(),
  // AUDIT-01 day-one for SWEEP-04: cost_usd as NUMERIC(10,4) to support future per-user cap aggregation.
  costUsd: numeric('cost_usd', { precision: 10, scale: 4 }).default('0').notNull(),
  // AUDIT-01 day-one for SWEEP-01: trigger_source enables future background-sweep runs.
  triggerSource: text('trigger_source').default('manual').notNull(),
  // Engine taxonomy string only — never raw err.message (T-24-01-04 accepted risk).
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  // CONTEXT D-11: observability counter for ON CONFLICT DO NOTHING collisions on (universe_id, gap_key).
  gapKeyCollisionCount: integer('gap_key_collision_count').default(0).notNull(),
  // CONTEXT D-15: all entry IDs the engine called getEntryBody on during this run.
  // Per-run granularity (not per-suggestion); cheap-finds runs get an empty array (correct).
  consultedEntryIds: uuid('consulted_entry_ids').array().default(sql`'{}'::uuid[]`).notNull(),
  // CONTEXT D-01: set on first stream-persist within a run; null until then.
  partialSuggestionsPersistedAt: timestamp('partial_suggestions_persisted_at', { withTimezone: true }),
  // AUDIT-09: engine increments on each suggestion dropped due to unknown referenced_entry_id.
  // Load-bearing observability column; Plan 04 atomically increments this on every drop.
  hallucinatedEntryReferenceCount: integer('hallucinated_entry_reference_count').default(0).notNull(),
  // AUDIT-07 / Phase 26 D-08: count of universe entries the engine actually examined
  // during this run. The completion banner surfaces a "Partial coverage" warning chip
  // when analyzed_entries < 0.5 × universe total_entries (provider safety filters,
  // budget caps, or early-termination signal). DEFAULT 0 backfills pre-Phase-26 rows
  // (they report zero analyzed entries — a known historical gap, not a regression).
  analyzedEntries: integer('analyzed_entries').default(0).notNull(),
  // Phase 27 D-06: set TRUE by the engine when the selected model is not in PRICING
  // (newly-released live-list model the dropdown surfaced via the D-05 unpriced UX path).
  // When TRUE, cost_usd is persisted as 0 (keeps SUM math safe) and surfaces in the UI as
  // a "cost unknown" amber chip on AuditCompletionBanner + AuditHistoryTable, and is
  // excluded from llm-keys totalSpent SUM (with parallel COUNT footnote). DEFAULT false
  // backfills every pre-Phase-27 row at metadata-only ALTER speed (PostgreSQL 11+).
  costUnknown: boolean('cost_unknown').default(false).notNull(),
}, (t) => ({
  // BL-01: partial unique index closing the TOCTOU race window in routes/audits.ts
  // between the pre-check SELECT and INSERT. Without this index, two concurrent POSTs
  // for the same universe can both create pending rows. The 23505 catch at audits.ts:269
  // depends on this index firing on race. The raw migration is the source of truth;
  // this declaration keeps schema↔migration parity for future drizzle-kit generate runs.
  universeActiveUnique: uniqueIndex('audit_runs_universe_active_unique')
    .on(t.universeId)
    .where(sql`status IN ('pending', 'running')`),
}));

export const issues = pgTable('issues', {
  id:          uuid('id').primaryKey().defaultRandom(),
  universeId:  uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  title:       text('title').notNull(),
  description: text('description').default('').notNull(),
  severity:    text('severity').default('minor').notNull(),
  resolved:    boolean('resolved').default(false).notNull(),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
  updatedAt:   timestamp('updated_at').defaultNow().notNull(),
  // Phase 24 AUDIT-02: additive columns for AI-sourced issues.
  // Existing creation paths remain byte-identical: source defaults to 'human',
  // all other new columns are nullable, preserving the existing row shape for human inserts.
  source: text('source').default('human').notNull(),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  gapKey: text('gap_key'),
  model: text('model'),
  auditRunId: uuid('audit_run_id').references(() => auditRuns.id, { onDelete: 'set null' }),
  dismissalSnapshot: jsonb('dismissal_snapshot'),
  // Note: The (universe_id, gap_key) UNIQUE NULLS NOT DISTINCT index lives in
  // the migration SQL only — Drizzle has no nullsNotDistinct on unique().
  // That constraint is the load-bearing dedup mechanism for AUDIT-02.
  // Phase 25 AISSUE-03/04: dismissal reason + conditional follow-up state.
  // All nullable — human issues and pre-25 AI issues have no dismissal data.
  dismissalReason: text('dismissal_reason'),        // 'intentional'|'inaccurate'|'not_now'|'duplicate_of_human_issue'
  dismissalNotes: text('dismissal_notes'),
  dismissalSnoozeRemaining: integer('dismissal_snooze_remaining'),
  linkedIssueId: uuid('linked_issue_id').references(() => issues.id, { onDelete: 'set null' }),
  category: text('category'),                        // AuditCategory value; null for human issues
});

export const issueEntries = pgTable('issue_entries', {
  issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }).notNull(),
  entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.issueId, t.entryId] }),
}));

export const graphPositions = pgTable('graph_positions', {
  universeId: uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  entryId:    uuid('entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  x:          doublePrecision('x').notNull(),
  y:          doublePrecision('y').notNull(),
  updatedAt:  timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.universeId, t.entryId] }),
}));

export const timelinePins = pgTable('timeline_pins', {
  id:        uuid('id').primaryKey().defaultRandom(),
  entryId:   uuid('entry_id')
              .references(() => entries.id, { onDelete: 'cascade' })
              .notNull()
              .unique(),
  label:     text('label').notNull(),
  position:  doublePrecision('position').notNull(),
  precision: text('precision').default('exact').notNull(),
});
