import { pgTable, uuid, text, timestamp, jsonb, boolean, integer, doublePrecision, primaryKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * Phase 20 D-01: per-universe horizontal timeline window persisted as JSONB
 * on `universes.timeline_window`. `null` (the default for any pre-Phase-20
 * row) triggers the first-visit "Configure range" dialog (D-02).
 */
export interface TimelineWindow {
  start: number;
  end: number;
}

export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        text('email').notNull().unique(),
  displayName:  text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
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
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
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

export const issues = pgTable('issues', {
  id:          uuid('id').primaryKey().defaultRandom(),
  universeId:  uuid('universe_id').references(() => universes.id, { onDelete: 'cascade' }).notNull(),
  title:       text('title').notNull(),
  description: text('description').default('').notNull(),
  severity:    text('severity').default('minor').notNull(),
  resolved:    boolean('resolved').default(false).notNull(),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
  updatedAt:   timestamp('updated_at').defaultNow().notNull(),
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
