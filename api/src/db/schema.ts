import { pgTable, uuid, text, timestamp, jsonb, boolean, integer, doublePrecision, primaryKey, unique, numeric, uniqueIndex, index, check, date, foreignKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type { EncryptedSecret } from '../services/crypto.js';

export interface TimelineWindow {
  start: number;
  end: number;
}

export interface CalendarEra {
  name: string;
  abbr: string;
  startPosition: number;
}

export interface CalendarMonth {
  name: string;
  lengthDays: number;
}

export interface CalendarMoon {
  name: string;
  cycleDays: number;
}

export interface Calendar {
  eras: CalendarEra[];
  months: CalendarMonth[];
  weekdays: string[];
  moons: CalendarMoon[];
  beforeEraAbbr: string;
}

export interface LinkTypeRegistryEntry {
  color?: string;
  directionDefault?: 'directed' | 'undirected';
  inverseLabel?: string;
}

export type LinkTypeRegistry = Record<string, LinkTypeRegistryEntry>;

export type FieldType = 'text' | 'number' | 'boolean' | 'url' | 'entry-ref';

export interface FieldRegistryEntry {
  name: string;
  type: FieldType;
  hint?: string;
}

// Universe theming (spec 2026-07-10): null = Observatory defaults everywhere.
export type UniverseTheme = {
  palette?: 'observatory' | 'ember' | 'verdant' | 'abyssal' | 'parchment';
  accent?: string;          // '#rrggbb' override of the palette accent
  displayFont?: 'spectral' | 'cormorant' | 'cinzel' | 'crimson';
  backdropAssetId?: string; // asset in THIS universe; unset = starfield
};

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
  llmConsentedAt:   timestamp('llm_consented_at', { withTimezone: true }),
});

export const universes = pgTable('universes', {
  id:           uuid('id').primaryKey().defaultRandom(),
  userId:       uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name:         text('name').notNull(),
  description:  text('description').default('').notNull(),
  entryTypes:   text('entry_types').array().default([
    'concept','entity','location','event','faction',
    'artifact','species','culture','thread','language'
  ]).notNull(),
  timelineWindow: jsonb('timeline_window').$type<TimelineWindow | null>(),
  // fallback everywhere (CALENDAR-03 backwards-compat). Non-null unlocks the
  // formatCalendar renderer for all position-display surfaces.
  calendar: jsonb('calendar').$type<Calendar | null>(),
  // Universe theming (2026-07-10 spec): nullable JSONB, null = default theme.
  theme: jsonb('theme').$type<UniverseTheme | null>(),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  auditEnabled: boolean('audit_enabled').default(false).notNull(),
  auditProvider: text('audit_provider'),
  auditModel: text('audit_model'),
  linkTypes: jsonb('link_types').$type<LinkTypeRegistry>().default({}).notNull(),
  fieldRegistry: jsonb('field_registry').$type<FieldRegistryEntry[]>().default([]).notNull(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash:  text('token_hash').notNull(),
  expiresAt:  timestamp('expires_at').notNull(),
  revokedAt:  timestamp('revoked_at'),
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

export type AdminAuditAction = 'promoted' | 'demoted' | 'disabled' | 'enabled' | 'purged' | 'llm_shared_granted' | 'llm_shared_revoked'
  | 'invite_request_issued' | 'invite_request_dismissed';

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

export type InviteRequestStatus = 'pending' | 'issued' | 'dismissed';

/**
 * Visitor requests for an invite code, from the public landing page. There is
 * no outbound email, so admins review the queue in-app and contact the
 * requester themselves. Emails are stored lower-cased; the partial unique
 * index keeps at most one PENDING request per address.
 */
export const inviteRequests = pgTable('invite_requests', {
  id:           uuid('id').primaryKey().defaultRandom(),
  name:         text('name').notNull(),
  email:        text('email').notNull(),
  note:         text('note'),
  status:       text('status').$type<InviteRequestStatus>().default('pending').notNull(),
  inviteCodeId: uuid('invite_code_id').references(() => inviteCodes.id, { onDelete: 'set null' }),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  reviewedAt:   timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy:   uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => ({
  statusCheck: check('invite_requests_status_check', sql`${t.status} IN ('pending', 'issued', 'dismissed')`),
  nameLength: check('invite_requests_name_length', sql`char_length(${t.name}) <= 100`),
  emailLength: check('invite_requests_email_length', sql`char_length(${t.email}) <= 254`),
  noteLength: check('invite_requests_note_length', sql`${t.note} IS NULL OR char_length(${t.note}) <= 1000`),
  statusCreatedIdx: index('invite_requests_status_created_idx').on(t.status, t.createdAt),
  pendingEmailUnique: uniqueIndex('invite_requests_pending_email_unique').on(t.email).where(sql`${t.status} = 'pending'`),
}));

export const inviteRequestsRelations = relations(inviteRequests, ({ one }) => ({
  inviteCode: one(inviteCodes, { fields: [inviteRequests.inviteCodeId], references: [inviteCodes.id] }),
  reviewer:   one(users, { fields: [inviteRequests.reviewedBy], references: [users.id], relationName: 'invite_request_reviewer' }),
}));

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

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('share_tokens_universe_id_idx').on(t.universeId),
}));

export const shareTokensRelations = relations(shareTokens, ({ one }) => ({
  user:     one(users, { fields: [shareTokens.userId], references: [users.id], relationName: 'share_owner' }),
  universe: one(universes, { fields: [shareTokens.universeId], references: [universes.id], relationName: 'share_universe' }),
}));

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

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
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
  aliases:      text('aliases').array().default([]).notNull(),
  meta:         jsonb('meta').default({}).notNull(),
  icon:         text('icon').default('').notNull(),
  searchVector: text('search_vector'),
  categoryId:   uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // shows every entry without manual per-entry toggling. The flag is now an opt-OUT:
  // set false to hide a specific entry from share links. The server-side share filter
  // (entries.isPublic = true in share-views.ts) is unchanged — only the default flips.
  isPublic: boolean('is_public').default(true).notNull(),
  wip: boolean('wip').default(false).notNull(),
  // cover. ON DELETE SET NULL so deleting an asset auto-nulls the reference (D-12).
  // `assets` is declared AFTER `entries` in this file — forward-reference gotcha.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  coverImageId: uuid('cover_image_id').references((): any => assets.id, { onDelete: 'set null' }),
}, (t) => ({
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('entries_universe_id_idx').on(t.universeId),
}));

export const links = pgTable('links', {
  id:            uuid('id').primaryKey().defaultRandom(),
  universeId:    uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  sourceEntryId: uuid('source_entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  targetEntryId: uuid('target_entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  label:         text('label'),
  linkType:      text('link_type'),
  direction:     text('direction').notNull(),
  createdAt:     timestamp('created_at').defaultNow().notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // lineStyle + color are constrained server-side (solid/dashed/dotted; fixed palette).
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  diagramId:     uuid('diagram_id').references((): any => diagrams.id, { onDelete: 'set null' }),
  lineStyle:     text('line_style'),
  color:         text('color'),
}, (t) => ({
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('links_universe_id_idx').on(t.universeId),
}));

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
  hallucinatedEntryReferenceCount: integer('hallucinated_entry_reference_count').default(0).notNull(),

  analyzedEntries: integer('analyzed_entries').default(0).notNull(),
  // (newly-released live-list model the dropdown surfaced via the D-05 unpriced UX path).
  // excluded from llm-keys totalSpent SUM (with parallel COUNT footnote). DEFAULT false

  costUnknown: boolean('cost_unknown').default(false).notNull(),
  credentialSource: text('credential_source').default('own').notNull().$type<'own' | 'shared'>(),
  credentialOwnerId: uuid('credential_owner_id'),
  sharedGrantId: uuid('shared_grant_id'),
}, (t) => ({
  // BL-01: partial unique index closing the TOCTOU race window in routes/audits.ts
  // between the pre-check SELECT and INSERT. Without this index, two concurrent POSTs
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
  // Existing creation paths remain byte-identical: source defaults to 'human',
  source: text('source').default('human').notNull(),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  gapKey: text('gap_key'),
  model: text('model'),
  auditRunId: uuid('audit_run_id').references(() => auditRuns.id, { onDelete: 'set null' }),
  dismissalSnapshot: jsonb('dismissal_snapshot'),
  // That constraint is the load-bearing dedup mechanism for AUDIT-02.
  // All nullable — human issues and pre-25 AI issues have no dismissal data.
  dismissalReason: text('dismissal_reason'),        // 'intentional'|'inaccurate'|'not_now'|'duplicate_of_human_issue'
  dismissalNotes: text('dismissal_notes'),
  dismissalSnoozeRemaining: integer('dismissal_snooze_remaining'),
  linkedIssueId: uuid('linked_issue_id').references((): AnyPgColumn => issues.id, { onDelete: 'set null' }),
  category: text('category'),                        // AuditCategory value; null for human issues
}, (t) => ({
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

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export const diagrams = pgTable('diagrams', {
  id:          uuid('id').primaryKey().defaultRandom(),
  universeId:  uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  name:        text('name').notNull(),
  description: text('description'),
  createdAt:   timestamp('created_at').defaultNow().notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('diagrams_universe_id_idx').on(t.universeId),
}));

export const diagramNodes = pgTable('diagram_nodes', {
  id:        uuid('id').primaryKey().defaultRandom(),
  diagramId: uuid('diagram_id').references(() => diagrams.id, { onDelete: 'cascade' }).notNull(),
  entryId:   uuid('entry_id').references(() => entries.id, { onDelete: 'cascade' }).notNull(),
  x:         doublePrecision('x').notNull(),
  y:         doublePrecision('y').notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  diagramNodesUniqueIdx: uniqueIndex('diagram_nodes_unique_idx').on(t.diagramId, t.entryId),
}));

export const assets = pgTable('assets', {
  id:             uuid('id').primaryKey().defaultRandom(),
  universeId:     uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  filename:       text('filename').notNull(),
  mimeType:       text('mime_type').notNull(),
  extension:      text('extension').notNull(),
  sizeBytes:      integer('size_bytes').notNull(),
  thumbSizeBytes: integer('thumb_size_bytes').notNull(),
  altText:        text('alt_text'),

  // post-sharp re-encode written under storage key `<id>`), never the thumbnail.
  // before any sync snapshot is built (C-04/C-05).
  contentHash:    text('content_hash'),
  createdAt:      timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
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
  // auto-index FKs, so without this it is a sequential scan. Migration 0018's
  universeIdIdx: index('dictionary_words_universe_id_idx').on(t.universeId),
}));

export const maps = pgTable('maps', {
  id:           uuid('id').primaryKey().defaultRandom(),
  universeId:   uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  name:         text('name').notNull(),
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  imageAssetId: uuid('image_asset_id').references((): any => assets.id, { onDelete: 'set null' }),
  createdAt:    timestamp('created_at').defaultNow().notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  legendLabels: text('legend_labels'),  // nullable JSON: Record<string, string>
}, (t) => ({
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('maps_universe_id_idx').on(t.universeId),
}));

export const mapPins = pgTable('map_pins', {
  id:      uuid('id').primaryKey().defaultRandom(),
  mapId:   uuid('map_id').references(() => maps.id, { onDelete: 'cascade' }).notNull(),
  entryId: uuid('entry_id').references(() => entries.id, { onDelete: 'cascade' }),  // nullable (D-01a): a pin can be map-only (NEST-01)
  x:       doublePrecision('x').notNull(),
  y:       doublePrecision('y').notNull(),
  color:   text('color'),   // nullable hex; null → entryTypeHexColor fallback (D-01)
  icon:    text('icon'),    // nullable glyph key (D-02)
  // Server-side share filter in share-views.ts drops items where secret=true.
  secret: boolean('secret').default(false).notNull(),
  // so deleting a target map nulls the link rather than cascade-deleting the source pin.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  targetMapId: uuid('target_map_id').references((): any => maps.id, { onDelete: 'set null' }),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  // #44: Postgres does not auto-index FKs; this is the foreign-key column
  mapIdIdx: index('map_pins_map_id_idx').on(t.mapId),
}));

export const mapRegions = pgTable('map_regions', {
  id:            uuid('id').primaryKey().defaultRandom(),
  mapId:         uuid('map_id').references(() => maps.id, { onDelete: 'cascade' }).notNull(),
  entryId:       uuid('entry_id').references(() => entries.id, { onDelete: 'cascade' }),  // nullable (D-05)
  name:          text('name').notNull().default(''),
  points:        text('points').notNull(),  // JSON: [{x:number,y:number}, ...]
  color:         text('color'),             // nullable hex (D-01)
  createdAt:     timestamp('created_at').defaultNow().notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  terrainTypeId: uuid('terrain_type_id').references((): any => terrainTypes.id, { onDelete: 'set null' }),
  // Server-side share filter in share-views.ts drops items where secret=true.
  secret: boolean('secret').default(false).notNull(),
  // so deleting a target map nulls the link rather than cascade-deleting the source region.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  targetMapId: uuid('target_map_id').references((): any => maps.id, { onDelete: 'set null' }),
}, (t) => ({
  // #44: Postgres does not auto-index FKs; this is the foreign-key column
  mapIdIdx: index('map_regions_map_id_idx').on(t.mapId),
}));

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

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // Server-side share filter in share-views.ts drops items where secret=true.
  secret: boolean('secret').default(false).notNull(),
}, (t) => ({
  // #44: Postgres does not auto-index FKs; this is the foreign-key column
  mapIdIdx: index('map_routes_map_id_idx').on(t.mapId),
}));

export const mapLayers = pgTable('map_layers', {
  id:             uuid('id').primaryKey().defaultRandom(),
  universeId:     uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  name:           text('name').notNull(),
  ordered:        boolean('ordered').notNull().default(false),
  defaultOpacity: doublePrecision('default_opacity').notNull().default(0.6),
  sortOrder:      integer('sort_order').notNull().default(0),
  createdAt:      timestamp('created_at').defaultNow().notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  // Server-side share filter in share-views.ts drops items where secret=true.
  secret: boolean('secret').default(false).notNull(),
}, (t) => ({
  // auto-index FKs, so without this it is a sequential scan.
  universeIdIdx: index('map_layers_universe_id_idx').on(t.universeId),
}));

export const terrainTypes = pgTable('terrain_types', {
  id:        uuid('id').primaryKey().defaultRandom(),
  layerId:   uuid('layer_id').references(() => mapLayers.id, { onDelete: 'cascade' }).notNull(),
  name:      text('name').notNull(),
  color:     text('color').notNull(),   // hex, auto-assigned, never null (D-42-07)
  label:     text('label'),             // nullable free-text height-range label (D-42-06)
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => ({
  // #44: Postgres does not auto-index FKs; this is the foreign-key column
  layerIdIdx: index('terrain_types_layer_id_idx').on(t.layerId),
}));

export const syncRemotes = pgTable('sync_remotes', {
  id:           uuid('id').primaryKey().defaultRandom(),
  userId:       uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  label:        text('label').default('').notNull(),
  baseUrl:      text('base_url').notNull(),
  encryptedPat: jsonb('encrypted_pat').$type<EncryptedSecret>().notNull(),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

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
  autoSync:              boolean('auto_sync').default(true).notNull(),
  lastSyncedFingerprint: text('last_synced_fingerprint'),
  lastRemoteFingerprint: text('last_remote_fingerprint'),
  nextPollAt:            timestamp('next_poll_at', { withTimezone: true }),
  failureCount:          integer('failure_count').default(0).notNull(),
  pausedReason:          text('paused_reason'),
}, (t) => ({
  universeRemoteUnique: uniqueIndex('sync_links_universe_remote_unique').on(t.universeId, t.remoteId),
}));

export const syncConflicts = pgTable('sync_conflicts', {
  id:            uuid('id').primaryKey().defaultRandom(),
  universeId:    uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  tableName:     text('table_name').notNull(),
  // D-03: the ledger records MERGE keys, and the merge's key space is not the
  rowId:         text('row_id').notNull(),
  winner:        text('winner').notNull(),                     // 'local' | 'remote'
  loserPayload:  jsonb('loser_payload').notNull(),
  resolvedAt:    timestamp('resolved_at', { withTimezone: true }),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
