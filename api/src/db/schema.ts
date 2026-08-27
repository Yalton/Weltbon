import { pgTable, uuid, text, timestamp, jsonb, boolean, integer, doublePrecision, primaryKey, unique, numeric, uniqueIndex, index, check, date, foreignKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type { EncryptedSecret } from '../services/crypto.js';

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

/**
 * Phase 35 REL-01: per-universe link-type registry entry shape.
 * Stored as universes.link_types jsonb (Record<string, LinkTypeRegistryEntry>).
 * Preset link types are seeded from code constants; the registry stores custom
 * types + user overrides. The `color` field is deferred for UI editing (Phase 35 D-03).
 */
export interface LinkTypeRegistryEntry {
  color?: string;
  directionDefault?: 'directed' | 'undirected';
  inverseLabel?: string;
}

export type LinkTypeRegistry = Record<string, LinkTypeRegistryEntry>;

/**
 * Phase 36 DATA-02: universe-scoped typed custom-field registry entry shape.
 * Stored as universes.field_registry jsonb (FieldRegistryEntry[] — an array, NOT a Record;
 * contrast Phase 35's link_types Record). Ported verbatim from 9b82f27:web/src/types/fieldRegistry.ts.
 * The web-side copy is (re)created in Plan 05 (web/src/types/fieldRegistry.ts).
 */
export type FieldType = 'text' | 'number' | 'boolean' | 'url' | 'entry-ref';

export interface FieldRegistryEntry {
  /** Field name — unique within the registry (case-insensitive check on server) */
  name: string;
  /** Data type governing the typed input rendered in MetaEditor + filter value inputs */
  type: FieldType;
  /** Optional hint text displayed below the input in MetaEditor */
  hint?: string;
}

// Universe theming (spec 2026-07-10): null = Observatory defaults everywhere.
export type UniverseTheme = {
  palette?: 'observatory' | 'ember' | 'verdant' | 'abyssal' | 'parchment';
  accent?: string;          // '#rrggbb' override of the palette accent
  displayFont?: 'spectral' | 'cormorant' | 'cinzel' | 'crimson';
  backdropAssetId?: string; // asset in THIS universe; unset = starfield
};

/** Stable database-owned identity used to prevent syncing an instance to itself. */
export const instanceIdentity = pgTable('instance_identity', {
  singleton: boolean('singleton').primaryKey().default(true),
  instanceId: uuid('instance_id').notNull().defaultRandom().unique(),
}, (t) => ({
  singletonOnly: check('instance_identity_singleton_true', sql`${t.singleton} = true`),
}));

export const users = pgTable('users', {
  id:               uuid('id').primaryKey().defaultRandom(),
  email:            text('email').notNull().unique(),
  displayName:      text('display_name').notNull(),
  passwordHash:     text('password_hash').notNull(),
  createdAt:        timestamp('created_at').defaultNow().notNull(),
  isAdmin:          boolean('is_admin').default(false).notNull(),
  disabledAt:       timestamp('disabled_at', { withTimezone: true }),
  disabledReason:   text('disabled_reason'),
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
    'artifact','species','culture','thread','language'  // Phase 32 D-08: 'language' as 10th element
  ]).notNull(),
  // Phase 20 D-01: nullable JSONB; `null` = "first visit, configure range".
  timelineWindow: jsonb('timeline_window').$type<TimelineWindow | null>(),
  // Phase 30 CALENDAR-01: nullable JSONB; `null` = "no calendar" → raw numeric
  // fallback everywhere (CALENDAR-03 backwards-compat). Non-null unlocks the
  // formatCalendar renderer for all position-display surfaces.
  calendar: jsonb('calendar').$type<Calendar | null>(),
  // Universe theming (2026-07-10 spec): nullable JSONB, null = default theme.
  theme: jsonb('theme').$type<UniverseTheme | null>(),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // Phase 24 AUDIT-03: per-universe LLM audit opt-in (default OFF).
  // audit_provider and audit_model are nullable until the user enables auditing.
  auditEnabled: boolean('audit_enabled').default(false).notNull(),
  auditProvider: text('audit_provider'),
  auditModel: text('audit_model'),
  // Phase 35 REL-01: per-universe link-type registry; presets seeded from code, registry stores custom + overrides.
  linkTypes: jsonb('link_types').$type<LinkTypeRegistry>().default({}).notNull(),
  // Phase 36 DATA-02: per-universe typed custom-field registry. Array (FieldRegistryEntry[]),
  // DEFAULT '[]' — backfilled by 0021_phase36_field_registry.sql. Contrast link_types Record DEFAULT '{}'.
  fieldRegistry: jsonb('field_registry').$type<FieldRegistryEntry[]>().default([]).notNull(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash:  text('token_hash').notNull(),
  expiresAt:  timestamp('expires_at').notNull(),
  revokedAt:  timestamp('revoked_at'),
  // Set ONLY when this row was retired by a rotation, naming the row it was
  // rotated into. Deliberately not set by logout or revokeAllForUser, which is
  // the whole point: it is what lets rotateRefreshToken tell a benign concurrent
  // replay (grace window applies) from a token revoked by an explicit logout
  // (must be refused immediately). No FK — it is a provenance marker, and a
  // self-reference would complicate the cascade on user delete.
  replacedById: uuid('replaced_by_id'),
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
  revokedAt:  timestamp('revoked_at', { withTimezone: true }),
});

export type AdminAuditAction = 'promoted' | 'demoted' | 'disabled' | 'enabled' | 'purged' | 'llm_shared_granted' | 'llm_shared_revoked';

/**
 * Append-only operator record. User IDs deliberately become null when either
 * account is purged; the email snapshots retain a useful, non-secret history.
 */
export const adminAuditLog = pgTable('admin_audit_log', {
  id:          uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorEmail:  text('actor_email').notNull(),
  targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'set null' }),
  targetEmail: text('target_email').notNull(),
  action:      text('action').$type<AdminAuditAction>().notNull(),
  details:     jsonb('details').default({}).notNull(),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  targetCreatedIdx: index('admin_audit_log_target_created_idx').on(t.targetUserId, t.createdAt),
  createdIdx: index('admin_audit_log_created_idx').on(t.createdAt),
}));

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
  idUserProviderUnique: unique('llm_api_keys_id_user_id_provider_unique').on(t.id, t.userId, t.provider),
}));

/**
 * Endpoint-based LLM providers (#48). Kept apart from `llm_api_keys` because
 * that table assumes a secret exists — its crypto columns are NOT NULL — and an
 * Ollama server usually has none. Relaxing them there would make one table mean
 * two things and force every existing read to handle a null ciphertext.
 *
 * The secret columns here are nullable and OPTIONAL: they carry a token only
 * when the user's Ollama sits behind an authenticating proxy.
 */
export const llmConnections = pgTable('llm_connections', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  userId:              uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  provider:            text('provider').notNull(),
  baseUrl:             text('base_url').notNull(),
  label:               text('label').default('').notNull(),
  ciphertext:          text('ciphertext'),
  iv:                  text('iv'),
  authTag:             text('auth_tag'),
  bodySuffix:          text('body_suffix'),
  encryptedKeyVersion: integer('encrypted_key_version'),
  createdAt:           timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastValidatedAt:     timestamp('last_validated_at', { withTimezone: true }),
}, (t) => ({
  userProviderUnique: unique('llm_connections_user_id_provider_unique').on(t.userId, t.provider),
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

export const llmSharedGrants = pgTable('llm_shared_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  ownerKeyId: uuid('owner_key_id'),
  provider: text('provider').notNull().$type<'anthropic' | 'openai'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  revokedReason: text('revoked_reason'),
}, (t) => ({
  providerCheck: check('llm_shared_grants_provider_check', sql`${t.provider} IN ('anthropic', 'openai')`),
  activeOwnerKeyCheck: check('llm_shared_grants_active_owner_key_check', sql`${t.ownerKeyId} IS NOT NULL OR ${t.revokedAt} IS NOT NULL`),
  ownerKeyFk: foreignKey({
    columns: [t.ownerKeyId],
    foreignColumns: [llmApiKeys.id],
    name: 'llm_shared_grants_owner_key_fk',
  }).onDelete('set null'),
  ownerKeyMatch: foreignKey({
    columns: [t.ownerKeyId, t.ownerUserId, t.provider],
    foreignColumns: [llmApiKeys.id, llmApiKeys.userId, llmApiKeys.provider],
    name: 'llm_shared_grants_owner_key_owner_provider_fk',
  }),
  ownerProviderIdx: index('llm_shared_grants_owner_provider_idx').on(t.ownerUserId, t.provider, t.revokedAt),
  recipientIdx: index('llm_shared_grants_recipient_idx').on(t.recipientUserId, t.revokedAt),
  idOwnerUnique: unique('llm_shared_grants_id_owner_unique').on(t.id, t.ownerUserId),
  idRecipientUnique: unique('llm_shared_grants_id_recipient_unique').on(t.id, t.recipientUserId),
  activeUnique: uniqueIndex('llm_shared_grants_recipient_provider_active_unique').on(t.recipientUserId, t.provider).where(sql`revoked_at IS NULL`),
}));

export const llmSharedConsents = pgTable('llm_shared_consents', {
  grantId: uuid('grant_id').primaryKey(),
  recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  policyVersion: text('policy_version').notNull(),
  consentedAt: timestamp('consented_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  grantRecipientMatch: foreignKey({
    columns: [t.grantId, t.recipientUserId],
    foreignColumns: [llmSharedGrants.id, llmSharedGrants.recipientUserId],
    name: 'llm_shared_consents_grant_fk',
  }).onDelete('cascade'),
}));

export const llmSharedUsage = pgTable('llm_shared_usage', {
  recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  monthStart: date('month_start').notNull(),
  reservedCostUsd: numeric('reserved_cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
  settledCostUsd: numeric('settled_cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
  activeAuditCount: integer('active_audit_count').default(0).notNull(),
  completedAuditCount: integer('completed_audit_count').default(0).notNull(),
  failedAuditCount: integer('failed_audit_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  primary: primaryKey({ columns: [t.recipientUserId, t.monthStart] }),
  reservedNonnegative: check('llm_shared_usage_reserved_nonnegative', sql`${t.reservedCostUsd} >= 0`),
  settledNonnegative: check('llm_shared_usage_settled_nonnegative', sql`${t.settledCostUsd} >= 0`),
  activeNonnegative: check('llm_shared_usage_active_nonnegative', sql`${t.activeAuditCount} >= 0`),
  completedNonnegative: check('llm_shared_usage_completed_nonnegative', sql`${t.completedAuditCount} >= 0`),
  failedNonnegative: check('llm_shared_usage_failed_nonnegative', sql`${t.failedAuditCount} >= 0`),
  monthStartFirstDay: check('llm_shared_usage_month_start_first_day', sql`${t.monthStart} = date_trunc('month', ${t.monthStart}::timestamp)::date`),
}));

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
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  // #44: universeFingerprint() aggregates this table filtered by universe_id
  // on every poll (~5s locally, plus every peer probe) — Postgres does not
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('share_tokens_universe_id_idx').on(t.universeId),
}));

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
  // $onUpdate means the best-effort lastUsedAt bump (entries.ts "template used")
  // now also floats the template in the updatedAt-ordered list — accepted as
  // "recently touched" semantics (Plan A final review, Minor #2).
  updatedAt:   timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
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
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  // #44: universeFingerprint() aggregates this table filtered by universe_id
  // on every poll (~5s locally, plus every peer probe) — Postgres does not
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('categories_universe_id_idx').on(t.universeId),
}));

export const entries = pgTable('entries', {
  id:           uuid('id').primaryKey().defaultRandom(),
  universeId:   uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  title:        text('title').notNull(),
  entryType:    text('entry_type').notNull(),
  summary:      text('summary').default('').notNull(),
  body:         text('body').default('').notNull(),
  tags:         text('tags').array().default([]).notNull(),
  aliases:      text('aliases').array().default([]).notNull(),  // Phase 45 XREF-04 (D-08): alternate wikilink resolution names
  meta:         jsonb('meta').default({}).notNull(),
  icon:         text('icon').default('').notNull(),
  searchVector: text('search_vector'),
  categoryId:   uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // Phase 29 D-10: per-entry public flag for share-link visibility.
  // Default flipped to TRUE by 0023_share_public_by_default.sql — sharing a universe
  // shows every entry without manual per-entry toggling. The flag is now an opt-OUT:
  // set false to hide a specific entry from share links. The server-side share filter
  // (entries.isPublic = true in share-views.ts) is unchanged — only the default flips.
  isPublic: boolean('is_public').default(true).notNull(),
  // Phase 36 DATA-03: per-entry WIP/draft flag (default OFF). Backfilled to false for every
  // existing row by 0022_phase36_entries_wip.sql. Mirrors the is_public boolean idiom.
  wip: boolean('wip').default(false).notNull(),
  // Phase 38 MEDIA-04 (D-06): optional cover image FK. Nullable — most entries have no
  // cover. ON DELETE SET NULL so deleting an asset auto-nulls the reference (D-12).
  // Lazy reference ((): any => assets.id) mirrors links.diagramId (line 310) because
  // `assets` is declared AFTER `entries` in this file — forward-reference gotcha.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  coverImageId: uuid('cover_image_id').references((): any => assets.id, { onDelete: 'set null' }),
}, (t) => ({
  // #44: universeFingerprint() aggregates this table filtered by universe_id
  // on every poll (~5s locally, plus every peer probe) — Postgres does not
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('entries_universe_id_idx').on(t.universeId),
}));

export const links = pgTable('links', {
  id:            uuid('id').primaryKey().defaultRandom(),
  universeId:    uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  sourceEntryId: uuid('source_entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  targetEntryId: uuid('target_entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  // Phase 28 D-04 (ported): label is now nullable (optional display override)
  label:         text('label'),
  // Phase 35 REL-01 (ported from 9b82f27 Phase 28): typed link semantic carrier
  linkType:      text('link_type'),
  // Phase 35 REL-01: direction replaces bidirectional; CHECK constraint in migration SQL
  direction:     text('direction').notNull(),
  createdAt:     timestamp('created_at').defaultNow().notNull(),
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // Phase 31 DIAGRAM-02: diagram back-reference + edge styling write-through.
  // diagramId is nullable so a link with no diagram_id still renders in the force graph.
  // lineStyle + color are constrained server-side (solid/dashed/dotted; fixed palette).
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  diagramId:     uuid('diagram_id').references((): any => diagrams.id, { onDelete: 'set null' }),
  lineStyle:     text('line_style'),
  color:         text('color'),
}, (t) => ({
  // #44: universeFingerprint() aggregates this table filtered by universe_id
  // on every poll (~5s locally, plus every peer probe) — Postgres does not
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('links_universe_id_idx').on(t.universeId),
}));

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
  credentialSource: text('credential_source').default('own').notNull().$type<'own' | 'shared'>(),
  credentialOwnerId: uuid('credential_owner_id'),
  sharedGrantId: uuid('shared_grant_id'),
}, (t) => ({
  // BL-01: partial unique index closing the TOCTOU race window in routes/audits.ts
  // between the pre-check SELECT and INSERT. Without this index, two concurrent POSTs
  // for the same universe can both create pending rows. The 23505 catch at audits.ts:269
  // depends on this index firing on race. The raw migration is the source of truth;
  // this declaration keeps schema↔migration parity for future drizzle-kit generate runs.
  universeActiveUnique: uniqueIndex('audit_runs_universe_active_unique')
    .on(t.universeId)
    .where(sql`status IN ('pending', 'running')`),
  sharedRecipientActiveUnique: uniqueIndex('audit_runs_shared_recipient_active_unique')
    .on(t.userId)
    .where(sql`credential_source = 'shared' AND status IN ('pending', 'running')`),
  sharedUserStartedIdx: index('audit_runs_shared_user_started_idx')
    .on(t.userId, t.startedAt)
    .where(sql`credential_source = 'shared'`),
  sharedProvenanceFk: foreignKey({
    columns: [t.sharedGrantId, t.credentialOwnerId],
    foreignColumns: [llmSharedGrants.id, llmSharedGrants.ownerUserId],
    name: 'audit_runs_shared_provenance_fk',
  }).onDelete('set null'),
  credentialSourceCheck: check('audit_runs_credential_source_check', sql`${t.credentialSource} IN ('own', 'shared')`),
  sharedProvenanceCheck: check('audit_runs_shared_provenance_check', sql`${t.credentialSource} = 'own' OR ((${t.credentialOwnerId} IS NOT NULL AND ${t.sharedGrantId} IS NOT NULL) OR (${t.credentialOwnerId} IS NULL AND ${t.sharedGrantId} IS NULL))`),
}));

export const llmSharedAuditReservations = pgTable('llm_shared_audit_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  auditRunId: uuid('audit_run_id').references(() => auditRuns.id, { onDelete: 'cascade' }).notNull(),
  grantId: uuid('grant_id').references(() => llmSharedGrants.id, { onDelete: 'set null' }),
  recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  monthStart: date('month_start').notNull(),
  reservedCostUsd: numeric('reserved_cost_usd', { precision: 12, scale: 6 }).notNull(),
  settledCostUsd: numeric('settled_cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
  state: text('state').notNull().$type<'reserved' | 'settled' | 'released'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (t) => ({
  auditRunUnique: unique('llm_shared_reservations_audit_run_unique').on(t.auditRunId),
  stateCheck: check('llm_shared_reservations_state_check', sql`${t.state} IN ('reserved', 'settled', 'released')`),
  recipientMonthIdx: index('llm_shared_reservations_recipient_month_idx').on(t.recipientUserId, t.monthStart, t.state),
  reservedNonnegative: check('llm_shared_reservations_reserved_nonnegative', sql`${t.reservedCostUsd} > 0`),
  settledNonnegative: check('llm_shared_reservations_settled_nonnegative', sql`${t.settledCostUsd} >= 0`),
  monthStartFirstDay: check('llm_shared_reservations_month_start_first_day', sql`${t.monthStart} = date_trunc('month', ${t.monthStart}::timestamp)::date`),
}));

export const issues = pgTable('issues', {
  id:          uuid('id').primaryKey().defaultRandom(),
  universeId:  uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  title:       text('title').notNull(),
  description: text('description').default('').notNull(),
  severity:    text('severity').default('minor').notNull(),
  resolved:    boolean('resolved').default(false).notNull(),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
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
  linkedIssueId: uuid('linked_issue_id').references((): AnyPgColumn => issues.id, { onDelete: 'set null' }),
  category: text('category'),                        // AuditCategory value; null for human issues
}, (t) => ({
  // #44: universeFingerprint() aggregates this table filtered by universe_id
  // on every poll (~5s locally, plus every peer probe) — Postgres does not
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('issues_universe_id_idx').on(t.universeId),
}));

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
  updatedAt:  timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
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
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
});

/**
 * Phase 31 DIAGRAM-01: Named diagram definitions scoped to a universe.
 *
 * A diagram is a named, manual-layout canvas (family tree, org chart, etc.)
 * that lives alongside the force-directed Graph view. Nodes (entries) and
 * edges (links) are added explicitly — no auto-population.
 */
export const diagrams = pgTable('diagrams', {
  id:          uuid('id').primaryKey().defaultRandom(),
  universeId:  uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  name:        text('name').notNull(),
  description: text('description'),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  // #44: universeFingerprint() aggregates this table filtered by universe_id
  // on every poll (~5s locally, plus every peer probe) — Postgres does not
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('diagrams_universe_id_idx').on(t.universeId),
}));

/**
 * Phase 31 DIAGRAM-01: Positioned entry nodes within a named diagram.
 *
 * Mirrors graphPositions but scoped to a diagram rather than the whole universe.
 * The unique index on (diagramId, entryId) prevents the same entry from appearing
 * twice in one diagram. Deleting a node row NEVER touches the underlying entries row.
 */
export const diagramNodes = pgTable('diagram_nodes', {
  id:        uuid('id').primaryKey().defaultRandom(),
  diagramId: uuid('diagram_id').references(() => diagrams.id, { onDelete: 'cascade' }).notNull(),
  entryId:   uuid('entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  x:         doublePrecision('x').notNull(),
  y:         doublePrecision('y').notNull(),
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  diagramNodesUniqueIdx: uniqueIndex('diagram_nodes_unique_idx').on(t.diagramId, t.entryId),
}));

/**
 * Phase 32 CONLANG-01: Per-universe conlang dictionary words.
 *
 * - `universeId` scopes words to a universe; FK cascades on universe delete.
 * - `languageEntryId` is NULLABLE: when null the word belongs to a universe-level
 *   fallback dictionary (D-06). When set, the word belongs to the language entry's
 *   specific dictionary.
 * - `searchVector` is declared as plain text() (GENERATED in raw SQL migration 0018)
 *   — same convention as entries.searchVector (line ~243). The actual tsvector type
 *   and GENERATED ALWAYS AS expression live in 0018_phase32_dictionary.sql.
 * - Scope-unique index: (universe_id, COALESCE(language_entry_id, sentinel), lower(word))
 *   lives in the migration only — Drizzle TS uniqueIndex() cannot express COALESCE
 *   sentinel or lower() expressions (same caveat as diagram_nodes_unique_idx).
 * - `etymology` is a markdown field (D-11); rendered via MarkdownRenderer.
 * - The 'simple' regconfig for word/ipa prevents English stemming from corrupting
 *   invented conlang words (T-32-02 / Pitfall 2 in RESEARCH.md).
 */
/**
 * Phase 38 MEDIA-01 (D-01, D-02): Per-universe image asset registry.
 *
 * - `id` is the storage key (UUID) — also used as the `asset://uuid` embed ref.
 * - `universeId` FK cascades on universe delete (all assets destroyed with universe).
 * - `filename` is the original user-provided filename (display only).
 * - `mimeType` is the sniffed mime type (not client-claimed Content-Type).
 * - `extension` is derived from mimeType at upload time (for ZIP export filenames).
 * - `sizeBytes` is the safe-re-encoded original file size.
 * - `thumbSizeBytes` is the ~400px thumbnail size.
 * - `altText` is an optional user-editable alt-text string (nullable, D-05 accessibility).
 */
export const assets = pgTable('assets', {
  id:             uuid('id').primaryKey().defaultRandom(),
  universeId:     uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  filename:       text('filename').notNull(),
  mimeType:       text('mime_type').notNull(),
  extension:      text('extension').notNull(),
  sizeBytes:      integer('size_bytes').notNull(),
  thumbSizeBytes: integer('thumb_size_bytes').notNull(),
  altText:        text('alt_text'),
  // Plan C (sync spec S-10): SHA-256 hex of the ORIGINAL stored bytes (the
  // post-sharp re-encode written under storage key `<id>`), never the thumbnail.
  // NULLABLE by necessity: the bytes live in storageBackend, not in SQL, so
  // migration 0034 cannot compute it. ensureAssetHashes() backfills lazily
  // before any sync snapshot is built (C-04/C-05).
  contentHash:    text('content_hash'),
  createdAt:      timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  // Lookup key for GET/PUT /api/sync/universes/:uid/assets/:hash.
  contentHashIdx: index('assets_content_hash_idx').on(t.universeId, t.contentHash),
}));

export const dictionaryWords = pgTable('dictionary_words', {
  id:              uuid('id').primaryKey().defaultRandom(),
  universeId:      uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  languageEntryId: uuid('language_entry_id').references(() => entries.id, { onDelete: 'cascade' }),  // nullable = universe-level fallback (D-06)
  word:            text('word').notNull(),
  ipa:             text('ipa').default('').notNull(),
  partOfSpeech:    text('part_of_speech').default('').notNull(),
  gloss:           text('gloss').notNull(),
  etymology:       text('etymology').default('').notNull(),  // markdown field (D-11)
  tags:            text('tags').array().default([]).notNull(),
  searchVector:    text('search_vector'),  // GENERATED in SQL migration (same as entries.searchVector ln ~243)
  createdAt:       timestamp('created_at').defaultNow().notNull(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // NOTE: scope-unique index with lower(word) + COALESCE sentinel lives in migration 0018 only —
  // Drizzle TS uniqueIndex() cannot express COALESCE-sentinel or lower() expressions.
}, (t) => ({
  // #44: universeFingerprint() aggregates this table filtered by universe_id
  // on every poll (~5s locally, plus every peer probe) — Postgres does not
  // auto-index FKs, so without this it is a sequential scan. Migration 0018's
  // lower(word)+COALESCE unique index does not lead with universe_id and
  // cannot serve this.
  universeIdIdx: index('dictionary_words_universe_id_idx').on(t.universeId),
}));

/**
 * Phase 39 MAPS-01 (D-01, D-02, D-03): Per-universe image-backed map definitions.
 *
 * - `imageAssetId` is nullable in the DB (ON DELETE SET NULL on asset delete per D-03)
 *   but the API requires it at create-time (D-02 — cannot create a map without an image).
 * - Lazy reference `(): any => assets.id` mirrors entries.coverImageId (line ~297)
 *   because `assets` is declared AFTER `entries` in this file.
 * - No description column — maps are identified by name + image, not text.
 */
export const maps = pgTable('maps', {
  id:           uuid('id').primaryKey().defaultRandom(),
  universeId:   uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  name:         text('name').notNull(),
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  imageAssetId: uuid('image_asset_id').references((): any => assets.id, { onDelete: 'set null' }),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // Phase 40 MAPS-05 (D-03): nullable JSON legend caption overrides.
  // A Record<string, string> keyed by color/icon combo stored as text.
  legendLabels: text('legend_labels'),  // nullable JSON: Record<string, string>
}, (t) => ({
  // #44: universeFingerprint() aggregates this table filtered by universe_id
  // on every poll (~5s locally, plus every peer probe) — Postgres does not
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('maps_universe_id_idx').on(t.universeId),
}));

/**
 * Phase 39 MAPS-02/MAPS-03 (D-10, D-11): Entry-linked pins within a map.
 *
 * - `x` and `y` are normalized 0..1 fractions of image width/height (D-10).
 *   Stored as doublePrecision; Zod route validation enforces min(0).max(1) bounds.
 * - NO uniqueIndex on (mapId, entryId) — multiple pins per entry are allowed (D-11).
 *   This is a deliberate deviation from diagramNodes which has a unique constraint.
 * - ON DELETE CASCADE on both mapId and entryId FKs: deleting a map removes all its
 *   pins; deleting an entry removes pins that link to it (pin ≠ entry).
 * - Phase 40 MAPS-05 (D-01, D-02): nullable color + icon style overrides.
 *   color: nullable hex string; null → entryTypeHexColor fallback (D-01).
 *   icon:  nullable glyph key (e.g. 'star', 'skull') from mapGlyphs.ts (D-02).
 */
export const mapPins = pgTable('map_pins', {
  id:      uuid('id').primaryKey().defaultRandom(),
  mapId:   uuid('map_id').references(() => maps.id, { onDelete: 'cascade' }).notNull(),
  entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'cascade' }),  // nullable (D-01a): a pin can be map-only (NEST-01)
  x:       doublePrecision('x').notNull(),
  y:       doublePrecision('y').notNull(),
  color:   text('color'),   // nullable hex; null → entryTypeHexColor fallback (D-01)
  icon:    text('icon'),    // nullable glyph key (D-02)
  // Phase 52 SECRET-01/02: owner-only secret flag (default false = not secret).
  // Server-side share filter in share-views.ts drops items where secret=true.
  // Inverse polarity of entries.isPublic: false = visible, true = excluded from share.
  secret: boolean('secret').default(false).notNull(),
  // Phase 53 NEST-01: target_map_id — nullable FK to maps (ON DELETE SET NULL, mirrors terrainTypeId)
  // so deleting a target map nulls the link rather than cascade-deleting the source pin.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  targetMapId: uuid('target_map_id').references((): any => maps.id, { onDelete: 'set null' }),
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  // #44: Postgres does not auto-index FKs; this is the foreign-key column
  // pins are looked up by (mirrors mapRegions/mapRoutes' map_id indexes).
  mapIdIdx: index('map_pins_map_id_idx').on(t.mapId),
}));

/**
 * Phase 40 MAPS-04 (D-09): Region polygons within a map.
 *
 * - `entryId` is nullable: a region may be a standalone territory (D-05).
 * - ON DELETE CASCADE on mapId: deleting the map removes all its regions.
 * - ON DELETE CASCADE on entryId (nullable): deleting the linked entry removes
 *   any regions that reference it (region is not an entry surrogate).
 * - points: JSON array of {x, y} normalized 0..1 fractions (D-09), stored as text.
 * - color: nullable hex string — when null, element renders in entryTypeHexColor (D-01).
 * - NO uniqueIndex on (mapId, entryId) — multiple regions per entry are allowed (D-09).
 * - Phase 42 LAYER-01/LAYER-02 (D-42): nullable terrain_type_id discriminator.
 *   When set, this region is a terrain area; its fill layer is derived from
 *   terrain_type_id → layer_id. ON DELETE SET NULL so deleting a terrain type
 *   orphans the discriminator rather than cascade-deleting user regions.
 */
export const mapRegions = pgTable('map_regions', {
  id:            uuid('id').primaryKey().defaultRandom(),
  mapId:         uuid('map_id').references(() => maps.id, { onDelete: 'cascade' }).notNull(),
  entryId:       uuid('entry_id').references(() => entries.id, { onDelete: 'cascade' }),  // nullable (D-05)
  name:          text('name').notNull().default(''),
  points:        text('points').notNull(),  // JSON: [{x:number,y:number}, ...]
  color:         text('color'),             // nullable hex (D-01)
  createdAt:     timestamp('created_at').defaultNow().notNull(),
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  terrainTypeId: uuid('terrain_type_id').references((): any => terrainTypes.id, { onDelete: 'set null' }),  // nullable discriminator (Phase 42)
  // Phase 52 SECRET-01/02: owner-only secret flag (default false = not secret).
  // Server-side share filter in share-views.ts drops items where secret=true.
  // Inverse polarity of entries.isPublic: false = visible, true = excluded from share.
  secret: boolean('secret').default(false).notNull(),
  // Phase 53 NEST-01: target_map_id — nullable FK to maps (ON DELETE SET NULL, mirrors terrainTypeId)
  // so deleting a target map nulls the link rather than cascade-deleting the source region.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  targetMapId: uuid('target_map_id').references((): any => maps.id, { onDelete: 'set null' }),
}, (t) => ({
  // #44: Postgres does not auto-index FKs; this is the foreign-key column
  // regions are looked up by (mirrors mapPins/mapRoutes' map_id indexes).
  mapIdIdx: index('map_regions_map_id_idx').on(t.mapId),
}));

/**
 * Phase 51 ROUTE-01: Per-map journey/route polylines.
 *
 * Structural near-clone of mapRegions — same FK cascade rules and points JSON
 * convention — with three route-only style fields and no terrainTypeId.
 *
 * - points: JSON array of {x, y} normalized 0..1 fractions, stored as text.
 * - color: nullable hex string (null → fallback render color).
 * - lineStyle: 'solid' | 'dashed' — validated at Zod layer; stored as plain text.
 * - width: discrete preset (thin/medium/thick) stored as integer.
 * - showArrow: optional end-arrowhead, default false.
 */
export const mapRoutes = pgTable('map_routes', {
  id:        uuid('id').primaryKey().defaultRandom(),
  mapId:     uuid('map_id').references(() => maps.id, { onDelete: 'cascade' }).notNull(),
  entryId:   uuid('entry_id').references(() => entries.id, { onDelete: 'cascade' }),  // nullable
  name:      text('name').notNull().default(''),
  points:    text('points').notNull(),  // JSON: [{x:number,y:number}, ...]
  color:     text('color'),             // nullable hex
  lineStyle: text('line_style').notNull().default('solid'),   // 'solid' | 'dashed' (D-02)
  width:     integer('width').notNull().default(4),           // discrete preset px (D-03)
  showArrow: boolean('show_arrow').notNull().default(false),  // end-arrowhead (D-04)
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // Phase 52 SECRET-01/02: owner-only secret flag (default false = not secret).
  // Server-side share filter in share-views.ts drops items where secret=true.
  // Inverse polarity of entries.isPublic: false = visible, true = excluded from share.
  secret: boolean('secret').default(false).notNull(),
}, (t) => ({
  // #44: Postgres does not auto-index FKs; this is the foreign-key column
  // routes are looked up by (mirrors mapPins/mapRegions' map_id indexes).
  mapIdIdx: index('map_routes_map_id_idx').on(t.mapId),
}));

/**
 * Phase 42 LAYER-01/LAYER-02: Universe-scoped terrain layer definitions.
 *
 * - `universeId` FK CASCADE: deleting a universe removes all its layers (and
 *   cascades to terrain_types via terrain_types.layer_id FK CASCADE).
 * - `ordered` boolean: true → ranked elevation bands; false → flat thematic palette.
 * - `defaultOpacity` persists the initial opacity for Phase 43 rendering (D-42-08).
 * - `sortOrder` integer for user-defined display order.
 */
export const mapLayers = pgTable('map_layers', {
  id:             uuid('id').primaryKey().defaultRandom(),
  universeId:     uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  name:           text('name').notNull(),
  ordered:        boolean('ordered').notNull().default(false),
  defaultOpacity: doublePrecision('default_opacity').notNull().default(0.6),
  sortOrder:      integer('sort_order').notNull().default(0),
  createdAt:      timestamp('created_at').defaultNow().notNull(),
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // Phase 52 SECRET-01/02: owner-only secret flag (default false = not secret).
  // Server-side share filter in share-views.ts drops items where secret=true.
  // Inverse polarity of entries.isPublic: false = visible, true = excluded from share.
  secret: boolean('secret').default(false).notNull(),
}, (t) => ({
  // #44: universeFingerprint() aggregates this table filtered by universe_id
  // on every poll (~5s locally, plus every peer probe) — Postgres does not
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('map_layers_universe_id_idx').on(t.universeId),
}));

/**
 * Phase 42 LAYER-01/LAYER-03: Terrain type definitions within a layer.
 *
 * - `layerId` FK CASCADE: deleting a layer removes all its terrain types (and
 *   sets map_regions.terrain_type_id = NULL via the SET NULL FK on mapRegions).
 * - `color` is NOT NULL (auto-assigned at create; never rendered colorless).
 * - `label` is nullable free-text height-range label for ordered bands (D-42-06).
 * - `sortOrder` integer for user-defined rank within the layer.
 */
export const terrainTypes = pgTable('terrain_types', {
  id:        uuid('id').primaryKey().defaultRandom(),
  layerId:   uuid('layer_id').references(() => mapLayers.id, { onDelete: 'cascade' }).notNull(),
  name:      text('name').notNull(),
  color:     text('color').notNull(),   // hex, auto-assigned, never null (D-42-07)
  label:     text('label'),             // nullable free-text height-range label (D-42-06)
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Sync LWW timestamp (Plan A, sync spec S-03). $onUpdate bumps it on every
  // ORM .update() without touching route code.
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  // #44: Postgres does not auto-index FKs; this is the foreign-key column
  // relations traverse from a layer (mirrors mapPins/mapRegions/mapRoutes'
  // map_id indexes below).
  layerIdIdx: index('terrain_types_layer_id_idx').on(t.layerId),
}));

/**
 * Sync Foundation (Plan A — sync spec "Data model", decisions S-01..S-10).
 * sync_remotes: a remote Weltbon instance this user syncs with. The PAT is
 * stored AES-256-GCM-encrypted (services/crypto.ts), same at-rest posture as
 * llm_api_keys.
 */
export const syncRemotes = pgTable('sync_remotes', {
  id:           uuid('id').primaryKey().defaultRandom(),
  userId:       uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  label:        text('label').default('').notNull(),
  baseUrl:      text('base_url').notNull(),
  encryptedPat: jsonb('encrypted_pat').$type<EncryptedSecret>().notNull(),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** One (universe × remote) sync relationship; base_snapshot_key points into storageBackend. */
export const syncLinks = pgTable('sync_links', {
  id:              uuid('id').primaryKey().defaultRandom(),
  universeId:      uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  remoteId:        uuid('remote_id').references(() => syncRemotes.id, { onDelete: 'cascade' }).notNull(),
  baseSnapshotKey: text('base_snapshot_key'),
  lastSyncedAt:    timestamp('last_synced_at', { withTimezone: true }),
  status:          text('status').default('idle').notNull(),   // 'idle' | 'syncing' | 'error'
  lastError:       text('last_error'),
  createdAt:       timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // ── #44 auto-sync scheduling state (AS-05) ────────────────────────────────
  // Only what must survive a restart. Debounce bookkeeping is in-memory by
  // design: its worst case after a restart is syncing immediately.
  autoSync:              boolean('auto_sync').default(true).notNull(),
  /** Local fingerprint captured AFTER the last successful run — see AS-05. */
  lastSyncedFingerprint: text('last_synced_fingerprint'),
  lastRemoteFingerprint: text('last_remote_fingerprint'),
  nextPollAt:            timestamp('next_poll_at', { withTimezone: true }),
  /** Consecutive transient failures. Reset to 0 by ANY success, manual included. */
  failureCount:          integer('failure_count').default(0).notNull(),
  /** Non-null means a permanent failure stopped auto-sync for this link. */
  pausedReason:          text('paused_reason'),
}, (t) => ({
  universeRemoteUnique: uniqueIndex('sync_links_universe_remote_unique').on(t.universeId, t.remoteId),
}));

/** LWW losers, kept for the non-blocking review list (S-03). */
export const syncConflicts = pgTable('sync_conflicts', {
  id:            uuid('id').primaryKey().defaultRandom(),
  universeId:    uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  tableName:     text('table_name').notNull(),
  // D-03: the ledger records MERGE keys, and the merge's key space is not the
  // DB's — merge.ts keys the universe singleton on the literal 'universe', and a
  // future collection may key on a composite string. Typing this `uuid` encoded
  // an assumption the merge engine never made.
  rowId:         text('row_id').notNull(),
  winner:        text('winner').notNull(),                     // 'local' | 'remote'
  loserPayload:  jsonb('loser_payload').notNull(),
  resolvedAt:    timestamp('resolved_at', { withTimezone: true }),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
